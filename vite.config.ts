import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const port = Number(process.env.ATEAM_PORT ?? 4319);

// Vite proxies the app WebSocket (/ws) to the backend. On Windows, an abrupt
// socket teardown (backend restart via tsx watch, browser reload) surfaces as
// `write ECONNABORTED` on a proxy socket that has no error listener, which
// crashes the whole dev server (exit 0xC0000409 / 3221226505). Swallow these
// known-benign network races so `npm run dev` stays up.
const BENIGN = new Set(['ECONNABORTED', 'ECONNRESET', 'EPIPE', 'ERR_STREAM_WRITE_AFTER_END']);
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err && BENIGN.has(err.code ?? '')) {
    process.stderr.write(`[vite proxy] ignored socket error: ${err.code}\n`);
    return;
  }
  throw err;
});

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
          // Attach error listeners to BOTH sides of the WS tunnel so an abrupt
          // teardown never bubbles up as an uncaught exception.
          proxy.on('proxyReqWs', (_proxyReq, _req, socket) => {
            socket.on('error', () => undefined);
          });
          // 'open' (target socket ready) isn't in Vite's proxy typings; reach it
          // via the underlying EventEmitter to attach a target-side error guard.
          (proxy as unknown as import('node:events').EventEmitter).on(
            'open',
            (proxySocket: import('node:net').Socket) => {
              proxySocket.on('error', () => undefined);
            },
          );
          proxy.on('econnreset', () => undefined);
        },
      },
    },
  },
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
  },
});
