import { useState, type RefObject } from 'react';
import { Sigma, Eye, EyeOff } from 'lucide-react';
import { MarkdownMessage } from './MarkdownMessage';
import { useLanguage } from '../i18n';

// Eenvoudige formule-editor (Task #351): een LaTeX-werkbalk die fragmenten op de
// cursorpositie in een bestaande textarea invoegt + een live KaTeX-voorbeeld.
// Hergebruikt de bestaande katex/rehype-katex via MarkdownMessage; GEEN nieuwe
// zware afhankelijkheid.

interface FormulaButton {
  /** Knop-label (de literal die de gebruiker ziet). */
  label: string;
  /** In te voegen LaTeX (binnen de wrapper). `$CURSOR$` markeert de caret. */
  snippet: string;
  /** Wrap-modus: inline `$…$`, blok `$$…$$`, of rauw (al een complete invoeging). */
  wrap?: 'inline' | 'block' | 'raw';
  /** Optionele i18n-titel-key. */
  titleKey?: string;
}

const CARET = '\u0000'; // interne caret-markering in een snippet

const BUTTONS: FormulaButton[] = [
  { label: '$x$', snippet: CARET, wrap: 'inline', titleKey: 'studiecafe.formula.inline' },
  { label: '$$', snippet: CARET, wrap: 'block', titleKey: 'studiecafe.formula.block' },
  { label: 'x²', snippet: `^{${CARET}}`, wrap: 'inline' },
  { label: 'x₂', snippet: `_{${CARET}}`, wrap: 'inline' },
  { label: 'a⁄b', snippet: `\\frac{${CARET}}{}`, wrap: 'inline' },
  { label: '√', snippet: `\\sqrt{${CARET}}`, wrap: 'inline' },
  { label: 'Σ', snippet: `\\sum_{${CARET}}^{}`, wrap: 'inline' },
  { label: '∫', snippet: `\\int_{${CARET}}^{}`, wrap: 'inline' },
  { label: 'x̄', snippet: `\\bar{${CARET}}`, wrap: 'inline' },
  { label: 'α', snippet: `\\alpha${CARET}`, wrap: 'inline' },
  { label: 'β', snippet: `\\beta${CARET}`, wrap: 'inline' },
  { label: 'μ', snippet: `\\mu${CARET}`, wrap: 'inline' },
  { label: 'σ', snippet: `\\sigma${CARET}`, wrap: 'inline' },
  { label: '≤', snippet: `\\leq ${CARET}`, wrap: 'inline' },
  { label: '≥', snippet: `\\geq ${CARET}`, wrap: 'inline' },
  { label: '×', snippet: `\\times ${CARET}`, wrap: 'inline' },
];

interface FormulaEditorProps {
  value: string;
  onChange: (next: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement>;
  /** Onderscheidt data-testids tussen meerdere editors op één pagina. */
  testidPrefix?: string;
}

export function FormulaEditor({ value, onChange, textareaRef, testidPrefix = 'formula' }: FormulaEditorProps) {
  const { t } = useLanguage();
  const [showPreview, setShowPreview] = useState(false);

  const insert = (btn: FormulaButton) => {
    const el = textareaRef.current;
    const start = el ? el.selectionStart : value.length;
    const end = el ? el.selectionEnd : value.length;
    const selected = value.slice(start, end);

    // De caret-markering bepaalt waar de cursor na invoegen komt; eventuele
    // selectie wordt op die plek genest.
    let inner = btn.snippet.replace(CARET, selected);
    let caretInInner = btn.snippet.indexOf(CARET);
    if (caretInInner < 0) caretInInner = inner.length;
    else caretInInner += selected.length;

    let prefix = '';
    let suffix = '';
    if (btn.wrap === 'inline') { prefix = '$'; suffix = '$'; }
    else if (btn.wrap === 'block') { prefix = '$$\n'; suffix = '\n$$'; }

    const insertText = prefix + inner + suffix;
    const next = value.slice(0, start) + insertText + value.slice(end);
    onChange(next);

    // Cursor terugzetten net na de caret-positie binnen de invoeging.
    const caretPos = start + prefix.length + caretInInner;
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(caretPos, caretPos);
    });
  };

  const hasMath = /\$/.test(value);

  return (
    <div className="space-y-2" data-testid={`formula-editor-${testidPrefix}`}>
      <div className="flex flex-wrap items-center gap-1">
        <span className="inline-flex items-center gap-1 text-xs text-slate-400 mr-1">
          <Sigma className="w-3.5 h-3.5" />
          {t('studiecafe.formula.title')}
        </span>
        {BUTTONS.map((btn, i) => (
          <button
            key={`${btn.label}-${i}`}
            type="button"
            onClick={() => insert(btn)}
            title={btn.titleKey ? t(btn.titleKey as any) : t('studiecafe.formula.insertSymbol')}
            className="px-2 py-1 rounded-md text-xs font-medium bg-slate-50 text-slate-600 ring-1 ring-slate-200 hover:bg-amber-50 hover:text-amber-700 hover:ring-amber-200 transition-colors"
            data-testid={`button-formula-${testidPrefix}-${i}`}
          >
            {btn.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setShowPreview((v) => !v)}
          disabled={!hasMath}
          title={t('studiecafe.formula.preview')}
          className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-slate-500 hover:bg-slate-100 disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
          data-testid={`button-formula-preview-${testidPrefix}`}
        >
          {showPreview ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          {t('studiecafe.formula.preview')}
        </button>
      </div>
      {showPreview && hasMath && (
        <div
          className="rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2"
          data-testid={`formula-preview-${testidPrefix}`}
        >
          <MarkdownMessage content={value} className="prose prose-sm max-w-none text-slate-700 prose-p:my-1.5" />
        </div>
      )}
    </div>
  );
}
