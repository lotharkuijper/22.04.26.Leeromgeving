/*
  # Bron-document vertaal-cache (translate-on-demand leesvenster)

  ## Overzicht
  Cachet machinevertalingen van reeds-geëxtraheerde bron-tekst per
  (document, eenheid, doeltaal, bron-hash). Zo betaalt de tool een dia/pagina
  maar één keer per taal en krijgen volgende lezers de vertaling direct.

  ## Tabel `document_translations`
  - `id` (uuid, pk)
  - `document_id` (uuid, fk documents ON DELETE CASCADE) — de bron
  - `page_key` (text) — vertaalde eenheid: 'full' | 'p:<n>' (pagina/dia) | 'text:<n>'
  - `target_lang` (text) — doeltaalcode (allowlist server-side)
  - `source_hash` (text) — SHA-256 van de genormaliseerde bron-tekst; verandert
    de bron, dan invalideert de cache vanzelf
  - `translated_text` (text) — de machinevertaling
  - `created_at` (timestamptz)

  ## Beveiliging
  Deze tabel bevat VERTAALDE BRON-TEKST (cursusmateriaal). Daarom is er bewust
  GEEN client-leesbeleid: alleen de service-role (server) leest en schrijft.
  De client krijgt vertalingen uitsluitend via POST /api/rag/documents/:id/
  translate, dat exact dezelfde toegangscontrole als /view afdwingt.
*/

CREATE TABLE IF NOT EXISTS document_translations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_key text NOT NULL,
  target_lang text NOT NULL,
  source_hash text NOT NULL,
  translated_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, page_key, target_lang, source_hash)
);

CREATE INDEX IF NOT EXISTS idx_document_translations_lookup
  ON document_translations (document_id, page_key, target_lang);

ALTER TABLE document_translations ENABLE ROW LEVEL SECURITY;

-- Bewust geen SELECT/INSERT/UPDATE-policy: de service-role (server) bypasst
-- RLS en is de enige die deze tabel leest/schrijft. Reguliere gebruikers
-- krijgen niets rechtstreeks — toegang loopt via het /translate-endpoint.
