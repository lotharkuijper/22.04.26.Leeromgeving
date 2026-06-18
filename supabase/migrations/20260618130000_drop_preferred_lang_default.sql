-- Meertaligheid: laat browserdetectie de eerste keuze zijn (terugval Engels).
-- De oude kolom-default 'nl' zorgde dat ELK nieuw profiel op Nederlands stond,
-- waardoor ProfileLangSync de browsergedetecteerde taal overschreef. We droppen
-- de default zodat nieuwe profielen NULL ("nog geen expliciete keuze") krijgen;
-- de client legt dan eenmalig de gedetecteerde taal vast. Bestaande rijen
-- blijven ongemoeid (geen retroactieve wijziging van bestaande voorkeuren).
-- De CHECK staat NULL toe, dus dit is veilig naast de 19-talen-constraint.

ALTER TABLE public.profiles
  ALTER COLUMN preferred_lang DROP DEFAULT;
