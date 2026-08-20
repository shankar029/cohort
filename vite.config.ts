import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const port = Number(process.env.ATEAM_PORT ?? 4319);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
  server: {
    port: 5319,
    proxy: {
      '/api': `http://localhost:${port}`,
      '/ws': { target: `ws://localhost:${port}`, ws: true },
    },
  },
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
  },
});
