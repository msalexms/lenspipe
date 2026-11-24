import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const pages = resolve(__dirname, 'pages');

export default defineConfig({
  // One HTML entry per page (pages/*.html); they build to dist/<page>.html, served at /<page>.
  root: pages,
  publicDir: resolve(__dirname, 'public'),
  // The camera capture worker is loaded with `{ type: 'module' }` (supported by iOS Safari 15+).
  worker: { format: 'es' },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        sender: resolve(pages, 'sender.html'),
        control: resolve(pages, 'control.html'),
        obs: resolve(pages, 'obs.html'),
        diag: resolve(pages, 'diag.html'),
      },
    },
  },
});
