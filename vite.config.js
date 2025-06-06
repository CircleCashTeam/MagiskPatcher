import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          material: ['@material/web/all.js'],
          xterm: ['@xterm/xterm'],
        },
      },
    },
    assetsInclude: ['**/*.ttf', '**/*.woff', '**/*.woff2'],
  },
  base: '/MagiskPatcher/'
});