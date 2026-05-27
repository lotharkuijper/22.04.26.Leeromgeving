-- Task #168: Bugfix Users-tab — backfill legacy 'docent'-rollen.
--
-- Migratie 20260521110000 (#165) probeerde dit al, maar werd in deze
-- omgeving niet toegepast. Idempotente herhaling: alle profielen met
-- role='docent' (behalve superuser) terugzetten naar 'student'.
-- Docentschap leeft vanaf #165 uitsluitend in course_members.member_role.

BEGIN;

UPDATE profiles
   SET role = 'student'
 WHERE role = 'docent'
   AND email <> 'l.d.j.kuijper@vu.nl';

-- Zekerheidshalve: course_members.member_role mag niet NULL zijn.
UPDATE course_members
   SET member_role = 'student'
 WHERE member_role IS NULL;

COMMIT;
