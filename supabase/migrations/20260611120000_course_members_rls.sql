-- Task #161: course_members afschermen tegen directe client-writes.
--
-- Probleem: course_members had RLS UITGESCHAKELD terwijl anon/authenticated
-- volledige SELECT/INSERT/UPDATE/DELETE-grants hadden. Daardoor kon elke
-- ingelogde gebruiker zichzelf via de Supabase-client tot docent
-- (member_role='teacher') van een willekeurige cursus promoveren — volledig
-- buiten de server-side admin-checks om. Docent-koppeling hoort exclusief door
-- een admin/superuser te gebeuren.
--
-- Fix: RLS aanzetten met enkel een SELECT-policy.
--   * Lezen: eigen rijen (frontend leest het eigen lidmaatschap rechtstreeks in
--     AuthContext/CourseAccessContext) en admin/superuser (admin-UI leest alle
--     docent-rijen). pr_is_admin() is SECURITY DEFINER en checkt
--     profiles.role='admin' OF email=superuser.
--   * Schrijven (INSERT/UPDATE/DELETE): GEEN policies → met RLS aan worden alle
--     anon/authenticated-writes geweigerd. De server schrijft uitsluitend met de
--     service-role-key, die RLS overslaat. Zo blijven docent-koppelingen een
--     admin-only server-operatie.

ALTER TABLE public.course_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS course_members_select_own_or_admin ON public.course_members;
CREATE POLICY course_members_select_own_or_admin
  ON public.course_members
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid() OR public.pr_is_admin());
