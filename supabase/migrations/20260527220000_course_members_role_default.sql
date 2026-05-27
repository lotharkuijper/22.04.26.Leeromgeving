-- Task #168 follow-up: course_members.role is een legacy NOT NULL kolom
-- zonder default. Nieuwe inserts via /api/admin/courses/:id/members/:userId
-- crashen daardoor met "null value in column 'role' ... violates not-null".
--
-- We zetten een veilige default zodat upserts blijven werken, en we
-- backfillen eventuele NULLs. De inhoudelijke rol leeft sinds #165 in
-- course_members.member_role; deze kolom is puur compatibility.

BEGIN;

UPDATE course_members SET role = 'member' WHERE role IS NULL;

ALTER TABLE course_members
  ALTER COLUMN role SET DEFAULT 'member';

COMMIT;
