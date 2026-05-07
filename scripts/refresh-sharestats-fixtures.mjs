#!/usr/bin/env node
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, '..', 'src/services/__tests__/fixtures/sharestats');

const OWNER = process.env.SHARESTATS_OWNER || 'ShareStats';
const REPO = process.env.SHARESTATS_REPO || 'itembank';
const BRANCH = process.env.SHARESTATS_BRANCH || 'main';

const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has('--check');
const VERBOSE = args.has('--verbose');

function log(...parts) {
  console.log(...parts);
}

async function fetchJson(url) {
  const headers = { 'User-Agent': 'refresh-sharestats-fixtures' };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GitHub-aanroep mislukt (${res.status} ${res.statusText}): ${url}`);
  }
  return res.json();
}

async function fetchText(url) {
  const headers = { 'User-Agent': 'refresh-sharestats-fixtures' };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Download mislukt (${res.status} ${res.statusText}): ${url}`);
  }
  return res.text();
}

function gitBlobSha(content) {
  const buf = Buffer.from(content, 'utf8');
  const header = Buffer.from(`blob ${buf.length}\0`);
  return createHash('sha1').update(Buffer.concat([header, buf])).digest('hex');
}

async function loadRepoTree() {
  const branchInfo = await fetchJson(
    `https://api.github.com/repos/${OWNER}/${REPO}/branches/${BRANCH}`,
  );
  const treeSha = branchInfo?.commit?.commit?.tree?.sha;
  if (!treeSha) throw new Error('Kon branch-tree-SHA niet bepalen.');
  const tree = await fetchJson(
    `https://api.github.com/repos/${OWNER}/${REPO}/git/trees/${treeSha}?recursive=1`,
  );
  if (tree.truncated) {
    log('⚠️  GitHub-tree is afgekapt; sommige fixtures worden mogelijk niet gevonden.');
  }
  const map = new Map();
  for (const entry of tree.tree || []) {
    if (entry.type !== 'blob' || !entry.path.endsWith('.Rmd')) continue;
    const base = entry.path.split('/').pop();
    if (!map.has(base)) {
      map.set(base, { path: entry.path, sha: entry.sha });
    } else {
      const existing = map.get(base);
      if (Array.isArray(existing.duplicates)) existing.duplicates.push(entry.path);
      else existing.duplicates = [entry.path];
    }
  }
  return map;
}

async function listFixtures() {
  const entries = await readdir(FIXTURES_DIR);
  return entries.filter((name) => name.endsWith('.Rmd')).sort();
}

async function main() {
  log(`📦 Fixtures-map: ${relative(process.cwd(), FIXTURES_DIR)}`);
  log(`🔗 Repo: ${OWNER}/${REPO}@${BRANCH}`);
  log(CHECK_ONLY ? '🔍 Modus: alleen controleren (geen schrijven)' : '✏️  Modus: bijwerken');

  const [tree, fixtures] = await Promise.all([loadRepoTree(), listFixtures()]);
  log(`📚 ${fixtures.length} fixtures gevonden, ${tree.size} .Rmd-bestanden in repo.`);

  let changed = 0;
  let missing = 0;
  let unchanged = 0;
  const ambiguous = [];

  for (const name of fixtures) {
    const hit = tree.get(name);
    if (!hit) {
      missing += 1;
      log(`❌ Niet gevonden in repo: ${name}`);
      continue;
    }
    if (hit.duplicates) {
      ambiguous.push({ name, paths: [hit.path, ...hit.duplicates] });
    }
    const localPath = join(FIXTURES_DIR, name);
    const localContent = await readFile(localPath, 'utf8');
    const localSha = gitBlobSha(localContent);
    if (localSha === hit.sha) {
      unchanged += 1;
      if (VERBOSE) log(`✓ Ongewijzigd: ${name} (${hit.path})`);
      continue;
    }
    const rawUrl = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${hit.path}`;
    const remoteContent = await fetchText(rawUrl);
    const remoteSha = gitBlobSha(remoteContent);
    if (remoteSha !== hit.sha) {
      log(`⚠️  SHA-mismatch na download voor ${name} (verwacht ${hit.sha}, kreeg ${remoteSha})`);
    }
    changed += 1;
    log(`Δ Verschil: ${name} (${hit.path})`);
    log(`   lokaal blob ${localSha} → remote blob ${hit.sha}`);
    if (CHECK_ONLY) continue;
    await writeFile(localPath, remoteContent, 'utf8');
    log(`   → bijgewerkt`);
  }

  if (ambiguous.length) {
    log('');
    log('⚠️  Meerdere paden gevonden voor:');
    for (const item of ambiguous) {
      log(`   ${item.name}:`);
      for (const p of item.paths) log(`     - ${p}`);
    }
    log('   Eerste pad is gebruikt; controleer of dat de juiste is.');
  }

  log('');
  log(`Samenvatting: ${unchanged} ongewijzigd, ${changed} ${CHECK_ONLY ? 'verschillen' : 'bijgewerkt'}, ${missing} ontbrekend.`);

  if (CHECK_ONLY && (changed > 0 || missing > 0)) {
    process.exitCode = 1;
  } else if (missing > 0) {
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error('Fout tijdens vernieuwen:', err);
  process.exit(1);
});
