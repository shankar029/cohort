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
      '/api': {
        target: `http://localhost:${port}`,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('error', (err) => {
            // Backend not up yet or mid-restart; don't crash the dev server.
            process.stderr.write(`[vite proxy] /api error: ${err.message}\n`);
          });
        },
      },
      '/ws': {
        target: `ws://localhost:${port}`,
        ws: true,
        configure: (proxy) => {
          proxy.on('error', (err) => {
            process.stderr.write(`[vite proxy] /ws error: ${err.message}\n`);
          });
          // Swallow abrupt client/backend socket teardowns (ECONNABORTED/RESET).
          proxy.on('proxyReqWs', (_proxyReq, _req, socket) => {
            socket.on('error', () => undefined);
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
  },
});
