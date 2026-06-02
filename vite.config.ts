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
    // pdfjs-dist buiten de dep-optimizer houden: het pre-bundelen van de
    // pdf.worker (?url) liet Vite midden in de sessie opnieuw optimaliseren,
    // wat de module-graph invalideerde ("Failed to fetch dynamically imported
    // module" + dubbele React → "Invalid hook call"-crash).
    exclude: ['lucide-react', 'pdfjs-dist'],
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
