import { useState, useEffect } from 'react';
import { Download, Loader2, CheckCircle, AlertTriangle, XCircle } from 'lucide-react';
import {
  importQuestionsFromShareStats,
  ImportProgress,
  ImportProgressCallback,
} from '../services/sharestats-integration.service';
import { getRepositoryTopics } from '../services/github-parser.service';

export function ShareStatsImportPanel() {
  const [topics, setTopics] = useState<string[]>([]);
  const [selectedTopics, setSelectedTopics] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [result, setResult] = useState<{ imported: number; skipped: number; errors: number } | null>(
    null
  );

  useEffect(() => {
    loadTopics();
  }, []);

  const loadTopics = async () => {
    setLoading(true);
    try {
      const availableTopics = await getRepositoryTopics();
      setTopics(availableTopics);
    } catch (error) {
      console.error('Error loading topics:', error);
      alert('Kon topics niet laden van GitHub');
    }
    setLoading(false);
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

  const handleImport = async () => {
    if (selectedTopics.length === 0) {
      alert('Selecteer minimaal één topic om te importeren');
      return;
    }

    if (
      !confirm(
        `${selectedTopics.length} topic(s) importeren? Dit kan enkele minuten duren. Alleen Nederlandse vragen worden geïmporteerd.`
      )
    ) {
      return;
    }

    setImporting(true);
    setResult(null);
    setProgress(null);

    try {
      const importResult = await importQuestionsFromShareStats(
        'https://github.com/ShareStats/itembank',
        selectedTopics,
        setProgress as ImportProgressCallback
      );
      setResult(importResult);
    } catch (error) {
      console.error('Error importing questions:', error);
      alert('Fout bij importeren: ' + (error instanceof Error ? error.message : 'Onbekende fout'));
    }

    setImporting(false);
  };

  return (
    <div className="space-y-6">
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <div className="flex items-start gap-3">
          <Download className="w-5 h-5 text-blue-700 mt-0.5" />
          <div className="flex-1">
            <h3 className="font-semibold text-gray-900 mb-1">ShareStats Itembank Import</h3>
            <p className="text-sm text-gray-700">
              Importeer quiz vragen uit de ShareStats itembank repository. Alleen vragen in het
              Nederlands worden geïmporteerd. Vragen worden automatisch gevalideerd tegen
              cursusmateriaal.
            </p>
          </div>
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        </div>
      )}

      {!loading && topics.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-gray-900">Selecteer Topics</h3>
            <button
              onClick={handleSelectAll}
              className="text-sm text-blue-600 hover:text-blue-700 font-medium"
            >
              {selectedTopics.length === topics.length ? 'Deselecteer Alles' : 'Selecteer Alles'}
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
            {topics.map((topic) => (
              <label
                key={topic}
                className="flex items-center gap-3 p-3 border border-gray-200 rounded-lg hover:bg-gray-50 cursor-pointer transition-colors"
              >
                <input
                  type="checkbox"
                  checked={selectedTopics.includes(topic)}
                  onChange={() => handleTopicToggle(topic)}
                  className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                />
                <span className="text-sm font-medium text-gray-700">{topic}</span>
              </label>
            ))}
          </div>

          <button
            onClick={handleImport}
            disabled={importing || selectedTopics.length === 0}
            className="w-full px-6 py-3 bg-gradient-to-r from-blue-500 to-blue-600 text-white font-semibold rounded-lg hover:from-blue-600 hover:to-blue-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            <Download className="w-5 h-5" />
            {importing ? 'Importeren...' : `Importeer ${selectedTopics.length} Topic(s)`}
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
            <div className="mt-6 grid grid-cols-3 gap-4">
              <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                <div className="flex items-center gap-2 mb-2">
                  <CheckCircle className="w-5 h-5 text-green-600" />
                  <span className="text-sm font-medium text-green-900">Geïmporteerd</span>
                </div>
                <p className="text-2xl font-bold text-green-900">{result.imported}</p>
              </div>

              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                <div className="flex items-center gap-2 mb-2">
                  <AlertTriangle className="w-5 h-5 text-yellow-600" />
                  <span className="text-sm font-medium text-yellow-900">Overgeslagen</span>
                </div>
                <p className="text-2xl font-bold text-yellow-900">{result.skipped}</p>
              </div>

              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <div className="flex items-center gap-2 mb-2">
                  <XCircle className="w-5 h-5 text-red-600" />
                  <span className="text-sm font-medium text-red-900">Fouten</span>
                </div>
                <p className="text-2xl font-bold text-red-900">{result.errors}</p>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
        <h4 className="font-semibold text-gray-900 mb-2">Over ShareStats Import</h4>
        <ul className="text-sm text-gray-700 space-y-2">
          <li>• Vragen worden opgehaald van github.com/ShareStats/itembank</li>
          <li>• Alleen Nederlandse vragen (taal: nl) worden geïmporteerd</li>
          <li>• Duplicate vragen (op basis van ShareStats ID) worden overgeslagen</li>
          <li>• Elke vraag wordt automatisch gevalideerd tegen cursusmateriaal</li>
          <li>• Metadata zoals instelling, subtopic en Meta-information wordt opgeslagen</li>
        </ul>
      </div>
    </div>
  );
}
