import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';

// `base` matters for GitHub Pages project sites, where the app is served from
// /<repo>/ rather than /. Set BASE_PATH at build time; the default suits a user site
// and `vite dev`.
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      // Everything the drills need is generated on the device, so the precache is
      // the hashed bundle and nothing else. That is what makes a cold offline
      // launch work, and it is small enough that "stale forever" reduces to "one
      // reload behind" — which autoUpdate then closes.
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        cleanupOutdatedCaches: true,
      },
      manifest: {
        name: 'OB Training',
        short_name: 'OB Training',
        description: 'Off-forest orienteering drills: symbols, map memory, relief.',
        theme_color: '#1c1917',
        background_color: '#1c1917',
        display: 'standalone',
        orientation: 'any',
        start_url: base,
        scope: base,
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
});
