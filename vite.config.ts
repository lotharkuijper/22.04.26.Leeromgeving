/// <reference types="vitest/config" />
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
    // Zware deps die ALLEEN achter lazy routes (React.lazy) zitten — de
    // markdown/KaTeX-stack in MarkdownMessage en de Tiptap-editor + mammoth.
    // Zonder deze include ontdekt Vite ze pas bij het eerste bezoek aan zo'n
    // route en her-optimaliseert dan midden in de sessie. Dat geeft exact
    // dezelfde crash als hierboven (stale chunk-URL's → "Failed to fetch
    // dynamically imported module" + dubbele React → "Invalid hook call").
    // Vooraf bundelen bij serverstart voorkomt de mid-sessie her-optimalisatie.
    include: [
      'react-markdown',
      'remark-gfm',
      'remark-math',
      'rehype-katex',
      'katex',
      '@tiptap/react',
      '@tiptap/starter-kit',
      'tiptap-markdown',
      'mammoth',
    ],
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
  test: {
    // Standaard de node-omgeving (server-tests); component-tests kiezen zelf
    // jsdom via een `// @vitest-environment jsdom`-docblock bovenaan het bestand.
    environment: 'node',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
});
