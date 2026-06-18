/*
  # Generieke content-vertaal-cache (dynamische in-app content, Task #288)

  ## Overzicht
  Cachet machinevertalingen van door docenten/admins geschreven, student-
  zichtbare DB-tekst (cursusinformatie-body, projectbriefing, persona-namen,
  begrip-namen/categorieën, …) per (bron-tekst-hash, doeltaal). Bewust
  CONTENT-AGNOSTISCH: identieke tekst die op meerdere schermen verschijnt deelt
  één cache-rij. Het Nederlands in de bron-tabellen blijft leidend; vertalingen
  zijn alleen voor weergave en worden nooit teruggeschreven. Wijzigt de docent de
  tekst, dan verandert de hash en vervalt de cache vanzelf.

  ## Tabel `content_translations`
  - `id` (uuid, pk)
  - `source_hash` (text) — SHA-256 van de genormaliseerde bron-tekst + formaat +
    formaatversie (zie hashContentSource in server/documentTranslation.js)
  - `target_lang` (text) — doeltaalcode (allowlist server-side)
  - `translated_text` (text) — de machinevertaling
  - `created_at` (timestamptz)
  - UNIQUE (source_hash, target_lang) — dé opzoeksleutel; de unique-index dient
    meteen als lookup-index, dus geen aparte index nodig.

  ## Beveiliging
  Net als `document_translations`: er is bewust GEEN client-leesbeleid. Alleen de
  service-role (server) leest/schrijft. De client krijgt vertalingen uitsluitend
  via POST /api/translate-content, dat een ingelogde gebruiker vereist.
*/

CREATE TABLE IF NOT EXISTS content_translations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_hash text NOT NULL,
  target_lang text NOT NULL,
  translated_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_hash, target_lang)
);

ALTER TABLE content_translations ENABLE ROW LEVEL SECURITY;

-- Bewust geen SELECT/INSERT/UPDATE-policy: de service-role (server) bypasst RLS
-- en is de enige die deze tabel leest/schrijft. Toegang loopt via het
-- /api/translate-content-endpoint (vereist een ingelogde gebruiker).
