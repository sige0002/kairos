import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Console v2 dev server. It proxies /api to the api_orchestrator and
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
      // topic_probe (OL-3.3): same-origin /probe -> the probe service, mirroring
      // the served build's nginx /probe/ proxy. The trailing slash is stripped.
      '/probe': {
        target: process.env.TOPIC_PROBE_URL ?? 'http://localhost:8003',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/probe/, ''),
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
});
