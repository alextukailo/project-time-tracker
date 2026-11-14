import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
  rolldownOptions: {
    input: {
      popup: fileURLToPath(
        new URL('./index.html', import.meta.url)
      ),

      background: fileURLToPath(
        new URL('./src/background.js', import.meta.url)
      ),
    },

    output: {
      entryFileNames: (chunk) => {
        if (chunk.name === 'background') {
          return 'background.js';
        }

        return 'assets/[name]-[hash].js';
      },
    },
  },
},
});
