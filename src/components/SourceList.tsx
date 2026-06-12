import { useState, useId } from 'react';
import { FileText, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';

export interface SourceItem {
  title: string;
  similarity: number;
  documentId?: string;
  href?: string;
  /** Eerste dia van de PowerPoint-chunk (1-based); afwezig voor niet-pptx bronnen. */
  slideStart?: number;
  /** Laatste dia van de PowerPoint-chunk; gelijk aan slideStart bij één dia. */
  slideEnd?: number;
  /** True wanneer deze bron bij de begripsextractie als bewijs is vastgelegd (concept_evidence). */
  fromEvidence?: boolean;
  /** Het bij de extractie vastgelegde bronfragment (concept_evidence.snippet). */
  snippet?: string;
}

// "dia 4" of "dia 4–6" voor PowerPoint-bronnen; lege string als geen dia bekend is.
export function slideLabel(item: Pick<SourceItem, 'slideStart' | 'slideEnd'>, word = 'dia'): string {
  if (item.slideStart == null) return '';
  const end = item.slideEnd ?? item.slideStart;
  return end !== item.slideStart ? `${word} ${item.slideStart}–${end}` : `${word} ${item.slideStart}`;
}

interface SourceListProps {
  sources: SourceItem[];
  label?: string;
  /** Toon "(NN% relevant)" achter elke bron. Default true voor backwards compat. */
  showSimilarity?: boolean;
  /** Standaard ingeklapt (default true). */
  defaultCollapsed?: boolean;
  /** Dedupe op documenttitel zodat elke bron maximaal één keer voorkomt. */
  dedupe?: boolean;
  /** Controlled open-state (overschrijft defaultCollapsed wanneer gezet). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Voorvoegsel voor element-id's (source-{prefix}-{n}); vereist bij meerdere lijsten op één pagina. */
  idPrefix?: string;
  /** Click-handler voor het openen van een bron; overschrijft default anchor-navigatie. */
  onOpenSource?: (item: SourceItem) => void;
  /** Achtervoegsel achter het aantal, bv. "uniek"/"unique". Default 'uniek'. */
  uniqueLabel?: string;
  /** Woord voor dia-aanduiding bij PowerPoint-bronnen, bv. "dia"/"slide". Default 'dia'. */
  slideWord?: string;
  /** Label op de badge voor bronnen die uit `concept_evidence` komen (fromEvidence). Leeg = geen badge. */
  evidenceLabel?: string;
  /** Tooltip (title-attribuut) voor de evidence-badge. */
  evidenceTitle?: string;
  /** Label op de uitklap-knop voor het vastgelegde bronfragment (snippet). Leeg = geen uitklap. */
  snippetToggleLabel?: string;
}

function dedupeByDocument(items: SourceItem[]): SourceItem[] {
  const best = new Map<string, SourceItem>();
  for (const s of items) {
    // Dia-reeks meenemen in de sleutel zodat verschillende dia's uit dezelfde
    // PowerPoint als aparte bronnen blijven staan.
    const slidePart = s.slideStart != null ? `:s${s.slideStart}-${s.slideEnd ?? s.slideStart}` : '';
    const key = (s.documentId ? `id:${s.documentId}` : `t:${s.title}`) + slidePart;
    const cur = best.get(key);
    if (!cur || s.similarity > cur.similarity) best.set(key, s);
  }
  return Array.from(best.values()).sort((a, b) => b.similarity - a.similarity);
}

export function SourceList({
  sources,
  label = 'Bronnen',
  showSimilarity = true,
  defaultCollapsed = true,
  dedupe = true,
  open: openProp,
  onOpenChange,
  idPrefix,
  onOpenSource,
  uniqueLabel = 'uniek',
  slideWord = 'dia',
  evidenceLabel,
  evidenceTitle,
  snippetToggleLabel,
}: SourceListProps) {
  const [internalOpen, setInternalOpen] = useState(!defaultCollapsed);
  const open = openProp ?? internalOpen;
  const setOpen = (next: boolean) => {
    if (onOpenChange) onOpenChange(next);
    if (openProp === undefined) setInternalOpen(next);
  };
  const headingId = useId();
  const idNs = idPrefix ?? headingId.replace(/[:]/g, '');
  if (sources.length === 0) return null;

  const list = dedupe ? dedupeByDocument(sources) : sources;
  const headingLabel = `${label} (${list.length} ${uniqueLabel})`;

  return (
    <div className="mt-4 pt-3 border-t border-gray-200" data-testid="source-list">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={headingId}
        className="flex items-center gap-2 text-sm font-semibold text-gray-800 hover:text-blue-700"
        data-testid="btn-toggle-sources"
      >
        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        <FileText className="w-4 h-4 text-blue-600" />
        <span>{headingLabel}</span>
      </button>
      {open && (
        <ul id={headingId} className="mt-2 space-y-1" data-testid="list-sources">
          {list.map((source, index) => {
            const num = index + 1;
            const meta = showSimilarity ? (
              <span className="text-gray-500 text-xs ml-2">
                ({(source.similarity * 100).toFixed(0)}% relevant)
              </span>
            ) : null;
            const slide = slideLabel(source, slideWord);
            const inner = (
              <>
                <span className="font-medium text-blue-600 mr-1">[{num}]</span>
                <span className="italic">{source.title}</span>
                {slide && (
                  <span className="text-gray-500 not-italic ml-1" data-testid={`text-slide-${num}`}>
                    · {slide}
                  </span>
                )}
                {source.href && <ExternalLink className="w-3 h-3 inline ml-1 text-gray-400" />}
                {meta}
                {source.fromEvidence && evidenceLabel && (
                  <span
                    className="not-italic ml-2 inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 border border-emerald-200 align-middle"
                    title={evidenceTitle}
                    data-testid={`badge-evidence-${num}`}
                  >
                    {evidenceLabel}
                  </span>
                )}
              </>
            );
            const showSnippet = !!(source.fromEvidence && source.snippet && snippetToggleLabel);
            return (
              <li
                key={`${source.title}-${index}`}
                className="text-sm text-gray-700"
                data-testid={`source-item-${index}`}
                id={`source-${idNs}-${num}`}
              >
                <div className="flex items-start gap-1">
                  {(source.href || source.documentId) ? (
                    <a
                      href={source.href || '#'}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline"
                      data-testid={`link-source-${num}`}
                      onClick={(e) => {
                        if (onOpenSource) {
                          e.preventDefault();
                          onOpenSource(source);
                        }
                      }}
                    >
                      {inner}
                    </a>
                  ) : (
                    <span>{inner}</span>
                  )}
                </div>
                {showSnippet && (
                  <details className="ml-6 mt-1" data-testid={`details-snippet-${num}`}>
                    <summary
                      className="cursor-pointer select-none text-xs font-medium text-emerald-700 hover:underline"
                      data-testid={`btn-toggle-snippet-${num}`}
                    >
                      {snippetToggleLabel}
                    </summary>
                    <blockquote
                      className="mt-1 whitespace-pre-wrap border-l-2 border-emerald-300 pl-3 text-xs italic text-gray-600"
                      data-testid={`text-snippet-${num}`}
                    >
                      {source.snippet}
                    </blockquote>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
