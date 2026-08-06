import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies /api to the backend (port 3000) so the SPA and the API
// are same-origin in the browser — the httpOnly tg_session cookie set by the
// backend is therefore sent automatically on every request (credentials:
// 'include' is still used explicitly in api.ts for clarity).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
