import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useLanguage } from '../../i18n';
import { supabase } from '../../lib/supabase';
import {
  UserPlus, Upload, Loader2, CheckCircle, XCircle, AlertTriangle, Info, Users,
} from 'lucide-react';

// Maximale batchgrootte per request — moet gelijk zijn aan MAX_BULK_BATCH in
// server/bulkAccounts.js. Grotere lijsten splitsen we client-side in stukken.
const CHUNK = 50;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

interface CourseOption { id: string; name: string; }
type ProvisionStatus = 'created' | 'existed' | 'failed';
interface ProvisionResult { email: string; status: ProvisionStatus; error?: string; }

export function AddUsersTab() {
  const { isAdmin, isDocent } = useAuth();
  const { t } = useLanguage();

  const [courses, setCourses] = useState<CourseOption[]>([]);
  const [courseId, setCourseId] = useState('');
  const [emailText, setEmailText] = useState('');
  const [fileLoading, setFileLoading] = useState(false);
  const [fileMsg, setFileMsg] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<ProvisionResult[]>([]);
  const [summary, setSummary] = useState<{ created: number; existed: number; failed: number; invalid: number; duplicates: number } | null>(null);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Cursuslijst laden: admin krijgt alle cursussen, een docent alleen de
  // cursussen waarin hij/zij docent is.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (isAdmin) {
          const { data } = await supabase.from('courses').select('id, name').order('name');
          if (!cancelled) setCourses((data as CourseOption[]) || []);
        } else {
          const { data: { session } } = await supabase.auth.getSession();
          if (!session?.access_token) return;
          const res = await fetch('/api/me/teacher-courses', {
            headers: { Authorization: `Bearer ${session.access_token}` },
          });
          const d = await res.json();
          if (!cancelled) {
            setCourses((d.courses || []).map((c: any) => ({ id: c.courseId, name: c.courseName })));
          }
        }
      } catch {
        /* stil — de selector blijft leeg */
      }
    })();
    return () => { cancelled = true; };
  }, [isAdmin]);

  // Client-side voorvertoning: tokeniseer, valideer, ontdubbel. Puur cosmetisch;
  // de server her-valideert en is de bron van waarheid.
  const preview = useMemo(() => {
    const tokens = emailText.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    const seen = new Set<string>();
    const valid: string[] = [];
    const invalidSeen = new Set<string>();
    const invalid: string[] = [];
    let duplicates = 0;
    for (const tok of tokens) {
      if (EMAIL_RE.test(tok) && tok.length <= 254) {
        const low = tok.toLowerCase();
        if (seen.has(low)) { duplicates++; continue; }
        seen.add(low); valid.push(low);
      } else {
        const low = tok.toLowerCase();
        if (!invalidSeen.has(low)) { invalidSeen.add(low); invalid.push(tok); }
      }
    }
    return { valid, invalid, duplicates };
  }, [emailText]);

  const handleFile = async (file: File) => {
    setError(''); setFileMsg(''); setFileLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/admin/bulk-accounts/parse-file', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}` },
        body: fd,
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || t('addUsers.err.fileFailed'));
      const merged = (emailText.trim() ? emailText.trim() + '\n' : '') + (d.emails || []).join('\n');
      setEmailText(merged);
      setFileMsg(t('addUsers.fileLoaded').replace('{n}', String(d.count || 0)));
    } catch (e: any) {
      setError(e.message || t('addUsers.err.fileFailed'));
    } finally {
      setFileLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleProvision = async () => {
    setError('');
    if (!courseId) { setError(t('addUsers.err.noCourse')); return; }
    if (preview.valid.length === 0) { setError(t('addUsers.err.noEmails')); return; }
    setSubmitting(true);
    setResults([]);
    setSummary(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const chunks: string[][] = [];
      for (let i = 0; i < preview.valid.length; i += CHUNK) chunks.push(preview.valid.slice(i, i + CHUNK));
      const allResults: ProvisionResult[] = [];
      const agg = { created: 0, existed: 0, failed: 0 };
      for (let ci = 0; ci < chunks.length; ci++) {
        setProgress({ done: ci, total: chunks.length });
        const res = await fetch('/api/admin/bulk-accounts/provision', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ courseId, emails: chunks[ci], redirectBase: window.location.origin }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || t('addUsers.err.provisionFailed'));
        allResults.push(...((data.results || []) as ProvisionResult[]));
        agg.created += data.summary?.created || 0;
        agg.existed += data.summary?.existed || 0;
        agg.failed += data.summary?.failed || 0;
      }
      setProgress({ done: chunks.length, total: chunks.length });
      setResults(allResults);
      setSummary({ ...agg, invalid: preview.invalid.length, duplicates: preview.duplicates });
    } catch (e: any) {
      setError(e.message || t('addUsers.err.provisionFailed'));
    } finally {
      setSubmitting(false);
      setProgress(null);
    }
  };

  if (!isAdmin && !isDocent) {
    return <div className="text-gray-600">{t('addUsers.noAccess')}</div>;
  }

  const statusBadge = (s: ProvisionStatus) => {
    if (s === 'created') return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800"><CheckCircle className="w-3 h-3" />{t('addUsers.status.created')}</span>;
    if (s === 'existed') return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800"><Info className="w-3 h-3" />{t('addUsers.status.existed')}</span>;
    return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800"><XCircle className="w-3 h-3" />{t('addUsers.status.failed')}</span>;
  };

  return (
    <div className="space-y-6 max-w-3xl" data-testid="tab-add-users">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
          <UserPlus className="w-5 h-5 text-blue-600" />
          {t('addUsers.title')}
        </h2>
        <p className="text-gray-600 text-sm mt-1">{t('addUsers.subtitle')}</p>
      </div>

      {/* E-mail-voorwaarde-banner */}
      <div className="bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-lg text-sm flex gap-2" data-testid="banner-email-prereq">
        <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" />
        <span>{t('addUsers.emailPrereq')}</span>
      </div>

      {/* Cursuskeuze */}
      <div>
        <label htmlFor="add-users-course" className="block text-sm font-semibold text-gray-700 mb-2">
          {t('addUsers.courseLabel')}
        </label>
        <select
          id="add-users-course"
          value={courseId}
          onChange={(e) => setCourseId(e.target.value)}
          className="w-full px-3 py-2.5 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none bg-white"
          data-testid="select-course"
        >
          <option value="">{t('addUsers.coursePlaceholder')}</option>
          {courses.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      {/* E-mailadressen */}
      <div>
        <label htmlFor="add-users-emails" className="block text-sm font-semibold text-gray-700 mb-2">
          {t('addUsers.emailsLabel')}
        </label>
        <textarea
          id="add-users-emails"
          value={emailText}
          onChange={(e) => setEmailText(e.target.value)}
          rows={7}
          className="w-full px-3 py-2.5 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none font-mono text-sm"
          placeholder={t('addUsers.emailsPlaceholder')}
          data-testid="input-emails"
        />
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.txt,.xlsx,.xls,.docx,.pdf,.ods"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
            data-testid="input-file"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={fileLoading}
            className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors disabled:opacity-50"
            data-testid="button-upload-file"
          >
            {fileLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {t('addUsers.uploadBtn')}
          </button>
          <span className="text-xs text-gray-500">{t('addUsers.uploadHint')}</span>
          {fileMsg && <span className="text-xs text-green-700" data-testid="text-file-msg">{fileMsg}</span>}
        </div>
      </div>

      {/* Voorvertoning telling */}
      {emailText.trim() && (
        <div className="flex flex-wrap gap-2 text-sm" data-testid="preview-counts">
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-green-100 text-green-800" data-testid="count-valid">
            <Users className="w-3.5 h-3.5" />{t('addUsers.countValid').replace('{n}', String(preview.valid.length))}
          </span>
          {preview.duplicates > 0 && (
            <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-gray-100 text-gray-700" data-testid="count-duplicates">
              {t('addUsers.countDuplicates').replace('{n}', String(preview.duplicates))}
            </span>
          )}
          {preview.invalid.length > 0 && (
            <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-red-100 text-red-800" data-testid="count-invalid">
              {t('addUsers.countInvalid').replace('{n}', String(preview.invalid.length))}
            </span>
          )}
        </div>
      )}

      {preview.invalid.length > 0 && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2" data-testid="text-invalid-list">
          {t('addUsers.invalidList')}: {preview.invalid.slice(0, 20).join(', ')}{preview.invalid.length > 20 ? '…' : ''}
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm" data-testid="text-error">
          {error}
        </div>
      )}

      <div>
        <button
          type="button"
          onClick={handleProvision}
          disabled={submitting || !courseId || preview.valid.length === 0}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-blue-500 to-green-500 text-white font-semibold rounded-lg hover:from-blue-600 hover:to-green-600 transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
          data-testid="button-provision"
        >
          {submitting ? <Loader2 className="w-5 h-5 animate-spin" /> : <UserPlus className="w-5 h-5" />}
          {submitting
            ? (progress ? t('addUsers.submittingProgress').replace('{done}', String(progress.done)).replace('{total}', String(progress.total)) : t('addUsers.submitting'))
            : t('addUsers.submitBtn').replace('{n}', String(preview.valid.length))}
        </button>
      </div>

      {/* Resultatenrapport */}
      {summary && (
        <div className="space-y-3" data-testid="results-report">
          <div className="flex flex-wrap gap-2 text-sm">
            <span className="px-2.5 py-1 rounded-full bg-green-100 text-green-800" data-testid="summary-created">{t('addUsers.summaryCreated').replace('{n}', String(summary.created))}</span>
            <span className="px-2.5 py-1 rounded-full bg-blue-100 text-blue-800" data-testid="summary-existed">{t('addUsers.summaryExisted').replace('{n}', String(summary.existed))}</span>
            {summary.failed > 0 && <span className="px-2.5 py-1 rounded-full bg-red-100 text-red-800" data-testid="summary-failed">{t('addUsers.summaryFailed').replace('{n}', String(summary.failed))}</span>}
          </div>
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-3 py-2 font-semibold text-gray-700">{t('addUsers.tableEmail')}</th>
                  <th className="text-left px-3 py-2 font-semibold text-gray-700">{t('addUsers.tableStatus')}</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.email} className="border-t border-gray-100" data-testid={`row-result-${r.email}`}>
                    <td className="px-3 py-2 font-mono text-gray-800">{r.email}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col gap-0.5">
                        {statusBadge(r.status)}
                        {r.error && <span className="text-xs text-red-600">{r.error}</span>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
