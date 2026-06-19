import { GraduationCap } from 'lucide-react';
import { useLanguage } from '../i18n';
import { LEVELS } from '../hooks/useLearningLevel';

interface LearningLevelSelectorProps {
  value: number;
  onChange: (level: number) => void;
  disabled?: boolean;
  className?: string;
  /** Compacte variant: kleinere knoppen, geen helptekst. */
  compact?: boolean;
}

// Task #296: zelfgekozen leerniveau (5 stappen, beginner→expert). De student
// bepaalt het niveau; de uitleg van tutor/persona's past zich erop aan.
export function LearningLevelSelector({
  value,
  onChange,
  disabled,
  className,
  compact,
}: LearningLevelSelectorProps) {
  const { t } = useLanguage();
  return (
    <div className={className} data-testid="learning-level-selector">
      <div className="flex items-center gap-1.5 mb-1 text-xs font-medium text-gray-600">
        <GraduationCap className="w-3.5 h-3.5 shrink-0" />
        <span>{t('learningLevel.title')}</span>
      </div>
      <div className="flex gap-1" role="group" aria-label={t('learningLevel.title')}>
        {LEVELS.map((lvl) => {
          const active = value === lvl;
          return (
            <button
              key={lvl}
              type="button"
              disabled={disabled}
              onClick={() => onChange(lvl)}
              title={t(`learningLevel.level${lvl}.desc`)}
              aria-pressed={active}
              className={`flex-1 ${compact ? 'px-1.5 py-1' : 'px-2 py-1.5'} rounded-md text-xs border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                active
                  ? 'bg-blue-600 text-white border-blue-600 font-medium'
                  : 'bg-white text-gray-600 border-gray-300 hover:border-blue-400 hover:text-blue-600'
              }`}
              data-testid={`button-learning-level-${lvl}`}
            >
              {t(`learningLevel.level${lvl}.label`)}
            </button>
          );
        })}
      </div>
      {!compact && (
        <p className="mt-1 text-[11px] leading-snug text-gray-400">{t('learningLevel.help')}</p>
      )}
    </div>
  );
}
