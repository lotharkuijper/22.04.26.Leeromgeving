import { CheckCircle2, XCircle, Loader2, BookOpen, Info, ShieldCheck } from 'lucide-react';
import { useRAGStatus } from '../hooks/useRAGStatus';

interface RAGStatusIndicatorProps {
  strictMode?: boolean;
}

export function RAGStatusIndicator({ strictMode = false }: RAGStatusIndicatorProps) {
  const { isAvailable, documentCount, chunkCount, loading, noCourse, noRagFolders } = useRAGStatus();

  const strictBadge = strictMode ? (
    <span
      data-testid="badge-rag-strict-mode"
      title="Strikt brongebruik is actief: de AI beperkt zich tot de cursusdocumenten en geeft geen antwoord buiten die bronnen."
      className="inline-flex items-center gap-1 px-2 py-1 bg-orange-100 text-orange-700 rounded-md text-xs font-semibold cursor-default select-none"
    >
      <ShieldCheck className="w-3.5 h-3.5 flex-shrink-0" />
      Strikt: alleen cursusbronnen
    </span>
  ) : null;

  if (loading) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2 px-3 py-2 bg-gray-100 text-gray-600 rounded-lg text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>RAG status laden...</span>
        </div>
        {strictBadge}
      </div>
    );
  }

  if (noCourse) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2 px-3 py-2 bg-gray-100 text-gray-500 rounded-lg text-sm">
          <BookOpen className="w-4 h-4 flex-shrink-0" />
          <div className="flex flex-col">
            <span className="font-medium">Geen actieve cursus</span>
            <span className="text-xs text-gray-400">Kies een cursus voor RAG-ondersteuning</span>
          </div>
        </div>
        {strictBadge}
      </div>
    );
  }

  if (noRagFolders) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2 px-3 py-2 bg-gray-100 text-gray-500 rounded-lg text-sm">
          <Info className="w-4 h-4 flex-shrink-0" />
          <div className="flex flex-col">
            <span className="font-medium">Geen RAG-bronnen</span>
            <span className="text-xs text-gray-400">Cursus heeft geen RAG-mappen</span>
          </div>
        </div>
        {strictBadge}
      </div>
    );
  }

  if (isAvailable) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2 px-3 py-2 bg-emerald-100 text-emerald-800 rounded-lg text-sm">
          <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
          <div className="flex flex-col">
            <span className="font-medium">RAG beschikbaar</span>
            <span className="text-xs text-emerald-700">
              {documentCount} {documentCount === 1 ? 'document' : 'documenten'} ({chunkCount} chunks)
            </span>
          </div>
        </div>
        {strictBadge}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="flex items-center gap-2 px-3 py-2 bg-amber-100 text-amber-800 rounded-lg text-sm">
        <XCircle className="w-4 h-4 flex-shrink-0" />
        <div className="flex flex-col">
          <span className="font-medium">RAG niet beschikbaar</span>
          <span className="text-xs text-amber-700">
            Upload documenten naar de RAG-map van de cursus
          </span>
        </div>
      </div>
      {strictBadge}
    </div>
  );
}
