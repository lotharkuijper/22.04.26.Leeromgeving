---
name: ItemBank course scoping
description: How itembank sources are isolated per course, and a PostgREST .or() pitfall.
---

# ItemBank bron-scoping per cursus

De `quiz_questions`-itembank kent meerdere bronnen (`source`): `sharestats` is een
**gedeelde, cursus-overstijgende** bank; `csv_import` (docent-geüpload) hoort bij
**één cursus** via `metadata.course_id`.

**Regel:** elk lees-pad dat itembank-vragen/secties ophaalt moet csv_import-rijen
op de actieve cursus scopen, anders lekt de CSV-bank van cursus A in cursus B
(en kan zelfs in een studentquiz belanden bij botsende exsection-paden). Gebruik
de helper `itembankSourceOrFilter(courseId)` in `server/index.js`. ShareStats
blijft expres globaal (mappings sturen relevantie). courseId wordt UUID-gevalideerd
vóór string-interpolatie in het PostgREST `or`-filter (injectiebescherming).

**Why:** code review ving een broken-access-control lek: read-endpoints filterden
op `source IN (...)` zonder cursus-scope.

**How to apply:** voeg bij nieuwe itembank-lees-endpoints `.or(itembankSourceOrFilter(courseId))`
toe (vereis courseId + `isCourseTeacher` voor admin-endpoints).

## PostgREST .or()-valkuil
Stapel niet twee `.or()`-calls op dezelfde supabase-query als de eerste de
bron-scoping is. Combineer secundaire condities (bv. item_type-filter) liever
in-memory of in één expressie, zodat de bron-scoping ondubbelzinnig blijft.
**Why:** dubbele top-level `or=`-params zijn verwarrend en riskant voor een
security-kritisch filter.
