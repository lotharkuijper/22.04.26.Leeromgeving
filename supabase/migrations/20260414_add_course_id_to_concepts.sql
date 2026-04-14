-- Add course_id to concepts table for course-scoped concept management
-- Seed concepts (course_id = NULL) remain globally visible
-- Extracted concepts get a course_id and are only shown in that course

-- 1. Add course_id column (nullable FK to courses)
ALTER TABLE concepts
  ADD COLUMN IF NOT EXISTS course_id uuid REFERENCES courses(id) ON DELETE SET NULL;

-- 2. Drop the old global unique constraint on name
--    (name alone is no longer globally unique; deduplication is now per-course)
ALTER TABLE concepts DROP CONSTRAINT IF EXISTS concepts_name_key;

-- 3. Add partial unique indexes:
--    a) global/seed concepts: name must be unique where course_id IS NULL
CREATE UNIQUE INDEX IF NOT EXISTS concepts_name_global_unique
  ON concepts(name)
  WHERE course_id IS NULL;

--    b) course-specific concepts: name must be unique within a course
CREATE UNIQUE INDEX IF NOT EXISTS concepts_name_course_unique
  ON concepts(name, course_id)
  WHERE course_id IS NOT NULL;

-- 4. Regular index for fast filtering by course
CREATE INDEX IF NOT EXISTS concepts_course_id_idx ON concepts(course_id);
