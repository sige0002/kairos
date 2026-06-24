import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Stage 0 skeleton. The dev server proxies /api to the api_orchestrator so the
// frontend can fetch GET /api/v1/config without CORS during development.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.API_ORCH_URL ?? 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
});
