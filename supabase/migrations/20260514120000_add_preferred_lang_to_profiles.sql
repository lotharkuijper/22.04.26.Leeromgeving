-- Task #135: Sla de taalvoorkeur op in het gebruikersprofiel
-- Voegt preferred_lang toe aan de profiles tabel zodat de taalvoorkeur
-- gesynchroniseerd wordt over alle apparaten.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS preferred_lang text DEFAULT 'nl'
    CHECK (preferred_lang IN ('nl', 'en'));
