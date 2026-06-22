-- Task #311: Studiecafé — e-mailmeldingen (digest) voor reacties op je eigen
-- thread + nieuwe aankondigingen, met per-gebruiker opt-out.
--
-- Twee tabellen:
--   1. studiecafe_notification_prefs — per-gebruiker voorkeuren (eigen-rij-data,
--      net als studiecafe_last_seen / student_course_levels). RLS staat aan met
--      eigen-rij-policies; de server leest/schrijft via de service-role.
--   2. studiecafe_notifications — de meld-wachtrij die de digest-worker batcht.
--      Dit is PURE server-state (zoals content_translations): RLS staat aan met
--      BEWUST geen policies, zodat alléén de service-role leest/schrijft. De
--      partiële unieke index op (dedup_key) WHERE sent_at IS NULL ontdubbelt:
--      zolang er nog een onverzonden melding voor dezelfde (ontvanger, thread,
--      soort) openstaat, voegt een nieuwe gebeurtenis er geen extra rij bij —
--      zo overspoelt een druk gesprek de inbox niet. Na verzending (sent_at
--      gezet) valt de rij uit de index en start een volgende reactie vers.

BEGIN;

-- 1. Voorkeuren (opt-out per gebruiker). Standaard: beide meldingen aan.
CREATE TABLE IF NOT EXISTS studiecafe_notification_prefs (
  user_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  email_replies boolean NOT NULL DEFAULT true,
  email_announcements boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE studiecafe_notification_prefs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS studiecafe_notification_prefs_select ON studiecafe_notification_prefs;
CREATE POLICY studiecafe_notification_prefs_select ON studiecafe_notification_prefs FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS studiecafe_notification_prefs_insert ON studiecafe_notification_prefs;
CREATE POLICY studiecafe_notification_prefs_insert ON studiecafe_notification_prefs FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS studiecafe_notification_prefs_update ON studiecafe_notification_prefs;
CREATE POLICY studiecafe_notification_prefs_update ON studiecafe_notification_prefs FOR UPDATE TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS studiecafe_notification_prefs_delete ON studiecafe_notification_prefs;
CREATE POLICY studiecafe_notification_prefs_delete ON studiecafe_notification_prefs FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- 2. Meld-wachtrij (server-only). Geen FK op thread_id/reply_id: een thread kan
--    soft-deleted of gewijzigd zijn tegen de tijd dat de digest draait; we
--    bewaren daarom ook een momentopname van de titel (thread_title).
CREATE TABLE IF NOT EXISTS studiecafe_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,  -- ontvanger
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('reply', 'announcement')),
  thread_id uuid,
  reply_id uuid,
  actor_id uuid,                 -- wie de melding veroorzaakte
  thread_title text,             -- momentopname voor de digest
  dedup_key text NOT NULL,       -- bv. reply:<threadId>:<userId> / announce:<threadId>:<userId>
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

-- Snelle ophaal van onverzonden meldingen per gebruiker.
CREATE INDEX IF NOT EXISTS studiecafe_notifications_pending_idx
  ON studiecafe_notifications(user_id, created_at)
  WHERE sent_at IS NULL;

-- Ontdubbeling: max. één openstaande (onverzonden) melding per dedup_key.
CREATE UNIQUE INDEX IF NOT EXISTS studiecafe_notifications_dedup_idx
  ON studiecafe_notifications(dedup_key)
  WHERE sent_at IS NULL;

ALTER TABLE studiecafe_notifications ENABLE ROW LEVEL SECURITY;
-- BEWUST geen policies: enkel de service-role (server) leest/schrijft.

COMMIT;
