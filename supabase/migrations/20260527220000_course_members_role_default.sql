-- Task #168 follow-up: course_members.role is een legacy NOT NULL kolom
-- met CHECK (role IN ('superuser','teacher','student')) en zonder default.
-- Nieuwe inserts via /api/admin/courses/:id/members/:userId crashen daardoor
-- met "null value in column 'role' ... violates not-null" of "violates check
-- constraint course_members_role_check".
--
-- We zetten 'student' als veilige default (komt overeen met member_role-default
-- en valt binnen de check-constraint) en backfillen eventuele NULLs / legacy
-- 'member'-waardes. De inhoudelijke rol leeft sinds #165 in member_role; deze
-- kolom is puur compatibility.

BEGIN;

UPDATE course_members SET role = 'student' WHERE role IS NULL OR role = 'member';

ALTER TABLE course_members
  ALTER COLUMN role SET DEFAULT 'student';

COMMIT;
