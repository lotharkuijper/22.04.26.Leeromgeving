import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { evaluateExplanation } from '../services/llm.service';
import { searchRelevantChunks, formatContextFromChunks } from '../services/rag.service';
import { BookOpen, Search, Send, CheckCircle, XCircle, AlertCircle, RefreshCw, LogOut, FileText } from 'lucide-react';
import type { Database } from '../lib/database.types';
import { RAGStatusIndicator } from '../components/RAGStatusIndicator';

type Concept = Database['public']['Tables']['concepts']['Row'];

export function ExplainPage() {
  const { profile, signOut } = useAuth();
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [filteredConcepts, setFilteredConcepts] = useState<Concept[]>([]);
  const [selectedConcept, setSelectedConcept] = useState<Concept | null>(null);
  const [explanation, setExplanation] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<'all' | 'epidemiologie' | 'biostatistiek'>('all');
  const [profileTimeout, setProfileTimeout] = useState(false);
  const [retrievedSources, setRetrievedSources] = useState<Array<{ title: string; similarity: number }>>([]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (!profile) {
        console.error('[EXPLAIN] Profile load timeout after 10 seconds');
        setProfileTimeout(true);
      }
    }, 10000);

    return () => clearTimeout(timer);
  }, [profile]);

  useEffect(() => {
    loadConcepts();
  }, []);

  useEffect(() => {
    filterConcepts();
  }, [searchTerm, categoryFilter, concepts]);

  const loadConcepts = async () => {
    try {
      console.log('[EXPLAIN] Loading concepts from database');
      const { data, error } = await supabase
        .from('concepts')
        .select('*')
        .order('name');

      if (error) {
        console.error('[EXPLAIN] Error loading concepts:', error);
        alert('Kon begrippen niet laden. Probeer de pagina te vernieuwen.');
        return;
      }

      console.log(`[EXPLAIN] Loaded ${data?.length || 0} concepts`);
      setConcepts(data || []);
    } catch (error) {
      console.error('[EXPLAIN] Unexpected error loading concepts:', error);
      alert('Er is een onverwachte fout opgetreden.');
    }
  };

  const filterConcepts = () => {
    let filtered = concepts;

    if (categoryFilter !== 'all') {
      filtered = filtered.filter(c => c.category === categoryFilter);
    }

    if (searchTerm) {
      filtered = filtered.filter(c =>
        c.name.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }

    setFilteredConcepts(filtered);
  };

  const handleSubmitExplanation = async () => {
    if (!selectedConcept || !explanation.trim() || !profile) {
      console.log('[EXPLAIN] Missing required data for submission');
      return;
    }

    setLoading(true);
    setFeedback(null);
    setRetrievedSources([]);

    try {
      console.log('[EXPLAIN] Searching for relevant RAG chunks for concept:', selectedConcept.name);
      const chunks = await searchRelevantChunks(
        `${selectedConcept.name} ${selectedConcept.definition || ''}`,
        0.7,
        5,
        'explain',
        profile?.role || 'student'
      );

      const sources = chunks.map(chunk => ({
        title: chunk.documentTitle,
        similarity: chunk.similarity
      }));
      setRetrievedSources(sources);

      const context = chunks.length > 0 ? formatContextFromChunks(chunks) : undefined;
      console.log(`[EXPLAIN] Found ${chunks.length} relevant chunks from RAG`);

      console.log('[EXPLAIN] Evaluating explanation for concept:', selectedConcept.name);
      const response = await evaluateExplanation(
        selectedConcept.name,
        explanation,
        selectedConcept.definition || '',
        selectedConcept.key_points || [],
        context,
        sources
      );

      console.log('[EXPLAIN] Received feedback from LLM');
      setFeedback(response.content);

      console.log('[EXPLAIN] Saving explanation to database');
      await supabase.from('student_explanations').insert({
        concept_id: selectedConcept.id,
        student_id: profile.id,
        explanation_text: explanation,
        feedback: { content: response.content },
        version: 1
      });

      console.log('[EXPLAIN] Explanation saved successfully');
    } catch (error) {
      console.error('[EXPLAIN] Error submitting explanation:', error);
      alert('Er is een fout opgetreden bij het indienen van je uitleg. Probeer het opnieuw.');
    } finally {
      setLoading(false);
    }
  };

  const wordCount = explanation.trim().split(/\s+/).filter(w => w.length > 0).length;

  if (!profile) {
    if (profileTimeout) {
      return (
        <div className="max-w-6xl mx-auto">
          <div className="flex items-center justify-center min-h-[400px]">
            <div className="text-center max-w-md mx-auto px-4">
              <AlertCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
              <h2 className="text-xl font-bold text-gray-900 mb-2">Profiel kon niet worden geladen</h2>
              <p className="text-gray-600 mb-6">
                Er is iets misgegaan bij het laden van je profiel. Dit kan komen door een verbindingsprobleem of een technisch probleem.
              </p>
              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                <button
                  onClick={() => window.location.reload()}
                  className="flex items-center justify-center gap-2 px-6 py-3 bg-gradient-to-r from-blue-500 to-blue-600 text-white font-semibold rounded-xl hover:from-blue-600 hover:to-blue-700 transition-all shadow-lg"
                >
                  <RefreshCw className="w-5 h-5" />
                  Vernieuw pagina
                </button>
                <button
                  onClick={() => signOut()}
                  className="flex items-center justify-center gap-2 px-6 py-3 bg-gray-200 text-gray-700 font-semibold rounded-xl hover:bg-gray-300 transition-all"
                >
                  <LogOut className="w-5 h-5" />
                  Uitloggen
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="text-center">
            <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p className="text-gray-600 font-medium">Je profiel wordt geladen...</p>
            <p className="text-sm text-gray-500 mt-2">Een moment geduld</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Ik Leg Uit</h1>
        <p className="text-gray-600">
          Kies een begrip en leg het uit in je eigen woorden. Je krijgt gedetailleerde feedback!
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 bg-white rounded-2xl border border-gray-200 p-6">
          <h2 className="text-xl font-bold text-gray-900 mb-4">Begrippen</h2>

          <div className="space-y-4 mb-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
              <input
                type="text"
                placeholder="Zoek begrip..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none"
              />
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setCategoryFilter('all')}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                  categoryFilter === 'all'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                Alle
              </button>
              <button
                onClick={() => setCategoryFilter('epidemiologie')}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                  categoryFilter === 'epidemiologie'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                Epidemiologie
              </button>
              <button
                onClick={() => setCategoryFilter('biostatistiek')}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                  categoryFilter === 'biostatistiek'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                Biostatistiek
              </button>
            </div>
          </div>

          <div className="space-y-2 max-h-[500px] overflow-y-auto">
            {filteredConcepts.length === 0 && (
              <p className="text-sm text-gray-500 text-center py-4">
                Geen begrippen gevonden
              </p>
            )}
            {filteredConcepts.map((concept) => (
              <button
                key={concept.id}
                onClick={() => {
                  setSelectedConcept(concept);
                  setExplanation('');
                  setFeedback(null);
                }}
                className={`w-full text-left p-3 rounded-lg transition-all ${
                  selectedConcept?.id === concept.id
                    ? 'bg-gradient-to-r from-blue-100 to-blue-200 text-blue-900 font-medium'
                    : 'hover:bg-gray-100 text-gray-700'
                }`}
              >
                <div className="flex items-center gap-2">
                  <BookOpen className="w-4 h-4 flex-shrink-0" />
                  <span className="text-sm">{concept.name}</span>
                </div>
                <span className="text-xs text-gray-500 ml-6">{concept.category}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="lg:col-span-2 space-y-6">
          {!selectedConcept ? (
            <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center">
              <BookOpen className="w-16 h-16 mx-auto mb-4 text-gray-400" />
              <p className="text-lg font-semibold text-gray-900 mb-2">Selecteer een begrip</p>
              <p className="text-sm text-gray-600">Kies een begrip uit de lijst om te beginnen</p>
            </div>
          ) : (
            <>
              <div className="bg-white rounded-2xl border border-gray-200 p-6">
                <h2 className="text-2xl font-bold text-gray-900 mb-2">{selectedConcept.name}</h2>
                <span className="inline-block px-3 py-1 rounded-full text-xs font-semibold bg-blue-100 text-blue-700 mb-4">
                  {selectedConcept.category}
                </span>

                <div className="space-y-4">
                  <div className="mb-4">
                    <RAGStatusIndicator />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-2">
                      Leg dit begrip uit in je eigen woorden
                    </label>
                    <textarea
                      value={explanation}
                      onChange={(e) => setExplanation(e.target.value)}
                      placeholder="Begin met typen..."
                      rows={8}
                      className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none resize-none"
                    />
                    <div className="flex justify-between items-center mt-2">
                      <span className={`text-sm ${wordCount >= 50 ? 'text-green-600' : 'text-gray-500'}`}>
                        {wordCount} woorden {wordCount >= 50 && <CheckCircle className="w-4 h-4 inline" />}
                      </span>
                    </div>
                  </div>

                  <button
                    onClick={handleSubmitExplanation}
                    disabled={loading}
                    className="w-full px-6 py-3 bg-gradient-to-r from-blue-500 to-blue-600 text-white font-semibold rounded-xl hover:from-blue-600 hover:to-blue-700 transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    {loading ? (
                      <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <>
                        <Send className="w-5 h-5" />
                        Verstuur voor feedback
                      </>
                    )}
                  </button>
                </div>
              </div>

              {feedback && (
                <div className="bg-white rounded-2xl border border-gray-200 p-6">
                  <h3 className="text-xl font-bold text-gray-900 mb-4">Feedback</h3>
                  <div className="prose max-w-none text-gray-700 whitespace-pre-wrap">
                    {feedback}
                  </div>
                  {retrievedSources.length > 0 && (
                    <div className="mt-6 pt-6 border-t border-gray-200">
                      <div className="flex items-center gap-2 mb-3">
                        <FileText className="w-4 h-4 text-blue-600" />
                        <h4 className="text-sm font-semibold text-gray-900">Gebruikte bronnen uit cursusmateriaal</h4>
                      </div>
                      <div className="space-y-2">
                        {retrievedSources.map((source, index) => (
                          <div key={index} className="flex items-start gap-2 text-sm text-gray-700">
                            <span className="font-medium text-blue-600">[{index + 1}]</span>
                            <span className="flex-1 italic">{source.title}</span>
                            <span className="text-gray-500 text-xs">({(source.similarity * 100).toFixed(0)}% relevant)</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
