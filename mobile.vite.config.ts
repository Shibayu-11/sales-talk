import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Standalone PWA recorder build (Track B mobile entry point).
 * Separate from the Electron app's electron-vite build. Deploy the dist/ output
 * to any static host (e.g. Cloudflare Pages); it talks to the Worker over HTTPS.
 */
export default defineConfig({
  root: resolve(__dirname, 'src/mobile'),
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist/mobile'),
    emptyOutDir: true,
    target: 'es2022',
  },
  server: {
    host: true, // expose on LAN so a phone can reach `npm run mobile:dev`
    port: 5180,
  },
});
