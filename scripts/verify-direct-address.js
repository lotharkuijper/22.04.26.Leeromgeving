// Eenmalige verificatie dat de drie aangepaste prompts (chat-archive,
// explain-archive, inline feedback fallback) écht tweede-persoons output
// produceren en geen "de student" / "deze student" meer bevatten.
// Geen onderdeel van de productieflow — handmatig draaien.

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const apiKey = process.env.GROQ_API_KEY;
if (!apiKey) {
  console.error('GROQ_API_KEY ontbreekt');
  process.exit(1);
}

const THIRD_PERSON = /\b(de|deze) student\b/i;
const SECOND_PERSON = /\b(je|jij|jouw|jou|je hebt)\b/i;

async function call(prompt) {
  const r = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5,
      max_tokens: 600,
    }),
  });
  if (!r.ok) {
    throw new Error(`Groq fout ${r.status}: ${await r.text()}`);
  }
  const d = await r.json();
  return d.choices?.[0]?.message?.content || '';
}

const chatArchivePrompt = `Je bent een "critical friend" voor een student epidemiologie/biostatistiek aan de VU Amsterdam. Analyseer het volgende studiegesprek en schrijf een formatief reflectieverslag van 5 tot 10 regels in het Nederlands, gericht aan de student zelf.

Aanspraakvorm (volg STRIKT):
- Spreek de student direct aan met "je" / "jij" / "jouw" / "je hebt".
- Gebruik NOOIT formuleringen als "de student", "deze student", "de student heeft" of andere derde-persoonsverwijzingen naar de student. Schrijf alsof je de feedback één-op-één tegen de student geeft.

Je verslag bevat:
1. Een beargumenteerd formatief oordeel over wat jij hebt laten zien en geleerd
2. Concrete sterke punten én verbeterpunten in jouw bijdrage (eerlijk maar opbouwend)
3. Een specifieke suggestie voor verdere verdieping

Gesprekstitel: "Verschil tussen relatief risico en odds ratio"

Gesprek (regels gemarkeerd met "Jij:" zijn de student aan wie je het verslag richt):
Jij: Ik weet niet zo goed wat het verschil is tussen relatief risico en odds ratio.
Tutor: Goede vraag. Beide vergelijken risico's tussen twee groepen, maar het relatief risico gebruikt incidentie-cijfers en de odds ratio gebruikt odds. Wanneer denk jij dat een odds ratio dichter bij het relatief risico ligt?
Jij: Misschien als de uitkomst zeldzaam is?
Tutor: Precies! Bij zeldzame uitkomsten benadert de odds ratio het relatief risico goed. Kun je een voorbeeld bedenken van een case-control studie?
Jij: Een studie naar longkanker bij rokers, waarbij we patiënten met longkanker vergelijken met gezonde mensen.
Tutor: Mooi voorbeeld. En welke maat zou je daar dan rapporteren?

Schrijf het verslag direct zonder aanhef. Wees concreet, eerlijk en motiverend.`;

const explainArchivePrompt = `Je bent een "critical friend" voor een student epidemiologie/biostatistiek aan de VU Amsterdam. Een student heeft het begrip "Confounder" in eigen woorden uitgelegd en feedback ontvangen van de leerassistent. Schrijf een formatief reflectieverslag van 5 tot 10 regels in het Nederlands, gericht aan de student zelf.

Aanspraakvorm (volg STRIKT):
- Spreek de student direct aan met "je" / "jij" / "jouw" / "je hebt".
- Gebruik NOOIT formuleringen als "de student", "deze student", "de student heeft" of andere derde-persoonsverwijzingen naar de student. Schrijf alsof je de feedback één-op-één tegen de student geeft.

Je verslag bevat:
1. Een beargumenteerd formatief oordeel over wat jij hebt laten zien en geleerd over dit begrip
2. Concrete sterke punten én verbeterpunten in jouw uitleg (eerlijk maar opbouwend)
3. Een specifieke suggestie voor verdere verdieping of een vervolgstap

Begrip: "Confounder"
Officiële definitie: Een derde variabele die zowel met de blootstelling als met de uitkomst samenhangt en het verband kan vertekenen.

Jouw uitleg:
Een confounder is iets dat je verkeerd kan laten denken dat A en B verband houden, terwijl er eigenlijk een derde ding is dat allebei beïnvloedt. Bijvoorbeeld leeftijd bij ijsverkoop en verdrinkingen.

Feedback van de leerassistent:
Je legt het idee van een verstorende derde variabele helder uit met een goed voorbeeld. Wat nog ontbreekt is dat de derde variabele zowel met blootstelling als uitkomst moet samenhangen — dat is de formele eis.

Schrijf het verslag direct zonder aanhef. Wees concreet, eerlijk en motiverend.`;

const inlineFeedbackPrompt = `Evalueer de volgende uitleg van een student voor het begrip "Selectiebias".

Officiële definitie:
Systematische fout die ontstaat door de wijze waarop deelnemers in een studie worden geselecteerd.

Kernpunten die genoemd zouden moeten worden:
1. Vertekening door selectie van deelnemers
2. Verschilt van informatiebias
3. Speelt vooral bij case-control en cohort studies

Uitleg van de student:
Selectiebias betekent dat je verkeerde mensen in je studie hebt zitten waardoor je conclusie niet klopt voor iedereen.

Aanspraakvorm (volg STRIKT in jouw feedback): spreek de student direct aan met "je" / "jij" / "jouw". Gebruik NOOIT formuleringen als "de student", "deze student" of "de student heeft" — schrijf alsof je de feedback één-op-één tegen de student geeft.

Geef gestructureerde feedback met:
1. Wat je goed hebt gedaan (specifieke punten in jouw uitleg)
2. Wat ontbreekt of onduidelijk is in jouw uitleg
3. Eventuele misconcepties bij jou die gecorrigeerd moeten worden
4. Concrete suggesties voor verbetering

Wees constructief en moedigend, maar ook specifiek en nuttig.`;

function audit(name, text) {
  const hasThird = THIRD_PERSON.test(text);
  const hasSecond = SECOND_PERSON.test(text);
  const status = !hasThird && hasSecond ? 'PASS' : 'FAIL';
  console.log(`\n=== ${name}: ${status} ===`);
  console.log(`derde-persoon "de/deze student" aanwezig: ${hasThird}`);
  console.log(`tweede-persoon (je/jij/jouw) aanwezig: ${hasSecond}`);
  console.log('--- output ---');
  console.log(text);
  return !hasThird && hasSecond;
}

(async () => {
  const r1 = audit('chat-archive', await call(chatArchivePrompt));
  const r2 = audit('explain-archive', await call(explainArchivePrompt));
  const r3 = audit('inline-feedback (fallback)', await call(inlineFeedbackPrompt));
  console.log(`\n=== EINDOORDEEL: ${r1 && r2 && r3 ? 'ALLES PASS' : 'EEN OF MEER FAIL'} ===`);
  process.exit(r1 && r2 && r3 ? 0 : 1);
})();
