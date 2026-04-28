import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { BookText, Plus, CreditCard as Edit2, Trash2, Calendar } from 'lucide-react';

interface JournalEntry {
  id: string;
  title: string;
  content: string;
  activity_type: string;
  created_at: string;
  updated_at: string;
}

export function FeedbackPage() {
  const { profile } = useAuth();
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingEntry, setEditingEntry] = useState<JournalEntry | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [activityType, setActivityType] = useState('reflection');
  const [loading, setLoading] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  useEffect(() => {
    loadEntries();
  }, []);

  const loadEntries = async () => {
    const { data, error } = await supabase
      .from('learning_journal_entries')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error loading entries:', error);
      return;
    }

    setEntries(data || []);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile) return;

    setLoading(true);

    if (editingEntry) {
      const { error } = await supabase
        .from('learning_journal_entries')
        .update({
          title,
          content,
          activity_type: activityType,
          updated_at: new Date().toISOString(),
        })
        .eq('id', editingEntry.id);

      if (error) {
        console.error('Error updating entry:', error);
        alert('Er is een fout opgetreden bij het bijwerken van je dagboek');
      } else {
        resetForm();
        loadEntries();
      }
    } else {
      const { error } = await supabase
        .from('learning_journal_entries')
        .insert({
          user_id: profile.id,
          title,
          content,
          activity_type: activityType,
        });

      if (error) {
        console.error('Error creating entry:', error);
        alert('Er is een fout opgetreden bij het opslaan van je dagboek');
      } else {
        resetForm();
        loadEntries();
      }
    }

    setLoading(false);
  };

  const handleEdit = (entry: JournalEntry) => {
    setEditingEntry(entry);
    setTitle(entry.title);
    setContent(entry.content);
    setActivityType(entry.activity_type);
    setShowForm(true);
  };

  const handleDelete = async (entryId: string) => {
    const { error } = await supabase
      .from('learning_journal_entries')
      .delete()
      .eq('id', entryId);

    if (error) {
      console.error('Error deleting entry:', error);
    } else {
      setDeleteConfirmId(null);
      loadEntries();
    }
  };

  const resetForm = () => {
    setTitle('');
    setContent('');
    setActivityType('reflection');
    setEditingEntry(null);
    setShowForm(false);
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return new Intl.DateTimeFormat('nl-NL', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Leer Dagboek</h1>
          <p className="text-gray-600">
            Houd bij wat je hebt geleerd en reflecteer op je leeractiviteiten
          </p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-4 py-2 bg-gradient-to-r from-green-500 to-emerald-600 text-white font-semibold rounded-lg hover:from-green-600 hover:to-emerald-700 transition-all shadow-lg flex items-center gap-2"
        >
          <Plus className="w-5 h-5" />
          Nieuwe Notitie
        </button>
      </div>

      {showForm && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <h2 className="text-xl font-bold text-gray-900 mb-4">
            {editingEntry ? 'Bewerk Notitie' : 'Nieuwe Notitie'}
          </h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="title" className="block text-sm font-semibold text-gray-700 mb-2">
                Titel
              </label>
              <input
                id="title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full px-4 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-green-500 focus:border-transparent transition-all outline-none"
                placeholder="Bijvoorbeeld: Geleerd over logistische regressie"
                required
              />
            </div>

            <div>
              <label htmlFor="activityType" className="block text-sm font-semibold text-gray-700 mb-2">
                Type Activiteit
              </label>
              <select
                id="activityType"
                value={activityType}
                onChange={(e) => setActivityType(e.target.value)}
                className="w-full px-4 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-green-500 focus:border-transparent transition-all outline-none"
              >
                <option value="reflection">Reflectie</option>
                <option value="study">Studie</option>
                <option value="practice">Oefening</option>
                <option value="project">Project</option>
                <option value="other">Anders</option>
              </select>
            </div>

            <div>
              <label htmlFor="content" className="block text-sm font-semibold text-gray-700 mb-2">
                Beschrijving
              </label>
              <textarea
                id="content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={6}
                className="w-full px-4 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-green-500 focus:border-transparent transition-all outline-none resize-none"
                placeholder="Wat heb je geleerd? Waar ben je mee bezig geweest? Wat zijn je inzichten?"
                required
              />
            </div>

            <div className="flex gap-3">
              <button
                type="submit"
                disabled={loading}
                className="px-6 py-2 bg-gradient-to-r from-green-500 to-emerald-600 text-white font-semibold rounded-lg hover:from-green-600 hover:to-emerald-700 transition-all shadow-lg disabled:opacity-50"
              >
                {loading ? 'Opslaan...' : editingEntry ? 'Bijwerken' : 'Opslaan'}
              </button>
              <button
                type="button"
                onClick={resetForm}
                className="px-6 py-2 bg-gray-100 text-gray-700 font-semibold rounded-lg hover:bg-gray-200 transition-all"
              >
                Annuleren
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="space-y-4">
        {entries.length === 0 && (
          <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center">
            <BookText className="w-16 h-16 mx-auto mb-4 text-gray-400" />
            <h2 className="text-xl font-bold text-gray-900 mb-2">Nog geen notities</h2>
            <p className="text-gray-600">
              Begin met het bijhouden van je leeractiviteiten door op "Nieuwe Notitie" te klikken
            </p>
          </div>
        )}

        {entries.map((entry) => (
          <div
            key={entry.id}
            className="bg-white rounded-2xl border border-gray-200 p-6 hover:shadow-lg transition-shadow"
          >
            <div className="flex items-start justify-between mb-3">
              <div className="flex-1">
                <h3 className="text-xl font-bold text-gray-900 mb-2">{entry.title}</h3>
                <div className="flex items-center gap-4 text-sm text-gray-500">
                  <div className="flex items-center gap-1">
                    <Calendar className="w-4 h-4" />
                    <span>{formatDate(entry.created_at)}</span>
                  </div>
                  <span className="px-2 py-1 rounded-full bg-green-100 text-green-700 text-xs font-semibold">
                    {entry.activity_type}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {deleteConfirmId === entry.id ? (
                  <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-1.5">
                    <span className="text-sm text-red-700 font-medium">Verwijderen?</span>
                    <button
                      onClick={() => handleDelete(entry.id)}
                      data-testid={`btn-confirm-delete-${entry.id}`}
                      className="px-2.5 py-1 bg-red-600 text-white text-xs font-semibold rounded hover:bg-red-700 transition-colors"
                    >
                      Ja
                    </button>
                    <button
                      onClick={() => setDeleteConfirmId(null)}
                      data-testid={`btn-cancel-delete-${entry.id}`}
                      className="px-2.5 py-1 bg-white text-gray-600 text-xs font-semibold rounded border border-gray-300 hover:bg-gray-50 transition-colors"
                    >
                      Annuleren
                    </button>
                  </div>
                ) : (
                  <>
                    <button
                      onClick={() => handleEdit(entry)}
                      data-testid={`btn-edit-${entry.id}`}
                      className="p-2 text-gray-600 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                      title="Bewerken"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setDeleteConfirmId(entry.id)}
                      data-testid={`btn-delete-${entry.id}`}
                      className="p-2 text-gray-600 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                      title="Verwijderen"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </>
                )}
              </div>
            </div>
            <p className="text-gray-700 whitespace-pre-wrap">{entry.content}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
