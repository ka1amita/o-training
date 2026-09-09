// Publishes dist/ to the gh-pages branch.
//
//   npm run deploy
//
// The manual escape hatch. The normal deploy is .github/workflows/ci.yml, which does the
// same push from CI once typecheck, tests and the build are green — this one skips all
// three, so reach for it only when Actions is unavailable.
//
// The build is a disposable artifact, so the branch is force-pushed and holds one commit.
// Nothing but dist/ ever lives there; source stays on main.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BRANCH = 'gh-pages';
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit', encoding: 'utf8' });
const capture = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();

const remote = capture('git', ['remote', 'get-url', 'origin']);
const sha = capture('git', ['rev-parse', '--short', 'HEAD']);

const staging = join(tmpdir(), `o-training-pages-${Date.now()}`);
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
cpSync('dist', staging, { recursive: true });

// Without this, Pages runs the output through Jekyll, which silently drops any file or
// directory whose name begins with an underscore.
writeFileSync(join(staging, '.nojekyll'), '');

run('git', ['init', '-q', '-b', BRANCH], staging);
run('git', ['add', '-A'], staging);
run('git', ['-c', 'user.name=deploy', '-c', 'user.email=deploy@localhost',
  'commit', '-q', '-m', `deploy ${sha}`], staging);
run('git', ['push', '-q', '--force', remote, `${BRANCH}:${BRANCH}`], staging);

rmSync(staging, { recursive: true, force: true });
console.log(`pushed dist/ (${sha}) to ${BRANCH}`);
