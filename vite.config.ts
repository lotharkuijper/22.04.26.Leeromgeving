import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

function noCache(): Plugin {
  return {
    name: 'no-cache',
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        delete _req.headers['if-none-match'];
        delete _req.headers['if-modified-since'];
        res.setHeader('Cache-Control', 'no-store');
        next();
      });
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), noCache()],
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
  server: {
    host: '0.0.0.0',
    port: 5000,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
