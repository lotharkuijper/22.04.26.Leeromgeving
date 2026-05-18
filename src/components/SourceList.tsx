import { useState, useId } from 'react';
import { FileText, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';

export interface SourceItem {
  title: string;
  similarity: number;
  documentId?: string;
  href?: string;
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
}

function dedupeByDocument(items: SourceItem[]): SourceItem[] {
  const best = new Map<string, SourceItem>();
  for (const s of items) {
    const key = s.documentId ? `id:${s.documentId}` : `t:${s.title}`;
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
            const inner = (
              <>
                <span className="font-medium text-blue-600 mr-1">[{num}]</span>
                <span className="italic">{source.title}</span>
                {source.href && <ExternalLink className="w-3 h-3 inline ml-1 text-gray-400" />}
                {meta}
              </>
            );
            return (
              <li
                key={`${source.title}-${index}`}
                className="text-sm text-gray-700 flex items-start gap-1"
                data-testid={`source-item-${index}`}
                id={`source-${idNs}-${num}`}
              >
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
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
