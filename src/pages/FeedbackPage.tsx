import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useActiveCourse } from '../contexts/ActiveCourseContext';
import { useLanguage } from '../i18n';
import { intlLocale } from '../i18n/languages';
import { supabase } from '../lib/supabase';
import { MarkdownMessage } from '../components/MarkdownMessage';
import {
  BookText,
  Plus,
  CreditCard as Edit2,
  Trash2,
  Calendar,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Lightbulb,
  GraduationCap,
  BarChart3,
  FileText,
} from 'lucide-react';

interface JournalEntry {
  id: string;
  title: string;
  content: string;
  activity_type: string;
  created_at: string;
  updated_at: string;
  course_id?: string | null;
  course_name?: string | null;
}

type GroupKey = 'chat' | 'explain' | 'quiz' | 'project' | 'other';

interface GroupDef {
  key: GroupKey;
  label: string;
  emptyHint: string;
  icon: typeof MessageSquare;
  color: string;
  bg: string;
  border: string;
  badgeBg: string;
  badgeText: string;
  activityType: string;
}

const GROUPS: GroupDef[] = [
  {
    key: 'chat',
    label: 'Chat',
    emptyHint: 'Nog geen samenvattingen vanuit Chat — sluit een gesprek af en kies "Verplaats naar leerdagboek" om hier een notitie te zien verschijnen.',
    icon: MessageSquare,
    color: 'text-green-700',
    bg: 'bg-green-50',
    border: 'border-green-200',
    badgeBg: 'bg-green-100',
    badgeText: 'text-green-700',
    activityType: 'chat_reflection',
  },
  {
    key: 'explain',
    label: 'Ik leg uit',
    emptyHint: 'Nog geen samenvattingen vanuit Ik leg uit — leg een begrip in eigen woorden uit en archiveer de feedback om hier een notitie te zien verschijnen.',
    icon: Lightbulb,
    color: 'text-amber-700',
    bg: 'bg-amber-50',
    border: 'border-amber-200',
    badgeBg: 'bg-amber-100',
    badgeText: 'text-amber-700',
    activityType: 'explanation_reflection',
  },
  {
    key: 'quiz',
    label: 'Quiz',
    emptyHint: 'Nog geen samenvattingen vanuit Quiz — rond een quiz af en kies "Sla samenvatting op" om hier een notitie te zien verschijnen.',
    icon: GraduationCap,
    color: 'text-blue-700',
    bg: 'bg-blue-50',
    border: 'border-blue-200',
    badgeBg: 'bg-blue-100',
    badgeText: 'text-blue-700',
    activityType: 'quiz_reflection',
  },
  {
    key: 'project',
    label: 'Projecten',
    emptyHint: 'Nog geen samenvattingen vanuit Projecten — open een project en kies "Verplaats naar leerdagboek" om hier een notitie te zien verschijnen.',
    icon: BarChart3,
    color: 'text-orange-700',
    bg: 'bg-orange-50',
    border: 'border-orange-200',
    badgeBg: 'bg-orange-100',
    badgeText: 'text-orange-700',
    activityType: 'project_reflection',
  },
  {
    key: 'other',
    label: 'Overig',
    emptyHint: 'Nog geen overige notities — gebruik "Nieuwe Notitie" om handmatig iets toe te voegen dat niet uit een chat, uitleg, quiz of project komt.',
    icon: FileText,
    color: 'text-gray-700',
    bg: 'bg-gray-50',
    border: 'border-gray-200',
    badgeBg: 'bg-gray-100',
    badgeText: 'text-gray-700',
    activityType: 'reflection',
  },
];

function classifyActivity(activityType: string): GroupKey {
  switch (activityType) {
    case 'chat_reflection':
      return 'chat';
    case 'explanation_reflection':
      return 'explain';
    case 'quiz_reflection':
      return 'quiz';
    case 'project_reflection':
      return 'project';
    default:
      return 'other';
  }
}

export function FeedbackPage() {
  const { profile } = useAuth();
  const { activeCourseId } = useActiveCourse();
  const { t, lang } = useLanguage();
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingEntry, setEditingEntry] = useState<JournalEntry | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [activityType, setActivityType] = useState<string>('reflection');
  const [loading, setLoading] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [openGroups, setOpenGroups] = useState<Set<GroupKey>>(new Set());
  const [openEntryIds, setOpenEntryIds] = useState<Set<string>>(new Set());
  const [initializedOpenGroup, setInitializedOpenGroup] = useState(false);

  useEffect(() => {
    void loadEntries();
  }, []);

  const getAuthHeader = async (): Promise<string> => {
    const { data: { session } } = await supabase.auth.getSession();
    return session ? `Bearer ${session.access_token}` : '';
  };

  const loadEntries = async (focusEntryId?: string) => {
    try {
      const auth = await getAuthHeader();
      const res = await fetch('/api/journal', { headers: { Authorization: auth } });
      if (!res.ok) {
        console.error('Error loading entries:', await res.text());
        return;
      }
      const data: JournalEntry[] = await res.json();
      setEntries(data);
      if (focusEntryId) {
        const focused = data.find(e => e.id === focusEntryId);
        if (focused) {
          const group = classifyActivity(focused.activity_type);
          setOpenGroups(prev => {
            if (prev.has(group)) return prev;
            const next = new Set(prev);
            next.add(group);
            return next;
          });
          setOpenEntryIds(prev => {
            if (prev.has(focusEntryId)) return prev;
            const next = new Set(prev);
            next.add(focusEntryId);
            return next;
          });
          setTimeout(() => {
            const el = document.querySelector(`[data-testid="entry-${focusEntryId}"]`);
            if (el && 'scrollIntoView' in el) {
              (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          }, 50);
        }
      }
    } catch (err) {
      console.error('Error loading entries:', err);
    }
  };

  // Groepeer entries per vak en sorteer per groep nieuwste-eerst.
  const entriesByGroup = useMemo(() => {
    const map: Record<GroupKey, JournalEntry[]> = {
      chat: [], explain: [], quiz: [], project: [], other: [],
    };
    for (const entry of entries) {
      map[classifyActivity(entry.activity_type)].push(entry);
    }
    for (const k of Object.keys(map) as GroupKey[]) {
      map[k].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    }
    return map;
  }, [entries]);

  // Bepaal welk vak standaard open staat: het vak met de meest recente notitie.
  // Doen we één keer per laad-cyclus, zodat een gebruiker daarna zelf kan
  // klappen zonder dat de selectie opnieuw springt.
  useEffect(() => {
    if (initializedOpenGroup) return;
    if (entries.length === 0) return;
    let bestGroup: GroupKey | null = null;
    let bestTime = -Infinity;
    for (const g of GROUPS) {
      const top = entriesByGroup[g.key][0];
      if (top) {
        const t = new Date(top.created_at).getTime();
        if (t > bestTime) {
          bestTime = t;
          bestGroup = g.key;
        }
      }
    }
    if (bestGroup) {
      setOpenGroups(new Set([bestGroup]));
    }
    setInitializedOpenGroup(true);
  }, [entries, entriesByGroup, initializedOpenGroup]);

  const toggleGroup = (key: GroupKey) => {
    setOpenGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const toggleEntry = (id: string) => {
    setOpenEntryIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    if (deleteConfirmId && deleteConfirmId !== id) {
      setDeleteConfirmId(null);
      setDeleteError(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile) return;

    setLoading(true);

    try {
      const auth = await getAuthHeader();

      if (editingEntry) {
        const res = await fetch(`/api/journal/${editingEntry.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: auth },
          body: JSON.stringify({ title, content, activity_type: activityType }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          console.error('Error updating entry:', err);
          alert(t('feedback.updateError'));
        } else {
          const focusId = editingEntry.id;
          resetForm();
          void loadEntries(focusId);
        }
      } else {
        const { data: inserted, error } = await supabase
          .from('learning_journal_entries')
          .insert({ user_id: profile.id, title, content, activity_type: activityType, course_id: activeCourseId })
          .select('id')
          .single();

        if (error) {
          console.error('Error creating entry:', error);
          alert(t('feedback.saveError'));
        } else {
          const focusId = inserted?.id as string | undefined;
          resetForm();
          void loadEntries(focusId);
        }
      }
    } catch (err) {
      console.error('Error submitting entry:', err);
    }

    setLoading(false);
  };

  const handleEdit = (entry: JournalEntry) => {
    setEditingEntry(entry);
    setTitle(entry.title);
    setContent(entry.content);
    // Onbekende/legacy activity_types horen bij "Overig" — normaliseer naar
    // het bijbehorende form-keuzeveld zodat het dropdownmenu een geldige
    // selectie toont in plaats van een lege waarde.
    const known = GROUPS.some(g => g.activityType === entry.activity_type);
    setActivityType(known ? entry.activity_type : 'reflection');
    setShowForm(true);
  };

  const handleDelete = async (entryId: string) => {
    setDeleteError(null);
    try {
      const auth = await getAuthHeader();
      const res = await fetch(`/api/journal/${entryId}`, {
        method: 'DELETE',
        headers: { Authorization: auth },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error('Error deleting entry:', err);
        setDeleteError(t('feedback.deleteFailed'));
      } else {
        setDeleteConfirmId(null);
        setOpenEntryIds(prev => {
          const next = new Set(prev);
          next.delete(entryId);
          return next;
        });
        void loadEntries();
      }
    } catch (err) {
      console.error('Error deleting entry:', err);
      setDeleteError(t('feedback.deleteFailed'));
    }
  };

  const resetForm = () => {
    setTitle('');
    setContent('');
    setActivityType('reflection');
    setEditingEntry(null);
    setShowForm(false);
  };

  // Open een vers notitie-formulier met een bepaald vak voorgeselecteerd, zodat
  // een student vanuit elke sectie (of de algemene knop) op elk moment een eigen
  // notitie kan toevoegen. Scrollt naar het formulier zodat het ook in beeld komt.
  const openFormForSection = (sectionActivityType: string) => {
    setEditingEntry(null);
    setTitle('');
    setContent('');
    setActivityType(sectionActivityType);
    setShowForm(true);
    setTimeout(() => {
      const el = document.querySelector('[data-testid="journal-form"]');
      if (el && 'scrollIntoView' in el) {
        (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 50);
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return new Intl.DateTimeFormat(intlLocale(lang), {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  };

  const groupLabel = (key: GroupKey): string => {
    const map: Record<GroupKey, string> = {
      chat: t('feedback.groupChat'),
      explain: t('feedback.groupExplain'),
      quiz: t('feedback.groupQuiz'),
      project: t('feedback.groupProject'),
      other: t('feedback.groupOther'),
    };
    return map[key];
  };

  const groupEmptyHint = (key: GroupKey): string => {
    const map: Record<GroupKey, string> = {
      chat: t('feedback.emptyChat'),
      explain: t('feedback.emptyExplain'),
      quiz: t('feedback.emptyQuiz'),
      project: t('feedback.emptyProject'),
      other: t('feedback.emptyOther'),
    };
    return map[key];
  };

  return (
    <div className="space-y-6" data-testid="page-leerdagboek">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">{t('feedback.title')}</h1>
          <p className="text-gray-600">
            {t('feedback.subtitle')}
          </p>
        </div>
        <button
          onClick={() => (showForm ? resetForm() : openFormForSection('reflection'))}
          data-testid="btn-toggle-form"
          className="px-4 py-2 bg-gradient-to-r from-green-500 to-emerald-600 text-white font-semibold rounded-lg hover:from-green-600 hover:to-emerald-700 transition-all shadow-lg flex items-center gap-2"
        >
          <Plus className="w-5 h-5" />
          {t('feedback.newEntry')}
        </button>
      </div>

      {showForm && (
        <div className="chic-card p-6" data-testid="journal-form">
          <h2 className="text-xl font-bold text-gray-900 mb-4">
            {editingEntry ? t('feedback.edit') + ' ' + t('feedback.entryTitle') : t('feedback.newEntry')}
          </h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="title" className="block text-sm font-semibold text-gray-700 mb-2">
                {t('feedback.entryTitle')}
              </label>
              <input
                id="title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                data-testid="input-title"
                className="w-full px-4 py-2 chic-input"
                placeholder={t('feedback.titlePlaceholder')}
                required
              />
            </div>

            <div>
              <label htmlFor="activityType" className="block text-sm font-semibold text-gray-700 mb-2">
                {t('feedback.sectionLabel')}
              </label>
              <select
                id="activityType"
                value={activityType}
                onChange={(e) => setActivityType(e.target.value)}
                data-testid="select-activity-type"
                className="w-full px-4 py-2 chic-input"
              >
                {GROUPS.map(g => (
                  <option key={g.key} value={g.activityType} data-testid={`option-${g.key}`}>
                    {groupLabel(g.key)}
                  </option>
                ))}
              </select>
              <p className="text-xs text-gray-500 mt-1">
                {t('feedback.sectionHint')}
              </p>
            </div>

            <div>
              <label htmlFor="content" className="block text-sm font-semibold text-gray-700 mb-2">
                {t('feedback.entryContent')}
              </label>
              <textarea
                id="content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                data-testid="textarea-content"
                rows={6}
                className="w-full px-4 py-2 chic-input resize-none"
                placeholder={t('feedback.contentPlaceholder')}
                required
              />
            </div>

            <div className="flex gap-3">
              <button
                type="submit"
                disabled={loading}
                data-testid="btn-submit-entry"
                className="px-6 py-2 bg-gradient-to-r from-green-500 to-emerald-600 text-white font-semibold rounded-lg hover:from-green-600 hover:to-emerald-700 transition-all shadow-lg disabled:opacity-50"
              >
                {loading ? t('feedback.saving') : editingEntry ? t('feedback.update') : t('feedback.save')}
              </button>
              <button
                type="button"
                onClick={resetForm}
                data-testid="btn-cancel-entry"
                className="px-6 py-2 bg-gray-100 text-gray-700 font-semibold rounded-lg hover:bg-gray-200 transition-all"
              >
                {t('feedback.cancel')}
              </button>
            </div>
          </form>
        </div>
      )}

      {entries.length === 0 && (
        <div className="bg-green-50 border border-green-200 rounded-2xl p-5 flex items-start gap-3" data-testid="empty-journal-banner">
          <BookText className="w-5 h-5 text-green-700 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-green-800">
            {t('feedback.emptyBanner')}
          </p>
        </div>
      )}

      <div className="space-y-4">
          {GROUPS.map(group => {
            const items = entriesByGroup[group.key];
            const isOpen = openGroups.has(group.key);
            const Icon = group.icon;
            return (
              <div
                key={group.key}
                className={`bg-white rounded-2xl border ${group.border} overflow-hidden`}
                data-testid={`section-${group.key}`}
              >
                <div className={`w-full flex items-center justify-between gap-3 px-6 py-4 ${group.bg}`}>
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.key)}
                    data-testid={`btn-toggle-section-${group.key}`}
                    aria-expanded={isOpen}
                    className="flex items-center gap-3 flex-1 min-w-0 text-left hover:opacity-80 transition-opacity"
                  >
                    {isOpen ? (
                      <ChevronDown className={`w-5 h-5 ${group.color}`} />
                    ) : (
                      <ChevronRight className={`w-5 h-5 ${group.color}`} />
                    )}
                    <Icon className={`w-5 h-5 ${group.color}`} />
                    <h2 className={`text-lg font-bold ${group.color}`}>{groupLabel(group.key)}</h2>
                  </button>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span
                      className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${group.badgeBg} ${group.badgeText}`}
                      data-testid={`count-${group.key}`}
                    >
                      {items.length === 1
                        ? t('feedback.noteCountSingular', { count: String(items.length) })
                        : t('feedback.noteCountPlural', { count: String(items.length) })}
                    </span>
                    <button
                      type="button"
                      onClick={() => openFormForSection(group.activityType)}
                      data-testid={`btn-add-note-${group.key}`}
                      title={t('feedback.addOwnNote')}
                      aria-label={t('feedback.addOwnNoteFull')}
                      className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-white/70 ${group.color} border ${group.border} hover:bg-white transition-colors`}
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">{t('feedback.addOwnNote')}</span>
                    </button>
                  </div>
                </div>

                {isOpen && (
                  <div className="border-t border-gray-100 divide-y divide-gray-100">
                    {items.length === 0 ? (
                      <div className="px-6 py-5">
                        <p className="text-sm text-gray-500" data-testid={`empty-${group.key}`}>
                          {groupEmptyHint(group.key)}
                        </p>
                        <button
                          type="button"
                          onClick={() => openFormForSection(group.activityType)}
                          data-testid={`btn-add-note-empty-${group.key}`}
                          className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold bg-green-50 text-green-700 border border-green-200 hover:bg-green-100 transition-colors"
                        >
                          <Plus className="w-4 h-4" />
                          {t('feedback.addOwnNoteFull')}
                        </button>
                      </div>
                    ) : (
                      items.map(entry => {
                        const expanded = openEntryIds.has(entry.id);
                        return (
                          <div key={entry.id} data-testid={`entry-${entry.id}`}>
                            <button
                              type="button"
                              onClick={() => toggleEntry(entry.id)}
                              data-testid={`btn-toggle-entry-${entry.id}`}
                              aria-expanded={expanded}
                              className="w-full flex items-center justify-between gap-3 px-6 py-4 hover:bg-gray-50 transition-colors text-left"
                            >
                              <div className="flex items-start gap-3 min-w-0 flex-1">
                                {expanded ? (
                                  <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0 mt-1" />
                                ) : (
                                  <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0 mt-1" />
                                )}
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <h3
                                      className="text-base font-semibold text-gray-900 truncate"
                                      data-testid={`title-${entry.id}`}
                                    >
                                      {entry.title}
                                    </h3>
                                    <span
                                      className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${group.badgeBg} ${group.badgeText}`}
                                      data-testid={`type-label-${entry.id}`}
                                    >
                                      {groupLabel(group.key)}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                                    <div className="flex items-center gap-1">
                                      <Calendar className="w-3.5 h-3.5" />
                                      <span data-testid={`date-${entry.id}`}>{formatDate(entry.created_at)}</span>
                                    </div>
                                    {entry.course_name && (
                                      <div
                                        className="flex items-center gap-1"
                                        title={t('feedback.courseBadgeTitle')}
                                      >
                                        <GraduationCap className="w-3.5 h-3.5" />
                                        <span data-testid={`course-${entry.id}`}>{entry.course_name}</span>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>
                            </button>

                            {expanded && (
                              <div className="px-6 pb-5 pl-13" data-testid={`body-${entry.id}`}>
                                <div className="flex items-start justify-between gap-3 mb-3">
                                  <div className="text-gray-700 flex-1 min-w-0" data-testid={`content-${entry.id}`}>
                                    <MarkdownMessage content={entry.content.replace(/(?<!\n)\n(?!\n)/g, '  \n')} />
                                  </div>
                                  <div className="flex items-center gap-1 flex-shrink-0">
                                    <button
                                      onClick={() => handleEdit(entry)}
                                      data-testid={`btn-edit-${entry.id}`}
                                      className="p-2 text-gray-600 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                                      title={t('feedback.editAction')}
                                    >
                                      <Edit2 className="w-4 h-4" />
                                    </button>
                                    <button
                                      onClick={() => { setDeleteConfirmId(entry.id); setDeleteError(null); }}
                                      data-testid={`btn-delete-${entry.id}`}
                                      className="p-2 text-gray-600 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                                      title={t('feedback.deleteAction')}
                                    >
                                      <Trash2 className="w-4 h-4" />
                                    </button>
                                  </div>
                                </div>

                                {deleteConfirmId === entry.id && (
                                  <div className="flex flex-col items-start gap-1 mt-2" data-testid={`confirm-delete-${entry.id}`}>
                                    <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-1.5">
                                      <span className="text-sm text-red-700 font-medium">{t('feedback.confirmDeleteQuestion')}</span>
                                      <button
                                        onClick={() => handleDelete(entry.id)}
                                        data-testid={`btn-confirm-delete-${entry.id}`}
                                        className="px-2.5 py-1 bg-red-600 text-white text-xs font-semibold rounded hover:bg-red-700 transition-colors"
                                      >
                                        {t('feedback.deleteAction')}
                                      </button>
                                      <button
                                        onClick={() => { setDeleteConfirmId(null); setDeleteError(null); }}
                                        data-testid={`btn-cancel-delete-${entry.id}`}
                                        className="px-2.5 py-1 bg-white text-gray-600 text-xs font-semibold rounded border border-gray-300 hover:bg-gray-50 transition-colors"
                                      >
                                        {t('feedback.cancelAction')}
                                      </button>
                                    </div>
                                    {deleteError && (
                                      <span className="text-xs text-red-600">{deleteError}</span>
                                    )}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}
