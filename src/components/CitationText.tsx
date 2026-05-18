import { Fragment, ReactNode, useState } from 'react';

export interface CitationSource {
  index: number;
  title: string;
  href?: string;
  documentId?: string;
}

interface CitationTextProps {
  children: ReactNode;
  sources: CitationSource[];
  onCitationClick?: (index: number) => void;
  onSourceOpen?: (source: CitationSource) => void;
}

function CitationSup({
  source,
  onClick,
  onSourceOpen,
}: {
  source: CitationSource;
  onClick?: (index: number) => void;
  onSourceOpen?: (source: CitationSource) => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <span
      className="relative inline-block align-super"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <sup
        className="text-[0.7em] text-blue-700 cursor-pointer hover:text-blue-900 font-semibold ml-0.5"
        title={source.title}
        data-testid={`citation-${source.index}`}
        onClick={(e) => {
          e.preventDefault();
          if (onClick) onClick(source.index);
        }}
      >
        {source.index}
      </sup>
      {hover && (
        <span
          role="tooltip"
          className="absolute z-20 left-1/2 -translate-x-1/2 top-full mt-1 px-2 py-1 rounded-md bg-gray-900 text-white text-xs whitespace-nowrap shadow-lg pointer-events-auto"
          data-testid={`citation-tooltip-${source.index}`}
        >
          <span className="font-medium">[{source.index}] {source.title}</span>
          {(source.href || source.documentId) && (
            <>
              {' · '}
              <a
                href={source.href || '#'}
                target="_blank"
                rel="noopener noreferrer"
                className="underline text-blue-300 hover:text-blue-200"
                data-testid={`citation-tooltip-link-${source.index}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (onSourceOpen) {
                    e.preventDefault();
                    onSourceOpen(source);
                  }
                }}
              >
                Open bron
              </a>
            </>
          )}
        </span>
      )}
    </span>
  );
}

function transformString(
  text: string,
  sources: CitationSource[],
  onCitationClick?: (index: number) => void,
  onSourceOpen?: (source: CitationSource) => void
): ReactNode[] {
  if (!text) return [text];
  const byIndex = new Map(sources.map((s) => [s.index, s]));
  const re = /\[(\d{1,3})\]/g;
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const idx = Number(m[1]);
    const src = byIndex.get(idx);
    if (!src) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <CitationSup
        key={`cit-${key++}-${idx}`}
        source={src}
        onClick={onCitationClick}
        onSourceOpen={onSourceOpen}
      />
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.length > 0 ? out : [text];
}

function walk(
  node: ReactNode,
  sources: CitationSource[],
  onCitationClick?: (index: number) => void,
  onSourceOpen?: (source: CitationSource) => void
): ReactNode {
  if (typeof node === 'string') {
    const parts = transformString(node, sources, onCitationClick, onSourceOpen);
    return <>{parts.map((p, i) => <Fragment key={i}>{p}</Fragment>)}</>;
  }
  if (Array.isArray(node)) {
    return node.map((child, i) => (
      <Fragment key={i}>{walk(child, sources, onCitationClick, onSourceOpen)}</Fragment>
    ));
  }
  return node;
}

export function CitationText({ children, sources, onCitationClick, onSourceOpen }: CitationTextProps) {
  return <>{walk(children, sources, onCitationClick, onSourceOpen)}</>;
}
