/**
 * Just enough XML to read what Mapper writes.
 *
 * `DOMParser` would do this in a browser and there is none in Node, which is where the
 * import pipeline runs — so the obvious shape is "DOMParser here, something else there".
 * That is two parsers over one subset, and the day they disagree a bundle imported on a
 * laptop and one imported in the browser stop having the same content hash, which is the
 * one thing the hash is for. So: one tokenizer, no branch, and if a browser DOM is ever
 * wanted it plugs in behind `XmlNode` rather than beside it.
 *
 * The subset is what Mapper actually emits: a declaration, elements, attributes in double
 * quotes, self-closing tags, comments, CDATA, and the five named entities plus numeric
 * ones. No DTDs, no namespaces beyond stripping a prefix, no entity definitions. Anything
 * else throws rather than being guessed at.
 */
export interface XmlNode {
  /** Local name: any namespace prefix is dropped, since this format uses exactly one. */
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly XmlNode[];
  /** Concatenated text content, entities resolved. Empty for the elements read here. */
  readonly text: string;
}

interface Building {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

export function unescapeXml(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

const NAME = /[^\s/>]+/y;
const ATTR = /\s*([^\s=/>]+)\s*=\s*"([^"]*)"/y;

export function parseXml(text: string): XmlNode {
  const stack: Building[] = [];
  let root: XmlNode | null = null;
  let i = 0;

  const finish = (node: Building) => {
    const done: XmlNode = {
      name: node.name,
      attrs: node.attrs,
      children: node.children,
      text: node.text,
    };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(done);
    else root = done;
  };

  while (i < text.length) {
    const open = text.indexOf('<', i);
    if (open < 0) break;
    if (open > i) {
      const between = text.slice(i, open);
      const parent = stack[stack.length - 1];
      // Whitespace between elements is layout, not content.
      if (parent && between.trim().length > 0) parent.text += unescapeXml(between);
    }

    if (text.startsWith('<!--', open)) {
      const end = text.indexOf('-->', open);
      if (end < 0) throw new Error('xml: unterminated comment');
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', open)) {
      const end = text.indexOf(']]>', open);
      if (end < 0) throw new Error('xml: unterminated CDATA');
      const parent = stack[stack.length - 1];
      if (parent) parent.text += text.slice(open + 9, end);
      i = end + 3;
      continue;
    }
    if (text.startsWith('<?', open) || text.startsWith('<!', open)) {
      // Declaration or doctype. Neither carries anything a map needs.
      const end = text.indexOf('>', open);
      if (end < 0) throw new Error('xml: unterminated declaration');
      i = end + 1;
      continue;
    }

    if (text.startsWith('</', open)) {
      const end = text.indexOf('>', open);
      if (end < 0) throw new Error('xml: unterminated closing tag');
      const node = stack.pop();
      if (!node) throw new Error(`xml: closing tag with nothing open at ${open}`);
      finish(node);
      i = end + 1;
      continue;
    }

    NAME.lastIndex = open + 1;
    const nameMatch = NAME.exec(text);
    if (!nameMatch) throw new Error(`xml: no element name at ${open}`);
    const raw = nameMatch[0];
    const node: Building = {
      name: raw.slice(raw.indexOf(':') + 1),
      attrs: {},
      children: [],
      text: '',
    };

    i = NAME.lastIndex;
    for (;;) {
      ATTR.lastIndex = i;
      const attr = ATTR.exec(text);
      if (!attr) break;
      node.attrs[attr[1]!] = unescapeXml(attr[2]!);
      i = ATTR.lastIndex;
    }

    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (text[i] === '/') {
      if (text[i + 1] !== '>') throw new Error(`xml: malformed empty element at ${open}`);
      finish(node);
      i += 2;
      continue;
    }
    if (text[i] !== '>') throw new Error(`xml: malformed tag at ${open}`);
    stack.push(node);
    i++;
  }

  if (stack.length > 0) throw new Error(`xml: ${stack.length} element(s) left open`);
  if (!root) throw new Error('xml: no root element');
  return root;
}

/** Every descendant with this name, in document order. */
export function findAll(node: XmlNode, name: string, into: XmlNode[] = []): XmlNode[] {
  for (const child of node.children) {
    if (child.name === name) into.push(child);
    findAll(child, name, into);
  }
  return into;
}

/**
 * Every element named `name` whose **parent** is named `parent`.
 *
 * The distinction is load-bearing here rather than fussy. Mapper nests a whole `<symbol>`
 * inside a line symbol for its start, mid and end decorations, and nests `<object>`s
 * inside those to draw them — so "every `<object>` in the file" is 673 things of which 539
 * are on the map and 134 are pictures of symbols. Asking for objects whose parent is
 * `<objects>` gets the map.
 */
export function childrenOf(root: XmlNode, parent: string, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (node: XmlNode) => {
    for (const child of node.children) {
      if (node.name === parent && child.name === name) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

export const attrNumber = (node: XmlNode, name: string, fallback = 0): number => {
  const raw = node.attrs[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};
