import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

// Vangnet voor Task #369/#370: pdfjs-dist v5 levert de worker uitsluitend als
// ES-module (`pdf.worker.min.mjs`). De oude cdnjs `pdf.worker.min.js`-URL bestaat
// niet meer voor v5, waardoor het dynamisch laden van de worker faalde
// ("Setting up fake worker failed") en PDF-uploads + documentweergave braken.
// Deze test bewaakt dat élke pdf.js-gebruiker de lokaal gebundelde `.mjs`-worker
// via Vite `?url` laadt en NOOIT terugvalt op een CDN/http(s)- of `.js`-worker.

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '..');

// Beide huidige pdf.js-gebruikers: het upload-/ingestiepad en de in-app viewer.
const PDFJS_USERS = [
  'services/document-processor.service.ts',
  'components/DocumentViewer.tsx',
];

function readUser(relPath: string): string {
  return readFileSync(resolve(srcRoot, relPath), 'utf8');
}

// Verwijder commentaar zodat de negatieve checks niet afgaan op de toelichtende
// comments die de OUDE (kapotte) cdnjs `.js`-worker-URL bewust beschrijven.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('pdf.js worker-configuratie (regressievangnet)', () => {
  for (const relPath of PDFJS_USERS) {
    describe(relPath, () => {
      const source = readUser(relPath);
      const code = stripComments(source);

      it('importeert de gebundelde worker als .mjs via Vite ?url', () => {
        expect(source).toMatch(
          /import\s+\w+\s+from\s+['"]pdfjs-dist\/build\/pdf\.worker\.min\.mjs\?url['"]/,
        );
      });

      it('zet GlobalWorkerOptions.workerSrc op de geïmporteerde worker-URL', () => {
        const assignment = code.match(
          /GlobalWorkerOptions\.workerSrc\s*=\s*([^\n;]+)/,
        );
        expect(assignment).not.toBeNull();
        const rhs = assignment![1].trim();
        // De rechterkant moet een identifier zijn (de ?url-import), geen letterlijke
        // string-URL.
        expect(rhs).toMatch(/^[A-Za-z_$][\w$]*$/);
      });

      it('zet workerSrc niet op een CDN/http(s)-URL', () => {
        const workerSrcAssignments = code.match(
          /workerSrc\s*=\s*['"][^'"]*['"]/g,
        );
        expect(workerSrcAssignments).toBeNull();
        // Extra zekerheid: geen enkele http(s)-/cdn-verwijzing rond pdf-worker.
        expect(code).not.toMatch(/https?:\/\/[^\s'"]*pdf\.worker/i);
        expect(code).not.toMatch(/cdnjs|unpkg|jsdelivr/i);
      });

      it('verwijst niet naar de oude .js-worker (alleen .mjs is geldig in v5)', () => {
        expect(code).not.toMatch(/pdf\.worker(\.min)?\.js\b/);
      });
    });
  }
});
