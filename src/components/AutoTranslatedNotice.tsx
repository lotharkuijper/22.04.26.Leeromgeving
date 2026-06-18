import { Languages } from 'lucide-react';
import { useLanguage } from '../i18n';

// Subtiel label onder/naar machine-vertaalde, door docenten geschreven content
// (Task #288). Toont "automatisch vertaald" + een knop om tussen vertaling en
// origineel te wisselen. Rendert niets als er niets vertaald is of wordt.
interface Props {
  isTranslating: boolean;
  isTranslated: boolean;
  showOriginal: boolean;
  onToggle: (next: boolean) => void;
  className?: string;
}

export function AutoTranslatedNotice({ isTranslating, isTranslated, showOriginal, onToggle, className }: Props) {
  const { t } = useLanguage();
  if (!isTranslating && !isTranslated) return null;
  return (
    <div
      className={`flex items-center gap-1.5 text-[11px] text-gray-400 ${className || ''}`}
      data-testid="notice-auto-translated"
    >
      <Languages className="w-3 h-3 shrink-0" />
      {isTranslating ? (
        <span data-testid="status-translating">{t('content.translating')}</span>
      ) : (
        <>
          <span>{t('content.autoTranslated')}</span>
          <button
            type="button"
            onClick={() => onToggle(!showOriginal)}
            className="underline hover:text-gray-600 transition-colors"
            data-testid="button-toggle-original"
          >
            {showOriginal ? t('content.showTranslation') : t('content.showOriginal')}
          </button>
        </>
      )}
    </div>
  );
}
