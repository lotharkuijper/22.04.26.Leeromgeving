-- Task #173 — per-cursus cue-bereik instelbaar maken.
-- Voegt een kolom `cue_delta_max` toe aan `courses` die per cursus aangeeft
-- hoe groot de absolute uitslag van een verstandhoudingscue mag zijn bij het
-- afronden van een persona-gesprek. Default 2 = de bestaande hardcoded waarde
-- (CUE_DELTA_MAX in server/personaRelationship.js), zodat bestaande cursussen
-- ongewijzigd doorwerken. Range 1..5; geclamped in server-helpers.

alter table public.courses
  add column if not exists cue_delta_max smallint not null default 2;

-- Idempotente check-constraint: voeg alleen toe als hij nog niet bestaat.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'courses_cue_delta_max_range'
  ) then
    alter table public.courses
      add constraint courses_cue_delta_max_range
      check (cue_delta_max between 1 and 5);
  end if;
end $$;

comment on column public.courses.cue_delta_max is
  'Maximaal absoluut cue-delta dat een conversational persona aan het eind van een gesprek mag uitzenden (1..5). Default 2.';
