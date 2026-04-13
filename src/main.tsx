import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

const originalWarn = console.warn;
console.warn = (...args) => {
  if (String(args[0]).includes('Could not add aborted')) return;
  if (String(args[0]).includes('no active span')) return;
  originalWarn(...args);
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
