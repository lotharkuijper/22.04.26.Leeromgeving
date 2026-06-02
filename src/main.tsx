import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import 'katex/dist/katex.min.css';

const originalWarn = console.warn;
console.warn = (...args) => {
  if (String(args[0]).includes('Could not add aborted')) return;
  if (String(args[0]).includes('no active span')) return;
  originalWarn(...args);
};

// Globale vangnet voor onafgehandelde async fouten die GEEN echt Error-object
// zijn. Voorbeelden: pdf.js' BaseException (prototype = new Error()), Supabase
// error-objecten ({message, code, …} zonder Error-prototype), of een
// `throw <niet-Error>` / `Promise.reject(<niet-Error>)`. Zulke waarden laten de
// Replit-preview-overlay crashen met "the error was not an error object" en
// geven geen bruikbare stacktrace. We loggen daarom altijd VOLLEDIGE diagnostiek
// (type, toString-tag, constructor, name, message, code, keys, stack) zodat de
// echte oorzaak vindbaar is, en proberen daarna de crash te onderdrukken. ECHTE
// Error-objecten ("[object Error]") laten we ongemoeid: die horen zichtbaar te
// blijven met hun stacktrace.
const isRealErrorObject = (value: unknown): boolean =>
  Object.prototype.toString.call(value) === '[object Error]';

const describeNonError = (value: unknown): string => {
  try {
    if (value === undefined) return 'value=undefined';
    if (value === null) return 'value=null';
    const v = value as Record<string, unknown>;
    const info: Record<string, unknown> = {
      type: typeof value,
      tag: Object.prototype.toString.call(value),
      ctor: (v?.constructor as { name?: string } | undefined)?.name,
      name: typeof v?.name === 'string' ? v.name : undefined,
      message: typeof v?.message === 'string' ? v.message : undefined,
      code: v?.code,
      status: v?.status,
      details: typeof v?.details === 'string' ? v.details : undefined,
    };
    if (typeof value === 'object') {
      try { info.keys = Object.keys(value as object).slice(0, 25); } catch { /* ignore */ }
    } else {
      info.value = String(value).slice(0, 300);
    }
    if (typeof v?.stack === 'string') info.stack = v.stack.slice(0, 1000);
    return JSON.stringify(info);
  } catch (e) {
    return `describeNonError faalde: ${String(e)}`;
  }
};

window.addEventListener('unhandledrejection', (event) => {
  if (isRealErrorObject(event.reason)) return;
  console.error('[async-guard] non-Error rejection onderdrukt →', describeNonError(event.reason));
  event.preventDefault();
  event.stopImmediatePropagation?.();
}, true);

window.addEventListener('error', (event) => {
  // Resource-load fouten (img/script/link) hebben een element-target en geen
  // bruikbare error — die negeren we volledig.
  if (event.target && event.target !== window) return;
  if (isRealErrorObject(event.error)) return;
  console.error('[async-guard] non-Error error onderdrukt →', describeNonError(event.error ?? event.message));
  event.preventDefault();
  event.stopImmediatePropagation?.();
}, true);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
