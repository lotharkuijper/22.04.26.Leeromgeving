---
name: Web-import URL identity
description: The single normalizeUrl in server/webImport.js is the page identity for discovery, import file_path, fetch URL, and redirect scope — stripping query/fragment collapses distinct pages and a re-import empties the prior page's chunks.
---

# Web-import URL identity

One `normalizeUrl` (exported from `server/webImport.js`, aliased `normalizeWebUrl` in `server/index.js`) is the **single source of page identity** across the whole web-import flow:
- discovery dedup key (sitemap `.map` + BFS `extractLinks`),
- import dedup (`seen`) + the `documents.file_path` row key,
- the actual fetch URL,
- redirect `finalUrl` scope check.

**Rule:** that normalized string must preserve everything that makes two pages *different pages*. Preserve meaningful query and route-like hash (`#/…`, `#!…`); strip only tracking params + plain `#anchors`; sort query keys for stable identity.

**Why:** web pages are stored as a `documents` row keyed by `(folder_id, file_path, file_type='web')` plus `document_chunks`; re-importing the same `file_path` **deletes that doc's chunks and re-inserts**. If `normalizeUrl` strips `?query`/`#fragment`, two genuinely different pages (`view?id=1` vs `view?id=2`, or hash-routed `#/h1` vs `#/h2`) collapse onto one `file_path`, so importing the second **empties the first's chunks**. (Root cause of the "importing one page empties another" bug.)

**How to apply:**
- Scope (`sameWebEnvironment`/`dirPrefix`) and SSRF (`isBlockedHost`) read only `.hostname`/`.pathname`, so preserving query/fragment in the URL string does NOT weaken them — safe.
- `sameWebEnvironment` needs a same-path allowance (`cand.pathname === base.pathname → true`, after the binary/non-page reject, before `dirPrefix`) or an extensionless base like `/view` rejects its own `?query` variants (`dirPrefix('/view')` → `/view/`).
- Build sitemap candidates from a search/hash-cleared base, else `start + '/'` yields `/view?id=2/`.
- Fragments are never sent over HTTP, so two fragment-only-different URLs fetch identical HTML — preserving the fragment prevents overwrite but can store duplicate SPA-shell content.
