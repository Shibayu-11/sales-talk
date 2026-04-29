import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@main': resolve('src/main'),
        '@shared': resolve('src/shared'),
      },
    },
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') },
    },
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: {
          overlay: resolve('src/preload/overlay.ts'),
          control: resolve('src/preload/control.ts'),
        },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer'),
        '@shared': resolve('src/shared'),
      },
    },
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: {
          overlay: resolve('src/renderer/overlay/index.html'),
          control: resolve('src/renderer/control/index.html'),
        },
      },
    },
  },
});
