import { FileText } from 'lucide-react';

export interface SourceItem {
  title: string;
  similarity: number;
}

interface SourceListProps {
  sources: SourceItem[];
  label?: string;
}

export function SourceList({ sources, label = 'Gebruikte bronnen uit cursusmateriaal' }: SourceListProps) {
  if (sources.length === 0) return null;

  return (
    <div className="mt-6 pt-6 border-t border-gray-200">
      <div className="flex items-center gap-2 mb-3">
        <FileText className="w-4 h-4 text-blue-600" />
        <h4 className="text-sm font-semibold text-gray-900">{label}</h4>
      </div>
      <div className="space-y-2">
        {sources.map((source, index) => (
          <div key={index} className="flex items-start gap-2 text-sm text-gray-700" data-testid={`source-item-${index}`}>
            <span className="font-medium text-blue-600">[{index + 1}]</span>
            <span className="flex-1 italic">{source.title}</span>
            <span className="text-gray-500 text-xs">({(source.similarity * 100).toFixed(0)}% relevant)</span>
          </div>
        ))}
      </div>
    </div>
  );
}
