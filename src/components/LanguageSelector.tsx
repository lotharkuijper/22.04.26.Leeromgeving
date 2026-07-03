import { useState, useRef, useEffect, useMemo } from 'react';
import { Languages, Check, Search } from 'lucide-react';
import { useLanguage } from '../i18n';
import { SUPPORTED_LANGUAGES } from '../i18n/languages';

interface LanguageSelectorProps {
  variant?: 'desktop' | 'mobile';
  onSelect?: () => void;
}

// Doorzoekbare taalkiezer (20 talen). Toont de eigen naam in eigen schrift,
// met de Engelse naam als ondertitel. Geen vlag-emoji (projectregel); lucide
// 'Languages'-icoon als visuele cue.
export function LanguageSelector({ variant = 'desktop', onSelect }: LanguageSelectorProps) {
  const { t, lang, setLang } = useLanguage();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const current = SUPPORTED_LANGUAGES.find((l) => l.code === lang);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    const id = setTimeout(() => inputRef.current?.focus(), 10);
    return () => clearTimeout(id);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SUPPORTED_LANGUAGES;
    return SUPPORTED_LANGUAGES.filter(
      (l) =>
        l.native.toLowerCase().includes(q) ||
        l.english.toLowerCase().includes(q) ||
        l.code.toLowerCase().includes(q),
    );
  }, [query]);

  const choose = (code: string) => {
    setLang(code);
    setOpen(false);
    onSelect?.();
  };

  const triggerClass =
    variant === 'mobile'
      ? 'flex items-center gap-3 px-4 py-3 rounded-xl text-gray-700 hover:bg-gray-100 transition-all font-medium w-full'
      : 'hidden md:flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition-colors border border-gray-200';

  return (
    <div ref={containerRef} className={variant === 'mobile' ? 'relative w-full' : 'relative'}>
      <button
        type="button"
        data-testid="button-lang-selector"
        onClick={() => setOpen((v) => !v)}
        title={t('lang.selectorLabel')}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={triggerClass}
      >
        <Languages className={variant === 'mobile' ? 'w-5 h-5' : 'w-4 h-4'} />
        <span className={variant === 'mobile' ? '' : 'text-xs font-semibold'}>
          {current?.native ?? lang}
        </span>
      </button>

      {open && (
        <div
          className={`absolute z-50 mt-2 w-64 rounded-xl border border-gray-200 bg-white shadow-lg ${
            variant === 'mobile' ? 'left-0' : 'right-0'
          }`}
          role="listbox"
        >
          <div className="p-2 border-b border-gray-100">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                ref={inputRef}
                type="text"
                data-testid="input-lang-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('lang.searchPlaceholder')}
                className="w-full pl-8 pr-2 py-2 text-sm rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-300"
              />
            </div>
          </div>
          <ul className="max-h-72 overflow-y-auto py-1">
            {filtered.map((l) => (
              <li key={l.code}>
                <button
                  type="button"
                  data-testid={`option-lang-${l.code}`}
                  onClick={() => choose(l.code)}
                  dir={l.dir}
                  className={`flex items-center justify-between gap-2 w-full px-3 py-2 text-left text-sm hover:bg-gray-50 transition-colors ${
                    l.code === lang ? 'bg-blue-50' : ''
                  }`}
                >
                  <span className="flex flex-col min-w-0">
                    <span className="font-medium text-gray-900 truncate">{l.native}</span>
                    <span className="text-xs text-gray-500 truncate">{l.english}</span>
                  </span>
                  {l.code === lang && <Check className="w-4 h-4 text-blue-600 shrink-0" />}
                </button>
              </li>
            ))}
            {filtered.length === 0 && (
              <li
                className="px-3 py-3 text-sm text-gray-500 text-center"
                data-testid="text-lang-noresults"
              >
                {t('lang.noResults')}
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
