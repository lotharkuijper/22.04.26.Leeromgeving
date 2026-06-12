import { useState, useEffect } from 'react';
import { Download, Loader2, CheckCircle, AlertTriangle, XCircle, RefreshCw, Save, Info, X, Link2 } from 'lucide-react';
import {
  importQuestionsFromShareStats,
  ImportProgress,
  ImportProgressCallback,
  getShareStatsConfig,
  saveShareStatsConfig,
  parseRepoUrl,
} from '../services/sharestats-integration.service';
import { getRepositoryTopics, setItembankRepo } from '../services/github-parser.service';
import { useActiveCourse } from '../contexts/ActiveCourseContext';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';

interface ImportResult {
  imported: number;
  importedMcq?: number;
  importedOpen?: number;
  skipped: number;
  errors: number;
  skippedReasons?: Record<string, number>;
  importedTopSegments?: string[];
}

interface AutoLinkResult {
  created: number;
  linked: number;
  courseName: string;
}

// Engelse ShareStats-topicfolders → Nederlandstalig label voor de UI.
// De interne waarde (key) blijft de echte foldernaam — die wordt naar de
// import-API gestuurd. Onbekende topics vallen terug op een
// genormaliseerde versie van de foldernaam (zie `topicLabel` hieronder).
const TOPIC_LABEL_NL: Record<string, string> = {
  Assumptions: 'Aannames',
  'Descriptive-statistics': 'Beschrijvende statistiek',
  Distributions: 'Verdelingen',
  'Factor-analysis': 'Factoranalyse',
  Inferential_Statistics: 'Inferentiële statistiek',
  'Inferential-Statistics': 'Inferentiële statistiek',
  'Measurement-Level': 'Meetniveau',
  Probability: 'Kansrekening',
  Reliability: 'Betrouwbaarheid',
  'Variable-type': 'Variabele type',
  Variance: 'Variantie',
  packaging: 'Verpakking (technisch)',
  scripts: 'Scripts (technisch)',
};

function topicLabel(folder: string): string {
  if (TOPIC_LABEL_NL[folder]) return TOPIC_LABEL_NL[folder];
  const spaced = folder.replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  if (!spaced) return folder;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

type NoticeKind = 'info' | 'warning' | 'error' | 'success';
interface Notice {
  kind: NoticeKind;
  message: string;
}

const NOTICE_STYLES: Record<NoticeKind, { box: string; icon: string }> = {
  info: { box: 'bg-blue-50 border-blue-200 text-blue-900', icon: 'text-blue-600' },
  warning: { box: 'bg-yellow-50 border-yellow-200 text-yellow-900', icon: 'text-yellow-600' },
  error: { box: 'bg-red-50 border-red-200 text-red-900', icon: 'text-red-600' },
  success: { box: 'bg-emerald-50 border-emerald-200 text-emerald-900', icon: 'text-emerald-600' },
};

const SKIP_REASON_LABELS: Record<string, string> = {
  not_dutch: 'Niet-Nederlands',
  unsupported_extype: 'Niet-ondersteund vraagtype',
  already_imported: 'Al eerder geïmporteerd',
  no_rmd: 'Geen .Rmd-bestand',
  parse_failed: 'Niet geparseerd',
};

export function ShareStatsImportPanel() {
  const { activeCourseId, activeCourse } = useActiveCourse();
  const { isAdmin } = useAuth();
  const [autoLinkResult, setAutoLinkResult] = useState<AutoLinkResult | null>(null);
  const [autoLinking, setAutoLinking] = useState(false);
  const [repoUrl, setRepoUrl] = useState<string>('https://github.com/ShareStats/itembank');
  const [savedRepoUrl, setSavedRepoUrl] = useState<string>('');
  const [lastSyncedAt, setLastSyncedAt] = useState<string | undefined>(undefined);
  const [savingConfig, setSavingConfig] = useState(false);

  const [topics, setTopics] = useState<string[]>([]);
  const [selectedTopics, setSelectedTopics] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    void loadConfigAndTopics();
  }, []);

  useEffect(() => {
    if (!notice) return;
    if (notice.kind !== 'success' && notice.kind !== 'info') return;
    if (notice.kind === 'info' && importing) return;
    const timer = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [notice, importing]);

  const loadConfigAndTopics = async () => {
    setLoading(true);
    try {
      const config = await getShareStatsConfig();
      const url = config.repositoryUrl || 'https://github.com/ShareStats/itembank';
      setRepoUrl(url);
      setSavedRepoUrl(url);
      setLastSyncedAt(config.lastSyncedAt);

      const parsed = parseRepoUrl(url);
      if (parsed) {
        setItembankRepo(parsed.owner, parsed.repo);
      }

      const availableTopics = await getRepositoryTopics();
      setTopics(availableTopics);
    } catch (error) {
      console.error('Error loading topics:', error);
      setNotice({ kind: 'error', message: 'Kon topics niet laden van GitHub. Controleer de repo-URL.' });
    }
    setLoading(false);
  };

  const handleSaveRepoUrl = async () => {
    const parsed = parseRepoUrl(repoUrl);
    if (!parsed) {
      setNotice({ kind: 'warning', message: 'Ongeldige GitHub-URL. Verwacht het formaat https://github.com/<owner>/<repo>.' });
      return;
    }
    setSavingConfig(true);
    try {
      await saveShareStatsConfig({ repositoryUrl: repoUrl, lastSyncedAt });
      setSavedRepoUrl(repoUrl);
      setItembankRepo(parsed.owner, parsed.repo);
      // Topics opnieuw laden voor de nieuwe repo.
      setLoading(true);
      const availableTopics = await getRepositoryTopics();
      setTopics(availableTopics);
      setSelectedTopics([]);
      setLoading(false);
      setNotice({ kind: 'success', message: 'Repo-URL opgeslagen en topics opnieuw geladen.' });
    } catch (err) {
      console.error('Kon repo-URL niet opslaan:', err);
      setNotice({ kind: 'error', message: 'Opslaan mislukt: ' + (err instanceof Error ? err.message : 'Onbekende fout') });
    }
    setSavingConfig(false);
  };

  const handleTopicToggle = (topic: string) => {
    setSelectedTopics((prev) =>
      prev.includes(topic) ? prev.filter((t) => t !== topic) : [...prev, topic]
    );
  };

  const handleSelectAll = () => {
    if (selectedTopics.length === topics.length) {
      setSelectedTopics([]);
    } else {
      setSelectedTopics([...topics]);
    }
  };

  // Roept de server aan om voor elk geïmporteerd top-level exsection-segment
  // automatisch een begrip in de actieve cursus aan te maken én te koppelen
  // via `concept_itembank_sections`. Zo verschijnen ShareStats-vragen direct
  // in de begrippenlijst van Quiz zonder dat een docent eerst handmatig
  // mappings hoeft te leggen.
  const runAutoLink = async (topicsForLink: string[]) => {
    if (!activeCourseId || topicsForLink.length === 0) return;
    setAutoLinking(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Geen actieve sessie');
      // We sturen de geselecteerde GitHub-foldernamen mee. De server
      // zoekt zélf de werkelijk in de database aanwezige exsection-
      // paden op zodat ook eerder geïmporteerde items worden meegenomen
      // en de begrippenlijst bij elke (re-)import bijgewerkt blijft.
      const res = await fetch('/api/admin/sharestats/auto-link-concepts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ courseId: activeCourseId, selectedTopics: topicsForLink }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setAutoLinkResult({
        created: data.created || 0,
        linked: data.linked || 0,
        courseName: activeCourse?.name || '',
      });
    } catch (err) {
      console.warn('Auto-koppelen mislukt:', err);
      setNotice({
        kind: 'warning',
        message: 'Vragen zijn geïmporteerd, maar automatisch koppelen aan begrippen lukte niet: '
          + (err instanceof Error ? err.message : 'onbekende fout')
          + '. Je kunt de mappings handmatig leggen in Beheer → Quiz-bronnen.',
      });
    }
    setAutoLinking(false);
  };

  // Variant voor de volledige-sync-flow: we hebben geen geselecteerde
  // topics, dus sturen we de daadwerkelijke top-segmenten (legacy pad).
  const runAutoLinkSegments = async (topSegments: string[]) => {
    if (!activeCourseId || topSegments.length === 0) return;
    setAutoLinking(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Geen actieve sessie');
      const res = await fetch('/api/admin/sharestats/auto-link-concepts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ courseId: activeCourseId, topSegments }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setAutoLinkResult({
        created: data.created || 0,
        linked: data.linked || 0,
        courseName: activeCourse?.name || '',
      });
    } catch (err) {
      console.warn('Auto-koppelen mislukt:', err);
    }
    setAutoLinking(false);
  };

  const runImport = async (topicsToImport: string[], startMessage: string) => {
    if (!isAdmin) {
      setNotice({
        kind: 'warning',
        message: 'Alleen een beheerder kan vragen importeren in de gedeelde ItemBank.',
      });
      return;
    }
    setImporting(true);
    setResult(null);
    setProgress(null);
    setAutoLinkResult(null);
    setNotice({ kind: 'info', message: startMessage });

    try {
      const importResult = await importQuestionsFromShareStats(
        savedRepoUrl || repoUrl,
        topicsToImport,
        setProgress as ImportProgressCallback
      );
      setResult(importResult);
      setNotice({
        kind: 'success',
        message: `Klaar — ${importResult.imported} geïmporteerd, ${importResult.skipped} overgeslagen, ${importResult.errors} fouten.`,
      });
      // Autom. koppelen aan begrippen in de actieve cursus. Bij een
      // selectieve import baseren we dit op de gekozen topic-folders
      // (zodat ook re-imports en volledig overgeslagen imports het
      // concept netjes aanmaken). Bij een volledige sync (geen
      // expliciete topics) gebruiken we de zojuist nieuw ingevoerde
      // top-segmenten als trigger.
      if (activeCourseId) {
        if (topicsToImport.length > 0) {
          await runAutoLink(topicsToImport);
        } else if (importResult.importedTopSegments && importResult.importedTopSegments.length > 0) {
          await runAutoLinkSegments(importResult.importedTopSegments);
        }
      }
      // Update last_synced_at na succesvolle import.
      const now = new Date().toISOString();
      setLastSyncedAt(now);
      try {
        await saveShareStatsConfig({ repositoryUrl: savedRepoUrl || repoUrl, lastSyncedAt: now });
      } catch {
        /* niet kritiek */
      }
    } catch (error) {
      console.error('Error importing questions:', error);
      setNotice({
        kind: 'error',
        message: 'Importeren mislukt: ' + (error instanceof Error ? error.message : 'Onbekende fout'),
      });
    }

    setImporting(false);
  };

  const handleImport = () => {
    if (selectedTopics.length === 0) {
      setNotice({ kind: 'warning', message: 'Selecteer minimaal één onderwerp om te importeren.' });
      return;
    }
    void runImport(
      selectedTopics,
      `Import gestart vanuit ShareStats voor ${selectedTopics.length} onderwerp(en) — dit kan even duren.`
    );
  };

  const handleSyncAll = () => {
    void runImport(
      [],
      'Volledige synchronisatie met ShareStats gestart — dit kan een paar minuten duren.'
    );
  };

  const renderNoticeIcon = (kind: NoticeKind, className: string) => {
    if (kind === 'success') return <CheckCircle className={className} />;
    if (kind === 'warning') return <AlertTriangle className={className} />;
    if (kind === 'error') return <XCircle className={className} />;
    return <Info className={className} />;
  };

  return (
    <div className="space-y-6" data-testid="panel-sharestats-import">
      {notice && (
        <div
          className={`flex items-start gap-3 border rounded-lg p-4 ${NOTICE_STYLES[notice.kind].box}`}
          role={notice.kind === 'error' || notice.kind === 'warning' ? 'alert' : 'status'}
          aria-live={notice.kind === 'error' || notice.kind === 'warning' ? 'assertive' : 'polite'}
          data-testid={`notice-${notice.kind}`}
        >
          {renderNoticeIcon(notice.kind, `w-5 h-5 mt-0.5 ${NOTICE_STYLES[notice.kind].icon}`)}
          <p className="flex-1 text-sm">{notice.message}</p>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="opacity-70 hover:opacity-100"
            aria-label="Sluit melding"
            data-testid="button-dismiss-notice"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <div className="flex items-start gap-3">
          <Download className="w-5 h-5 text-blue-700 mt-0.5" />
          <div className="flex-1">
            <h3 className="font-semibold text-gray-900 mb-1">ShareStats Itembank</h3>
            <p className="text-sm text-gray-700">
              Importeer en synchroniseer vragen uit een ShareStats-itembank-repository.
              Alleen Nederlandstalige items worden geïmporteerd. Ondersteunde vraagtypes:
              meerkeuze (<code>mchoice</code>, <code>schoice</code>) en open
              (<code>num</code>, <code>string</code>, <code>cloze</code>). Het hiërarchische
              pad uit <code>exsection</code> wordt opgeslagen zodat je vragen aan
              cursus-begrippen kunt koppelen.
            </p>
          </div>
        </div>
      </div>

      {/* Repository configuratie */}
      <div className="bg-white border border-gray-200 rounded-lg p-6 space-y-3">
        <h3 className="font-semibold text-gray-900">Repository</h3>
        <div className="flex gap-2">
          <input
            type="text"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://github.com/ShareStats/itembank"
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono disabled:bg-gray-50 disabled:text-gray-500"
            data-testid="input-repo-url"
            readOnly={!isAdmin}
            disabled={!isAdmin}
          />
          {isAdmin && (
            <button
              onClick={handleSaveRepoUrl}
              disabled={savingConfig || repoUrl === savedRepoUrl}
              className="px-4 py-2 bg-gray-700 text-white text-sm font-medium rounded-lg hover:bg-gray-800 disabled:opacity-50 flex items-center gap-2"
              data-testid="button-save-repo-url"
            >
              <Save className="w-4 h-4" />
              Opslaan
            </button>
          )}
          {isAdmin && (
            <button
              onClick={handleSyncAll}
              disabled={importing || !savedRepoUrl}
              className="px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-2"
              data-testid="button-sync-all"
            >
              <RefreshCw className={`w-4 h-4 ${importing ? 'animate-spin' : ''}`} />
              Volledige sync
            </button>
          )}
        </div>
        {!isAdmin && (
          <p className="text-xs text-gray-500" data-testid="text-repo-admin-only">
            Alleen een beheerder kan de ItemBank-repository wijzigen of een volledige synchronisatie starten.
          </p>
        )}
        {lastSyncedAt && (
          <p className="text-xs text-gray-500" data-testid="text-last-synced">
            Laatst gesynchroniseerd: {new Date(lastSyncedAt).toLocaleString('nl-NL')}
          </p>
        )}
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        </div>
      )}

      {!loading && !isAdmin && (
        <div className="bg-white border border-gray-200 rounded-lg p-6">
          <div className="flex items-start gap-3" data-testid="text-import-admin-only">
            <Info className="w-5 h-5 text-gray-500 mt-0.5 flex-shrink-0" />
            <div className="text-sm text-gray-700">
              <p className="font-semibold text-gray-900 mb-1">Importeren is beheerder-werk</p>
              <p>
                De ShareStats-ItemBank is een <strong>gedeelde vragenpool</strong> die door álle cursussen wordt
                gebruikt. Eén import voegt vragen toe waar iedereen uit put, daarom kan alleen een beheerder
                onderwerpen importeren of synchroniseren.
              </p>
              <p className="mt-2">
                Je kunt bestaande ItemBank-vragen wél aan de begrippen van je eigen cursus koppelen via
                <strong> Beheer → Quiz-bronnen</strong>.
              </p>
            </div>
          </div>
        </div>
      )}

      {!loading && isAdmin && topics.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-gray-900">Selectief importeren per topic</h3>
            <button
              onClick={handleSelectAll}
              className="text-sm text-blue-600 hover:text-blue-700 font-medium"
              data-testid="button-toggle-all-topics"
            >
              {selectedTopics.length === topics.length ? 'Deselecteer alles' : 'Selecteer alles'}
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
            {topics.map((topic) => (
              <label
                key={topic}
                className="flex items-center gap-3 p-3 border border-gray-200 rounded-lg hover:bg-gray-50 cursor-pointer transition-colors"
                data-testid={`label-topic-${topic}`}
              >
                <input
                  type="checkbox"
                  checked={selectedTopics.includes(topic)}
                  onChange={() => handleTopicToggle(topic)}
                  className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                />
                <span className="text-sm font-medium text-gray-700" title={topic}>{topicLabel(topic)}</span>
              </label>
            ))}
          </div>

          {/* Cursus-indicator voor auto-koppelen aan begrippen */}
          <div className="mb-4 flex items-start gap-2 text-xs bg-blue-50 border border-blue-200 rounded-lg p-3" data-testid="text-active-course-indicator">
            <Link2 className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
            <div className="text-blue-900">
              {activeCourseId && activeCourse ? (
                <>
                  <strong>Auto-koppelen actief:</strong> de geïmporteerde topics worden meteen als begrip toegevoegd aan
                  cursus <strong>{activeCourse.name}</strong>, zodat studenten er direct quizvragen over kunnen oefenen.
                </>
              ) : (
                <>
                  <strong>Geen actieve cursus:</strong> de vragen worden wel opgeslagen, maar je moet ze later handmatig aan begrippen
                  koppelen via Beheer → Quiz-bronnen. Wissel naar een cursus om automatisch koppelen te activeren.
                </>
              )}
            </div>
          </div>

          <button
            onClick={handleImport}
            disabled={importing || selectedTopics.length === 0}
            className="w-full px-6 py-3 bg-gradient-to-r from-blue-500 to-blue-600 text-white font-semibold rounded-lg hover:from-blue-600 hover:to-blue-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            data-testid="button-import-selected"
          >
            <Download className="w-5 h-5" />
            {importing ? 'Importeren...' : `Importeer ${selectedTopics.length} topic(s)`}
          </button>

          {progress && (
            <div className="mt-6">
              <div className="flex justify-between text-sm mb-2">
                <span className="text-gray-700">{progress.message}</span>
                <span className="font-medium">{Math.round(progress.progress)}%</span>
              </div>
              <div className="w-full bg-blue-200 rounded-full h-3">
                <div
                  className="bg-blue-600 h-3 rounded-full transition-all duration-300"
                  style={{ width: `${progress.progress}%` }}
                />
              </div>
              {progress.questionsProcessed !== undefined && progress.totalQuestions !== undefined && (
                <p className="text-sm text-gray-600 mt-2">
                  {progress.questionsProcessed} van {progress.totalQuestions} items verwerkt
                </p>
              )}
            </div>
          )}

          {result && (
            <div className="mt-6 space-y-3">
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-green-50 border border-green-200 rounded-lg p-4" data-testid="result-imported">
                  <div className="flex items-center gap-2 mb-2">
                    <CheckCircle className="w-5 h-5 text-green-600" />
                    <span className="text-sm font-medium text-green-900">Geïmporteerd</span>
                  </div>
                  <p className="text-2xl font-bold text-green-900">{result.imported}</p>
                  {(result.importedMcq !== undefined || result.importedOpen !== undefined) && (
                    <p className="text-xs text-green-800 mt-1">
                      {result.importedMcq ?? 0} mcq · {result.importedOpen ?? 0} open
                    </p>
                  )}
                </div>

                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4" data-testid="result-skipped">
                  <div className="flex items-center gap-2 mb-2">
                    <AlertTriangle className="w-5 h-5 text-yellow-600" />
                    <span className="text-sm font-medium text-yellow-900">Overgeslagen</span>
                  </div>
                  <p className="text-2xl font-bold text-yellow-900">{result.skipped}</p>
                </div>

                <div className="bg-red-50 border border-red-200 rounded-lg p-4" data-testid="result-errors">
                  <div className="flex items-center gap-2 mb-2">
                    <XCircle className="w-5 h-5 text-red-600" />
                    <span className="text-sm font-medium text-red-900">Fouten</span>
                  </div>
                  <p className="text-2xl font-bold text-red-900">{result.errors}</p>
                </div>
              </div>

              {result.skippedReasons && (
                <div className="text-xs text-gray-600 bg-gray-50 rounded p-3" data-testid="text-skipped-reasons">
                  <strong>Overslaan-redenen:</strong>{' '}
                  {Object.entries(result.skippedReasons)
                    .filter(([, n]) => n > 0)
                    .map(([k, n]) => `${SKIP_REASON_LABELS[k] || k}: ${n}`)
                    .join(' · ') || '—'}
                </div>
              )}

              {/* Resultaat van het automatisch koppelen aan begrippen. */}
              {(autoLinking || autoLinkResult) && (
                <div className="text-xs bg-blue-50 border border-blue-200 rounded p-3 flex items-start gap-2" data-testid="text-auto-link-result">
                  {autoLinking ? (
                    <>
                      <Loader2 className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5 animate-spin" />
                      <span className="text-blue-900">Begrippen koppelen aan cursus...</span>
                    </>
                  ) : autoLinkResult && (
                    <>
                      <Link2 className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
                      <span className="text-blue-900">
                        <strong>{autoLinkResult.created}</strong> nieuw begrip{autoLinkResult.created === 1 ? '' : 'pen'} aangemaakt
                        en <strong>{autoLinkResult.linked}</strong> koppeling{autoLinkResult.linked === 1 ? '' : 'en'} gelegd
                        {autoLinkResult.courseName && <> in <strong>{autoLinkResult.courseName}</strong></>}.
                        De geïmporteerde vragen zijn nu zichtbaar in de begrippenlijst van Quiz.
                      </span>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
        <h4 className="font-semibold text-gray-900 mb-2">Over ShareStats import</h4>
        <ul className="text-sm text-gray-700 space-y-2">
          <li>• Vragen worden opgehaald van de geconfigureerde GitHub-repository</li>
          <li>• Alleen Nederlandstalige items worden geïmporteerd (folder bevat <code>-nl</code>, of <code>exlang: nl</code>)</li>
          <li>• Meerkeuze (<code>mchoice</code>, <code>schoice</code>) en open vragen (<code>num</code>, <code>string</code>, <code>cloze</code>) worden ondersteund</li>
          <li>• Duplicaten (op basis van ShareStats-ID) worden overgeslagen</li>
          <li>• Het hiërarchische pad uit <code>exsection</code> wordt opgeslagen voor mapping op begrippen</li>
          <li>• Elke vraag wordt automatisch gevalideerd tegen cursusmateriaal</li>
        </ul>
      </div>
    </div>
  );
}
