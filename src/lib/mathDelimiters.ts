// Helpers om LLM-uitvoer met LaTeX veilig te renderen via remark-math/KaTeX.
//
// Twee stappen:
// 1. normalizeLatexDelimiters: zet \(...\) → $...$ en \[...\] → $$...$$ om,
//    omdat remark-math standaard alleen dollar-delimiters herkent.
// 2. balanceMathDelimiters: vangnet tegen scheve/ongebalanceerde dollartekens.
//    Een los openend $ of $$ (bijv. omdat het taalmodel een afsluiter vergat)
//    zou anders de rest van het antwoord als één grote — ongeldige — formule
//    laten interpreteren, waardoor KaTeX alles in het rood als fout toont.
//    We escapen alleen écht ongepaarde dollar-runs naar literal tekst; correct
//    gepaarde formules blijven onaangeroerd.
//
// Beide stappen laten de inhoud binnen fenced (```...```) of inline (`...`)
// code ongemoeid.

function processOutsideCode(input: string, transform: (s: string) => string): string {
  if (!input) return input;
  const parts: string[] = [];
  const fenceRe = /(```[\s\S]*?```|`[^`\n]*`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(input)) !== null) {
    if (m.index > last) parts.push(transform(input.slice(last, m.index)));
    parts.push(m[0]);
    last = m.index + m[0].length;
  }
  if (last < input.length) parts.push(transform(input.slice(last)));
  return parts.join('');
}

function convertOutsideCode(s: string): string {
  // Block-niveau: \[ ... \] → $$ ... $$
  let out = s.replace(/\\\[([\s\S]+?)\\\]/g, (_match, body) => `$$${body}$$`);
  // Inline: \( ... \) → $ ... $
  out = out.replace(/\\\(([\s\S]+?)\\\)/g, (_match, body) => `$${body}$`);
  return out;
}

export function normalizeLatexDelimiters(input: string): string {
  return processOutsideCode(input, convertOutsideCode);
}

interface DollarRun {
  index: number;
  len: number;
}

// Vind alle runs van opeenvolgende, niet-ge-escapete dollartekens.
function findDollarRuns(seg: string): DollarRun[] {
  const runs: DollarRun[] = [];
  let i = 0;
  while (i < seg.length) {
    const c = seg[i];
    if (c === '\\') {
      // Escape: sla het backslash + volgende teken over (bijv. \$ = literal).
      i += 2;
      continue;
    }
    if (c === '$') {
      let j = i;
      while (j < seg.length && seg[j] === '$') j++;
      runs.push({ index: i, len: j - i });
      i = j;
    } else {
      i++;
    }
  }
  return runs;
}

function hasBlankLine(s: string): boolean {
  return /\n[ \t]*\n/.test(s);
}

// Pareer dollar-runs links-naar-rechts (zoals remark-math): een openende run
// sluit met de eerstvolgende run van dezelfde lengte. Runs van afwijkende
// lengte daartussen gelden als formule-inhoud. Een formule mag geen lege regel
// overspannen — anders zou één los teken hele paragrafen kunnen opslokken.
// Runs zonder geldige afsluiter worden ge-escapet naar literal dollartekens.
function balanceSegment(seg: string): string {
  const runs = findDollarRuns(seg);
  if (runs.length === 0) return seg;

  const consumed = new Array<boolean>(runs.length).fill(false);
  const stray = new Set<number>();

  let i = 0;
  while (i < runs.length) {
    if (consumed[i]) {
      i++;
      continue;
    }
    const open = runs[i];
    let matchIdx = -1;
    for (let j = i + 1; j < runs.length; j++) {
      if (runs[j].len !== open.len) continue;
      const between = seg.slice(open.index + open.len, runs[j].index);
      if (hasBlankLine(between)) break; // lege regel → geen geldige afsluiter
      matchIdx = j;
      break;
    }
    if (matchIdx === -1) {
      stray.add(i);
      i++;
    } else {
      for (let k = i; k <= matchIdx; k++) consumed[k] = true;
      i = matchIdx + 1;
    }
  }

  if (stray.size === 0) return seg;

  let out = '';
  let pos = 0;
  for (let r = 0; r < runs.length; r++) {
    if (!stray.has(r)) continue;
    out += seg.slice(pos, runs[r].index);
    out += '\\$'.repeat(runs[r].len);
    pos = runs[r].index + runs[r].len;
  }
  out += seg.slice(pos);
  return out;
}

export function balanceMathDelimiters(input: string): string {
  return processOutsideCode(input, balanceSegment);
}

// Volledige voorbewerking: eerst tex-delimiters normaliseren, dan balanceren.
export function prepareLatex(input: string): string {
  return processOutsideCode(input, (s) => balanceSegment(convertOutsideCode(s)));
}
