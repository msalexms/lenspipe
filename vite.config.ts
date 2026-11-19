import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  // The camera capture worker is loaded with `{ type: 'module' }` (supported by iOS Safari 15+).
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        home: resolve(__dirname, 'index.html'),
        sender: resolve(__dirname, 'sender.html'),
        control: resolve(__dirname, 'control.html'),
        obs: resolve(__dirname, 'obs.html'),
        diag: resolve(__dirname, 'diag.html'),
      },
    },
  },
});
