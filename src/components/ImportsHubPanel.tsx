import { type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Download, ArrowRight, Library, Sparkles, Info, Globe } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useLanguage } from '../i18n';
import { ShareStatsImportPanel } from './ShareStatsImportPanel';
import { WebImportPanel } from './WebImportPanel';

// Een importbron = één bibliotheek die app-breed aan LEAP-VU gekoppeld is.
// Nieuwe bibliotheken voeg je toe door één entry aan `sources` toe te voegen
// met een eigen paneel-component; de hub bouwt zijn sub-navigatie hieruit op.
interface ImportSource {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  render: () => ReactNode;
}

interface ImportsHubPanelProps {
  onNavigateToQuizSources: () => void;
}

export function ImportsHubPanel({ onNavigateToQuizSources }: ImportsHubPanelProps) {
  const { t } = useLanguage();
  const [searchParams, setSearchParams] = useSearchParams();

  const sources: ImportSource[] = [
    {
      id: 'sharestats',
      label: t('admin.imports.sources.sharestats.label'),
      description: t('admin.imports.sources.sharestats.desc'),
      icon: Download,
      render: () => <ShareStatsImportPanel />,
    },
    {
      id: 'website',
      label: t('admin.imports.sources.website.label'),
      description: t('admin.imports.sources.website.desc'),
      icon: Globe,
      render: () => <WebImportPanel />,
    },
  ];

  const requested = searchParams.get('source');
  const active = sources.find(s => s.id === requested) ?? sources[0];

  const selectSource = (id: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('source', id);
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="space-y-6" data-testid="panel-imports-hub">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Library className="w-5 h-5 text-blue-600" />
          <h2 className="text-xl font-bold text-gray-900">{t('admin.imports.title')}</h2>
        </div>
        <p className="text-sm text-gray-600 max-w-3xl">{t('admin.imports.intro')}</p>
        <button
          type="button"
          onClick={onNavigateToQuizSources}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:text-blue-700"
          data-testid="link-imports-to-quiz-sources"
        >
          {t('admin.imports.toQuizSources')}
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>

      <div className="flex flex-col md:flex-row gap-6 items-start">
        <div className="w-full md:w-56 flex-shrink-0 space-y-2">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider px-1">
            {t('admin.imports.librariesLabel')}
          </p>
          {sources.map(s => {
            const Icon = s.icon;
            const isActive = s.id === active.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => selectSource(s.id)}
                data-testid={`nav-import-source-${s.id}`}
                className={`w-full text-left rounded-xl border px-3 py-2.5 transition-all ${
                  isActive
                    ? 'border-blue-200 bg-blue-50'
                    : 'border-gray-200 bg-white hover:bg-gray-50'
                }`}
              >
                <div className="flex items-center gap-2">
                  <Icon className={`w-4 h-4 flex-shrink-0 ${isActive ? 'text-blue-600' : 'text-gray-500'}`} />
                  <span className={`text-sm font-medium ${isActive ? 'text-blue-700' : 'text-gray-700'}`}>{s.label}</span>
                </div>
                <p className="text-xs text-gray-500 mt-1 leading-snug">{s.description}</p>
              </button>
            );
          })}
          <div
            className="flex items-start gap-2 rounded-xl border border-dashed border-gray-200 px-3 py-2.5 text-xs text-gray-400"
            data-testid="text-imports-more-coming"
          >
            <Sparkles className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>{t('admin.imports.moreComing')}</span>
          </div>
        </div>

        <div className="flex-1 min-w-0" data-testid={`panel-import-source-${active.id}`}>
          <div className="mb-4 flex items-start gap-2 rounded-xl border border-blue-100 bg-blue-50/60 px-4 py-3">
            <Info className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-blue-900">{t('admin.imports.usageNote')}</p>
          </div>
          {active.render()}
        </div>
      </div>
    </div>
  );
}
