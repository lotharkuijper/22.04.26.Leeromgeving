// Pure logica voor het QuizSourcesAdminPanel, losgekoppeld van React zodat het
// regressie-bestendig is en met vitest gedekt kan worden. Geen state, geen JSX —
// alleen data-in/data-uit. De component importeert deze functies zodat de tests
// het écht gebruikte codepad bewaken.

export interface SourceMix {
  pct_rag: number;
  pct_itembank: number;
  pct_llm: number;
}

export interface ConceptRow {
  id: string;
  name: string;
  category?: string | null;
  course_id?: string | null;
  key_points?: string[] | null;
  definition?: string | null;
}

// Hardcoded standaardverdeling: gespiegeld aan server `DEFAULT_MIX`. Wordt
// gebruikt als reset-waarde bij cursus-wissel en wanneer er (nog) geen
// opgeslagen mix-rij voor de cursus bestaat.
export const DEFAULT_MIX: SourceMix = { pct_rag: 50, pct_itembank: 0, pct_llm: 50 };

// Client-preview van de server-`normalizeMix`: zo ziet de docent vóór het
// opslaan welke percentages er straks echt worden bewaard. Moet exact dezelfde
// gehele uitkomsten geven als server/quizSourcesMix.js voor gehele invoer.
export function normalizeMixPreview(mix: SourceMix): SourceMix {
  const r0 = Math.max(0, Math.min(100, mix.pct_rag || 0));
  const i0 = Math.max(0, Math.min(100, mix.pct_itembank || 0));
  const l0 = Math.max(0, Math.min(100, mix.pct_llm || 0));
  const sum = r0 + i0 + l0;
  if (sum === 0) return { ...DEFAULT_MIX };
  if (sum === 100) return { pct_rag: r0, pct_itembank: i0, pct_llm: l0 };
  const r = Math.round((r0 * 100) / sum);
  const i = Math.round((i0 * 100) / sum);
  return { pct_rag: r, pct_itembank: i, pct_llm: 100 - r - i };
}

// Filtert begrippen voor één cursus, schema-bewust. Sommige Supabase-instances
// hebben de `concepts.course_id`-kolom (dan staat de koppeling daar), andere
// niet (dan loopt de koppeling via de `key_points`-marker `course_id:<uuid>`).
// Begrippen zonder enige cursus-koppeling worden als globaal beschouwd en
// altijd getoond.
export function filterConceptsForCourse(
  rows: ConceptRow[] | null | undefined,
  courseId: string,
  hasCourseIdCol: boolean
): ConceptRow[] {
  const courseMarker = `course_id:${courseId}`;
  return (rows || []).filter((c) => {
    if (hasCourseIdCol && c.course_id === courseId) return true;
    if ((c.key_points || []).includes(courseMarker)) return true;
    if (!c.course_id && !(c.key_points || []).some((kp) => kp.startsWith('course_id:'))) return true;
    return false;
  });
}

// Minimale vorm van de Supabase-client die we hier nodig hebben. Door deze als
// argument te injecteren kan de fallback-flow zonder echte netwerkcalls getest
// worden.
interface ConceptQueryResult {
  data: ConceptRow[] | null;
  error: { message: string } | null;
}
export interface ConceptSupabaseLike {
  from(table: string): {
    select(cols: string): {
      order(col: string): Promise<ConceptQueryResult>;
    };
  };
}

export interface LoadConceptsResult {
  concepts: ConceptRow[];
  hasCourseIdCol: boolean;
  error: { message: string } | null;
}

// Laadt begrippen schema-bewust: probeer eerst mét `course_id`-kolom; bij een
// fout (ontbrekende kolom → PostgREST 400) val terug op de variant zónder, zodat
// er nooit nul begrippen laden. Geeft de gefilterde begrippen + welk schema is
// gebruikt + een eventuele fout van het fallback-pad terug.
export async function loadConceptsForCourse(
  supabase: ConceptSupabaseLike,
  courseId: string
): Promise<LoadConceptsResult> {
  let conceptRows: ConceptRow[] | null = null;
  let hasCourseIdCol = true;
  let error: { message: string } | null = null;

  const withCol = await supabase
    .from('concepts')
    .select('id, name, category, course_id, key_points, definition')
    .order('name');
  if (withCol.error) {
    hasCourseIdCol = false;
    const fallback = await supabase
      .from('concepts')
      .select('id, name, category, key_points, definition')
      .order('name');
    if (fallback.error) error = fallback.error;
    conceptRows = fallback.data || [];
  } else {
    conceptRows = withCol.data || [];
  }

  return {
    concepts: filterConceptsForCourse(conceptRows, courseId, hasCourseIdCol),
    hasCourseIdCol,
    error,
  };
}

export interface MixApiResponse {
  mix?: SourceMix | null;
  updated_at?: string | null;
  schema_ready?: boolean;
}

export interface DerivedMixState {
  mix: SourceMix;
  // `true` = er bestaat een opgeslagen rij voor deze cursus (badge "bewaard").
  // `false` = de getoonde verdeling is slechts de hardcoded standaard.
  mixConfigured: boolean;
  schemaReady: boolean;
}

// Vertaalt het /api/quiz-sources-mix-antwoord naar de drie state-waarden. De
// saved-vs-default badge wordt gedreven door `updated_at`: dat veld is alleen
// aanwezig als er werkelijk een opgeslagen rij is.
export function deriveMixState(mixData: MixApiResponse | null | undefined): DerivedMixState {
  if (!mixData) return { mix: { ...DEFAULT_MIX }, mixConfigured: false, schemaReady: true };
  return {
    mix: mixData.mix ? mixData.mix : { ...DEFAULT_MIX },
    mixConfigured: !!mixData.updated_at,
    schemaReady: mixData.schema_ready !== false,
  };
}
