// Pure helper voor de bronnen-mix per cursus. Geen I/O — puur normaliseren,
// zodat client (preview) en server (persist) dezelfde regels delen en los
// unit-testbaar zijn.

// De hardcoded standaardverdeling wanneer er (nog) geen opgeslagen mix is, of
// wanneer de som 0 is.
export const DEFAULT_MIX = { pct_rag: 50, pct_itembank: 0, pct_llm: 50 };

// Normaliseert een (mogelijk onvolledige/ongeldige) mix naar drie gehele
// percentages die optellen tot 100. Negatieve waarden en >100 worden geclamped,
// niet-numerieke waarden tellen als 0. Bij som 0 → DEFAULT_MIX. Bij som ≠ 100
// schalen we naar 100 en corrigeren de rest op pct_llm zodat de som exact klopt.
export function normalizeMix(mix) {
  let r = Math.max(0, Math.min(100, parseInt(mix?.pct_rag, 10) || 0));
  let i = Math.max(0, Math.min(100, parseInt(mix?.pct_itembank, 10) || 0));
  let l = Math.max(0, Math.min(100, parseInt(mix?.pct_llm, 10) || 0));
  const sum = r + i + l;
  if (sum === 0) return { ...DEFAULT_MIX };
  if (sum !== 100) {
    r = Math.round((r * 100) / sum);
    i = Math.round((i * 100) / sum);
    l = 100 - r - i;
  }
  return { pct_rag: r, pct_itembank: i, pct_llm: l };
}
