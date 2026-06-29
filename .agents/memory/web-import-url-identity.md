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
- **DNS-rebind SSRF must be closed at connect time, not pre-fetch (separate from identity).** A resolve-then-fetch guard is a TOCTOU hole: `fetch()` re-resolves independently and can land on a private IP after the check passed. The durable fix is to *pin* the connection — validate every resolved IP and dial the **same** vetted address (an undici dispatcher with a custom connect-time `lookup`), so the IP you check is the IP you dial. Two non-obvious couplings that must BOTH hold, else there's a bypass:
  - **IP-literal hosts skip the connect-time lookup** (the socket dials the literal directly), so the synchronous name-level host check must independently reject literals. Keep both layers; the DNS pre-check stays only as a friendly early bail-out.
  - **The "is this IP safe" classifier must mean *globally-routable*, not merely *not-RFC1918*.** Also block CGNAT (100.64/10), TEST-NET/benchmark/IETF-protocol ranges, multicast, NAT64 (64:ff9b), 6to4 (2002::/16), site-local — and decode IPv4-mapped IPv6 in **both** dotted (`::ffff:a.b.c.d`) AND hex (`::ffff:7f00:1`) form. **Why hex matters:** `new URL()` canonicalizes the dotted mapped form to hex, so a dotted-only check is effectively dead for URL inputs and lets `::ffff:7f00:1` (=127.0.0.1) slip through. Tightening a *block* classifier only ever blocks more, so it can't false-positive a real public site.
