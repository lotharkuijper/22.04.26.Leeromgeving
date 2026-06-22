-- Task #327: Studiecafé — laat studenten ELK gesprek weer als ongelezen markeren.
--
-- Task #324 markeerde een thread "weer ongelezen" door simpelweg de read-rij te
-- verwijderen. Dat werkt alleen voor threads met activiteit ná de zachte-uitrol-
-- vloer (studiecafe_last_seen): oudere (backlog-)threads worden door de vloer-
-- check onderdrukt en lichten dus nooit op, ook niet zonder read-rij.
--
-- Deze kolom is een expliciete "bewust ongelezen"-marker. Staat hij op true, dan
-- omzeilt de ongelezen-logica de vloer-check en toont de thread weer als "nieuw",
-- ongeacht of de activiteit vóór of ná de vloer ligt. Een thread openen (read) of
-- "alles gelezen" zet hem weer op false. read_at blijft NOT NULL; de marker is
-- onafhankelijk van read_at zodat we de read-rij niet hoeven te verwijderen.

BEGIN;

ALTER TABLE studiecafe_thread_reads
  ADD COLUMN IF NOT EXISTS manual_unread boolean NOT NULL DEFAULT false;

COMMIT;
