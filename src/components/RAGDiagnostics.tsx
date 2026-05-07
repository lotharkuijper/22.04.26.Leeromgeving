interface RAGDiagnosticsProps {
  matchCount: number;
  threshold: number;
  maxSimilarity: number;
  candidatesConsidered?: number;
  searchPerformed?: boolean;
  className?: string;
  viewerRole?: string | null;
}

export function RAGDiagnostics({
  matchCount,
  threshold,
  maxSimilarity,
  candidatesConsidered,
  searchPerformed = true,
  className = '',
  viewerRole,
}: RAGDiagnosticsProps) {
  if (viewerRole === 'student') {
    return null;
  }

  const formatScore = (n: number) => n.toFixed(2);

  if (!searchPerformed) {
    return (
      <div
        className={`text-xs text-gray-500 italic ${className}`}
        data-testid="rag-diagnostics"
      >
        Antwoord zonder cursusmateriaal — geen RAG-zoekopdracht uitgevoerd voor deze vraag.
      </div>
    );
  }

  if (matchCount === 0) {
    if (!candidatesConsidered || candidatesConsidered === 0) {
      return (
        <div
          className={`text-xs text-gray-500 italic ${className}`}
          data-testid="rag-diagnostics"
        >
          Geen passages uit cursusmateriaal gevonden voor deze vraag (drempel {formatScore(threshold)}).
        </div>
      );
    }

    return (
      <div
        className={`text-xs text-gray-500 italic ${className}`}
        data-testid="rag-diagnostics"
      >
        Geen passages boven drempel {formatScore(threshold)}
        {' '}— beste beschikbare match{' '}
        <span className="font-mono">{formatScore(maxSimilarity)}</span>
        {' '}({candidatesConsidered} kandidaten bekeken).
      </div>
    );
  }

  return (
    <div
      className={`text-xs text-gray-500 italic ${className}`}
      data-testid="rag-diagnostics"
    >
      Antwoord gebaseerd op{' '}
      <span className="font-medium">{matchCount}</span>{' '}
      passage{matchCount !== 1 ? 's' : ''} uit cursusmateriaal
      {' '}• hoogste match{' '}
      <span className="font-mono">{formatScore(maxSimilarity)}</span>
      {' '}• drempel{' '}
      <span className="font-mono">{formatScore(threshold)}</span>
    </div>
  );
}
