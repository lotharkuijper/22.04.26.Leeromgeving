---
name: Web-import URL identity
description: In web-import, the normalized URL string IS the page identity (it becomes documents.file_path); stripping query/fragment collapses distinct pages so a re-import deletes the prior page's chunks.
---

# Web-import URL identity

**Rule:** the normalized web URL is the *identity* of a page, not just a fetch convenience — the same normalizer feeds discovery dedup, the stored `documents.file_path` key, the fetch URL, and the redirect scope check. So it must preserve everything that makes two pages *different pages* (meaningful `?query`, route-like `#/…` hash), and strip only non-identity noise (tracking params, plain `#anchors`).

**Why:** a web page is one `documents` row keyed by `(folder_id, file_path, file_type='web')` plus its `document_chunks`; re-importing the same `file_path` deletes that doc's chunks and re-inserts. If the normalizer flattens `?query`/`#fragment`, genuinely different pages (`view?id=1` vs `view?id=2`) share one `file_path`, so importing the second silently empties the first's chunks. This was the root cause of the "importing one page empties another" bug.

**How to apply (the non-obvious couplings):**
- Scope (`sameWebEnvironment`) and SSRF (`isBlockedHost`) read only host/pathname, so preserving query/fragment is safe — but an extensionless base (`/view`) needs a same-path allowance, else its own `?query` variants fall out of scope.
- Fragments are never sent over HTTP: two fragment-only-different URLs fetch identical HTML, so preserving the fragment prevents overwrite but can store duplicate SPA-shell content.
- **Identity must prefer over-split over merge.** The query canonicalizer (`TRACKING_PARAM_RE`) may strip ONLY *unambiguous* trackers (`utm_*`, `fbclid`/`gclid`/click-ids, `ref_src`/`ref_url`, Mailchimp `mc_*`). A bare `ref` is real content on some sites (`?ref=hoofdstuk2`), so stripping it would merge `?ref=a` and `?ref=b` into one `file_path` and let one page wipe the other's chunks. Over-splitting only risks a harmless duplicate document; merging risks silent data loss. Param *order*, by contrast, is safely sorted/canonicalized (reordered params = same page).
- **Residual SSRF caveat (separate from identity):** the DNS-rebind guard resolves the host then fetches — the resolved IP is not pinned to the actual `fetch()` socket, so a TOCTOU rebind is still theoretically possible. Closing it needs IP-pinning at the socket/agent layer or network-level egress blocking; out of scope for the page-identity work.
