import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import electron from 'vite-plugin-electron/simple';
import { fileURLToPath, URL } from 'node:url';

// Separate config so npm run build still produces the Chrome extension.
export default defineConfig({
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    electron({
      main: { entry: 'electron/main.js' },
      preload: { input: 'electron/preload.js' },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist-desktop',
    emptyOutDir: true,
  },
});
