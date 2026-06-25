// Pure helpers voor begrippenextractie (RAG-beheer → Begrippen → "Ik leg uit").
// Geen DB-calls hier, zodat vitest ze direct kan testen zonder Supabase-mock.
//
// Achtergrond (de bug die deze helpers oplossen): bij "Hergenereer
// begrippenlijst" (replace-modus) werden de zojuist ingevoegde begrippen
// meteen weer verwijderd, omdat de opruimstap álle RAG-begrippen van de cursus
// wiste — inclusief de nieuwe. Daardoor meldde de UI "68 toegevoegd" terwijl de
// database leeg bleef en de Begrippen-tab + "Ik leg uit" niets toonden.
//
// De oplossing: de opruimstap draait nu vóór de invoeg-stap én is cursusbewust:
//  - alleen RAG-geëxtraheerde begrippen worden opgeruimd (handmatige blijven);
//  - een begrip dat met een ándere cursus gedeeld wordt, verliest alleen de
//    markering van déze cursus en blijft bestaan (gedeelde begrippen beschermen).

export const RAG_MARKER = '[RAG-geëxtraheerd uit cursusmateriaal]';

export function courseMarkerFor(courseId) {
  return `course_id:${courseId}`;
}

function isCourseMarker(kp) {
  return typeof kp === 'string' && kp.startsWith('course_id:');
}

const normName = (name) => String(name || '').toLowerCase().trim();

// Bepaalt welke bestaande RAG-begrippen van een cursus opgeruimd moeten worden
// bij een replace/hergenereer-actie. Wordt aangeroepen NÁ de schrijfstap, zodat
// een mislukte insert de cursus nooit leeg achterlaat.
//
// Input:
//  - `taggedConcepts` = rijen ({id, name, key_points}) die de `courseMarker`
//    bevatten (inclusief de zojuist geschreven/bijgewerkte rijen);
//  - `keepNames` = set/array met de (genormaliseerde) namen die in deze run zijn
//    geëxtraheerd; deze worden NOOIT verwijderd of losgekoppeld. Daardoor blijven
//    (a) de zojuist ingevoegde begrippen en (b) opnieuw voorgestelde bestaande
//    begrippen behouden, terwijl alleen verouderde (niet meer voorgestelde)
//    RAG-begrippen worden opgeruimd.
// Geeft terug:
//  - toDeleteIds: begrippen die ALLEEN bij deze cursus horen → volledig wissen;
//  - toUntag: begrippen die ook bij een andere cursus horen → alleen de
//    markering van deze cursus verwijderen (rij blijft bestaan).
// Handmatige begrippen (zonder RAG-markering) worden altijd met rust gelaten.
export function planConceptReplace(taggedConcepts, { courseMarker, ragMarker = RAG_MARKER, keepNames } = {}) {
  if (!courseMarker) throw new Error('courseMarker is verplicht');
  const keep = keepNames instanceof Set
    ? keepNames
    : new Set((keepNames || []).map(normName));
  const toDeleteIds = [];
  const toUntag = [];
  for (const concept of taggedConcepts || []) {
    const kps = Array.isArray(concept.key_points) ? concept.key_points : [];
    if (!kps.includes(courseMarker)) continue; // defensief: hoort niet bij deze cursus
    if (!kps.includes(ragMarker)) continue;    // handmatig begrip → niet opruimen
    if (keep.has(normName(concept.name))) continue; // opnieuw voorgesteld of net geschreven → behouden
    const otherCourseMarkers = kps.filter((kp) => isCourseMarker(kp) && kp !== courseMarker);
    if (otherCourseMarkers.length > 0) {
      toUntag.push({ id: concept.id, key_points: kps.filter((kp) => kp !== courseMarker) });
    } else {
      toDeleteIds.push(concept.id);
    }
  }
  return { toDeleteIds, toUntag };
}

// Bepaalt welke begrippen ingevoegd, bijgewerkt of overgeslagen moeten worden.
// Wordt aangeroepen NA de opruimstap, zodat `existingConcepts` de actuele staat
// weerspiegelt (oude RAG-begrippen van deze cursus zijn dan al verwijderd).
//
//  - Begrip al gemarkeerd voor deze cursus (bv. handmatig) → overslaan/behouden;
//  - Begrip bestaat al onder dezelfde naam (andere cursus of globaal) → bijwerken
//    door deze cursus-markering toe te voegen (gedeeld begrip). De RAG-markering
//    wordt alleen toegevoegd als het bestaande begrip die al heeft; een handmatig
//    begrip blijft dus handmatig (en wordt later nooit als RAG opgeruimd);
//  - Anders → nieuw invoegen met [courseMarker, ragMarker].
export function planConceptWrites(validConcepts, existingConcepts, { courseMarker, ragMarker = RAG_MARKER } = {}) {
  if (!courseMarker) throw new Error('courseMarker is verplicht');
  const norm = (name) => String(name || '').toLowerCase().trim();

  const existingByName = new Map();
  const alreadyTaggedForCourse = new Set();
  for (const c of existingConcepts || []) {
    const key = norm(c.name);
    if (!key) continue;
    existingByName.set(key, c);
    if ((Array.isArray(c.key_points) ? c.key_points : []).includes(courseMarker)) {
      alreadyTaggedForCourse.add(key);
    }
  }

  const toInsert = [];
  const toUpdate = [];
  const seenInBatch = new Set();
  let skipped = 0;

  for (const c of validConcepts || []) {
    const key = norm(c.name);
    if (!key) { skipped++; continue; }
    if (alreadyTaggedForCourse.has(key)) { skipped++; continue; }
    if (seenInBatch.has(key)) { skipped++; continue; }
    seenInBatch.add(key);

    const existing = existingByName.get(key);
    if (existing) {
      const existingKps = Array.isArray(existing.key_points) ? existing.key_points : [];
      // RAG-markering alleen meenemen als het begrip al RAG-geëxtraheerd was;
      // handmatige begrippen blijven handmatig (worden later nooit opgeruimd).
      const markers = existingKps.includes(ragMarker)
        ? [courseMarker, ragMarker]
        : [courseMarker];
      const merged = [...new Set([...existingKps, ...markers])];
      toUpdate.push({ id: existing.id, key_points: merged });
    } else {
      toInsert.push({
        name: String(c.name).trim(),
        definition: String(c.definition || '').trim(),
        key_points: [courseMarker, ragMarker],
        examples: [],
      });
    }
  }

  return { toInsert, toUpdate, skipped };
}
