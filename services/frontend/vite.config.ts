import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Stage 0 skeleton. The dev server proxies /api to the api_orchestrator and
// /webrtc to the webrtc_streamer so the frontend can fetch GET /api/v1/config
// and run camera signaling without CORS during development — mirroring the
// served build's nginx reverse proxy (services/frontend/nginx.conf).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.API_ORCH_URL ?? 'http://localhost:8000',
        changeOrigin: true,
      },
      '/webrtc': {
        target: process.env.WEBRTC_URL ?? 'http://localhost:8002',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/webrtc/, ''),
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
});
