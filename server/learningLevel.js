// Pure helpers voor Task #296 (adaptief leerniveau per student). Geen DB-calls
// zodat vitest ze direct kan testen. De student stelt zelf een niveau in (1..5,
// beginner→expert) PER cursus; dat niveau wordt via ÉÉN parametrisch blok in de
// systeemprompt geïnjecteerd (geen aparte prompt per niveau). De bot past zijn
// uitleg erop aan en geeft ALLEEN op aanvraag een eerlijk "klaar voor een hoger
// niveau?"-meta-oordeel. De student blijft de baas: de bot adviseert, de student
// bepaalt het niveau.

export const LEVEL_MIN = 1;
export const LEVEL_MAX = 5;
// Standaardniveau wanneer een student nog niets heeft ingesteld. Bewust laag-
// gemiddeld (een lichte beginner): liever te veel uitleg dan te weinig. Dit is
// een bewuste, instelbare keuze — pas LEVEL_DEFAULT aan om hem te verschuiven.
export const LEVEL_DEFAULT = 2;

// Korte, voor de student zichtbare labels per niveau (de UI gebruikt eigen
// i18n-keys; deze labels worden in de systeemprompt gebruikt zodat het model
// weet welk niveau de student koos).
export const LEVEL_LABELS = {
  nl: {
    1: 'Absolute beginner',
    2: 'Beginner',
    3: 'Gemiddeld',
    4: 'Gevorderd',
    5: 'Expert',
  },
  en: {
    1: 'Absolute beginner',
    2: 'Beginner',
    3: 'Intermediate',
    4: 'Advanced',
    5: 'Expert',
  },
};

// Kalibratie-beschrijving per niveau: hoe het model vocabulaire, aangenomen
// voorkennis, diepgang en vakjargon afstemt. Dit is DATA in één template, geen
// aparte prompt per niveau.
const LEVEL_DESCRIPTORS = {
  nl: {
    1: 'ga uit van geen enkele voorkennis; vermijd vakjargon of leg élke vakterm meteen in gewone taal uit, gebruik alledaagse analogieën, werk in kleine stapjes en wees extra geduldig en aanmoedigend.',
    2: 'ga uit van weinig voorkennis; introduceer vaktermen rustig met een korte uitleg, gebruik eenvoudige voorbeelden en bouw stap voor stap op.',
    3: 'ga uit van basiskennis van de kernbegrippen; gebruik gangbare vaktaal met af en toe een korte verduidelijking en houd een gemiddelde diepgang aan.',
    4: 'ga uit van een stevige basis; gebruik vaktaal vrijuit, ga in op onderliggende mechanismen en nuances, leg verbanden en houd de student minder bij de hand.',
    5: 'ga uit van een sterke beheersing; wees bondig en precies, bespreek randgevallen, aannames, beperkingen en verbanden met gevorderde stof, en sla elementaire uitleg over tenzij erom gevraagd wordt.',
  },
  en: {
    1: 'assume no prior knowledge at all; avoid jargon or immediately explain every technical term in plain language, use everyday analogies, work in small steps and be extra patient and encouraging.',
    2: 'assume little prior knowledge; introduce technical terms gently with a brief explanation, use simple examples and build up step by step.',
    3: 'assume basic familiarity with the core concepts; use standard terminology with the occasional brief clarification and keep a moderate depth.',
    4: 'assume a solid foundation; use field terminology freely, go into underlying mechanisms and nuances, draw connections and offer less hand-holding.',
    5: 'assume strong command; be concise and rigorous, discuss edge cases, assumptions, limitations and links to advanced material, and skip elementary explanation unless asked.',
  },
};

// Normaliseert een binnenkomende waarde naar een geheel niveau 1..5. Ongeldige
// of ontbrekende waarden → null (de aanroeper injecteert dan géén blok en houdt
// het neutrale, bestaande gedrag).
export function clampLevel(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return null;
  if (n < LEVEL_MIN) return LEVEL_MIN;
  if (n > LEVEL_MAX) return LEVEL_MAX;
  return n;
}

function pickLangKey(lang) {
  // nl = bron van waarheid, en = universele terugval voor alle overige talen.
  // Het meta-blok zelf staat in NL of EN; de aparte taal-instructie elders in
  // de prompt dwingt nog steeds de uitvoertaal af.
  return String(lang || '').toLowerCase() === 'nl' ? 'nl' : 'en';
}

// Bouwt het parametrische leerniveau-blok dat aan de systeemprompt wordt
// toegevoegd. Retourneert '' bij een ontbrekend/ongeldig niveau, zodat het
// bestaande gedrag onveranderd blijft wanneer er geen niveau is meegegeven.
export function buildLevelInstructionBlock(level, lang) {
  const lvl = clampLevel(level);
  if (lvl == null) return '';
  const key = pickLangKey(lang);
  const label = LEVEL_LABELS[key][lvl];
  const descriptor = LEVEL_DESCRIPTORS[key][lvl];

  if (key === 'nl') {
    return `\n\nLEERNIVEAU VAN DE STUDENT (volg dit strikt):
De student heeft zélf zijn/haar kennisniveau voor deze cursus ingesteld op: "${label}" (niveau ${lvl} van ${LEVEL_MAX}).
Stem je uitleg hierop af: ${descriptor}
Aanvullende regels:
- Pas vocabulaire, vakjargon, diepgang en de aangenomen voorkennis consequent aan op dit niveau, ook in voorbeelden.
- Verlaag of verhoog het niveau NIET op eigen initiatief; de student bepaalt het niveau zelf via de niveaukiezer.
- Begin niet uit jezelf over het niveau of over "klaar zijn voor een hoger niveau".
- ALLEEN wanneer de student er expliciet naar vraagt (bijvoorbeeld of hij/zij klaar is voor een hoger niveau, of hoe het met de voortgang staat), geef dan een eerlijke, onderbouwde meta-inschatting op basis van wat je in dit gesprek hebt gezien: benoem concreet wat al sterk is en wat nog nodig is voor een hoger niveau. Blijf adviserend en respecteer dat de student zelf beslist of en wanneer het niveau omhoog gaat.`;
  }

  return `\n\nSTUDENT'S LEARNING LEVEL (follow this strictly):
The student has set their own knowledge level for this course to: "${label}" (level ${lvl} of ${LEVEL_MAX}).
Calibrate your explanations accordingly: ${descriptor}
Additional rules:
- Consistently adapt vocabulary, jargon, depth and assumed prior knowledge to this level, including in examples.
- Do NOT lower or raise the level on your own initiative; the student sets the level themselves via the level selector.
- Do not bring up the level or "being ready for a higher level" unprompted.
- ONLY when the student explicitly asks (for example whether they are ready for a higher level, or how their progress is going) give an honest, well-founded meta-assessment based on what you have seen in this conversation: name concretely what is already strong and what is still needed for a higher level. Stay advisory and respect that the student decides if and when the level goes up.`;
}
