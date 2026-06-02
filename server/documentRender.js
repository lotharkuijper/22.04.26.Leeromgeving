// Server-side documentconversie voor de in-app documentviewer (Task #209).
// LibreOffice (headless) converteert .docx/.pptx → PDF zodat één pdf.js-viewer
// alle formaten kan tonen. Conversies worden geserialiseerd: één soffice-proces
// tegelijk, elk met een eigen UserInstallation-profiel zodat ze elkaar niet
// in de weg zitten.

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SOFFICE_BIN = process.env.SOFFICE_BIN || 'soffice';
const CONVERSION_TIMEOUT_MS = 90_000;

// Extensies die we via LibreOffice naar PDF converteren voor weergave.
export const CONVERT_TO_PDF_EXT = new Set(['docx', 'doc', 'pptx', 'ppt', 'odt', 'odp']);
// Extensies die rechtstreeks (zonder conversie) als PDF te tonen zijn.
export const NATIVE_PDF_EXT = new Set(['pdf']);
// Platte-tekst extensies die als tekst in de viewer komen.
export const TEXT_EXT = new Set(['txt', 'md']);

export function extIsViewable(ext) {
  const e = String(ext || '').toLowerCase().replace(/^\./, '');
  return CONVERT_TO_PDF_EXT.has(e) || NATIVE_PDF_EXT.has(e) || TEXT_EXT.has(e);
}

export function normalizeExt(ext) {
  return String(ext || '').toLowerCase().replace(/^\./, '');
}

// Serialiseer conversies via een promise-keten zodat er nooit twee
// soffice-processen tegelijk draaien (geheugen/stabiliteit).
let conversionChain = Promise.resolve();
export function queueConversion(fn) {
  const run = conversionChain.then(fn, fn);
  conversionChain = run.then(() => {}, () => {});
  return run;
}

function runSoffice(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(SOFFICE_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('LibreOffice-conversie duurde te lang (time-out).'));
    }, CONVERSION_TIMEOUT_MS);
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`LibreOffice kon niet worden gestart: ${err.message}`));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`LibreOffice-conversie mislukte (code ${code}). ${stderr.slice(0, 500)}`));
    });
  });
}

// Converteer een Office-document (buffer) naar een PDF-buffer.
// `ext` is de bronextensie (zonder punt), bv. 'pptx'.
export async function convertOfficeToPdf(inputBuffer, ext) {
  const e = normalizeExt(ext);
  if (!CONVERT_TO_PDF_EXT.has(e)) {
    throw new Error(`Conversie naar PDF wordt niet ondersteund voor .${e}`);
  }
  const workDir = await mkdtemp(path.join(tmpdir(), 'leapvu-render-'));
  const profileDir = await mkdtemp(path.join(tmpdir(), 'leapvu-loprofile-'));
  const inputPath = path.join(workDir, `input.${e}`);
  try {
    await writeFile(inputPath, inputBuffer);
    await runSoffice([
      '--headless',
      '--norestore',
      '--nolockcheck',
      `-env:UserInstallation=file://${profileDir}`,
      '--convert-to', 'pdf',
      '--outdir', workDir,
      inputPath,
    ]);
    const outPath = path.join(workDir, 'input.pdf');
    return await readFile(outPath);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}
