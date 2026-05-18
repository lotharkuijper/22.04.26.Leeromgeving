import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { CitationText, type CitationSource } from './CitationText';

// LLM-uitvoer gebruikt vaak LaTeX-delimiters \(...\) en \[...\]. remark-math
// herkent standaard alleen $...$ / $$...$$, dus zetten we eerst de tex-
// delimiters om. Inhoud binnen fenced of inline code blijft onveranderd.
function normalizeLatexDelimiters(input: string): string {
  if (!input) return input;
  const parts: string[] = [];
  const fenceRe = /(```[\s\S]*?```|`[^`\n]*`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(input)) !== null) {
    if (m.index > last) parts.push(convertOutsideCode(input.slice(last, m.index)));
    parts.push(m[0]);
    last = m.index + m[0].length;
  }
  if (last < input.length) parts.push(convertOutsideCode(input.slice(last)));
  return parts.join('');
}

function convertOutsideCode(s: string): string {
  // Block-niveau: \[ ... \] → $$ ... $$
  let out = s.replace(/\\\[([\s\S]+?)\\\]/g, (_match, body) => `$$${body}$$`);
  // Inline: \( ... \) → $ ... $
  out = out.replace(/\\\(([\s\S]+?)\\\)/g, (_match, body) => `$${body}$`);
  return out;
}

interface MarkdownMessageProps {
  content: string;
  sources?: CitationSource[];
  onCitationClick?: (index: number) => void;
  onSourceOpen?: (source: CitationSource) => void;
  className?: string;
}

export function MarkdownMessage({
  content,
  sources = [],
  onCitationClick,
  onSourceOpen,
  className,
}: MarkdownMessageProps) {
  const wrap = (children: React.ReactNode) =>
    sources.length > 0 ? (
      <CitationText
        sources={sources}
        onCitationClick={onCitationClick}
        onSourceOpen={onSourceOpen}
      >
        {children}
      </CitationText>
    ) : (
      <>{children}</>
    );

  return (
    <div
      className={
        className ??
        'prose prose-sm max-w-none ' +
        'prose-p:my-2 prose-headings:mt-3 prose-headings:mb-2 ' +
        'prose-table:my-2 prose-th:bg-gray-50 prose-th:px-2 prose-th:py-1 ' +
        'prose-td:px-2 prose-td:py-1 prose-td:border prose-th:border ' +
        'prose-code:before:hidden prose-code:after:hidden prose-code:bg-gray-100 ' +
        'prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-[0.9em] ' +
        'prose-pre:bg-gray-900 prose-pre:text-gray-100 ' +
        'prose-a:text-blue-600 prose-a:underline'
      }
      data-testid="markdown-message"
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        skipHtml
        components={{
          p: ({ children }) => <p>{wrap(children)}</p>,
          li: ({ children }) => <li>{wrap(children)}</li>,
          td: ({ children }) => <td>{wrap(children)}</td>,
          th: ({ children }) => <th>{wrap(children)}</th>,
          h1: ({ children }) => <h1>{wrap(children)}</h1>,
          h2: ({ children }) => <h2>{wrap(children)}</h2>,
          h3: ({ children }) => <h3>{wrap(children)}</h3>,
          h4: ({ children }) => <h4>{wrap(children)}</h4>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="border-collapse">{children}</table>
            </div>
          ),
        }}
      >
        {normalizeLatexDelimiters(content)}
      </ReactMarkdown>
    </div>
  );
}
