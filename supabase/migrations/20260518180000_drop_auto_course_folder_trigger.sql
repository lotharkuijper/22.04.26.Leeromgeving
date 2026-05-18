-- Task #150: verwijder de DB-trigger die parallel aan POST /api/admin/courses
-- een tweede (verkeerd geparenteerde) cursusmap + assignment maakte. Het
-- server-endpoint bouwt nu de volledige cursusmappenstructuur (parent-map
-- onder root + submappen RAG en Projectdata + permissions + RAG-modules) en
-- mag geen dubbele rijen krijgen van een trigger.

DROP TRIGGER IF EXISTS trg_auto_create_course_folder ON public.courses;
DROP FUNCTION IF EXISTS public.auto_create_course_folder();
