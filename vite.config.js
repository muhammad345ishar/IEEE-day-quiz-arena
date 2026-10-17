import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: { '/api': 'http://127.0.0.1:3000', '/socket.io': { target: 'http://127.0.0.1:3000', ws: true } } },
  build: { outDir: 'dist' },
});
