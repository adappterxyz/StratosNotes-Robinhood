import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API (services/api) is proxied in dev so the app and API share an origin, as in production behind one host.
// VITE_BASE=/app/ for the Cloudflare Worker build (landing at /, the app under /app/); `/` in local dev.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY ?? 'http://127.0.0.1:8787',
        changeOrigin: (process.env.VITE_API_PROXY ?? '').startsWith('https:'),
      },
    },
  },
  preview: {
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY ?? 'http://127.0.0.1:8787',
        changeOrigin: (process.env.VITE_API_PROXY ?? '').startsWith('https:'),
      },
    },
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
});
