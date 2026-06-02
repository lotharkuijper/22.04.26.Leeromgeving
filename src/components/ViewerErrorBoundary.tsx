import { Component, type ReactNode } from 'react';
import { AlertCircle, Download, X } from 'lucide-react';
import { openRagDocument } from '../services/rag.service';

interface Props {
  documentId: string;
  lang: 'nl' | 'en';
  onClose: () => void;
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

// Isoleert crashes in de documentviewer (bv. pdf.js-render-fouten) zodat een
// mislukte weergave nooit de hele chatpagina meesleurt. Toont in plaats daarvan
// een nette terugvaloptie met een downloadknop.
export class ViewerErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error('[DocumentViewer] weergave gecrasht:', error);
  }

  componentDidUpdate(prevProps: Props) {
    // Reset de foutstatus wanneer een ander document wordt geopend.
    if (prevProps.documentId !== this.props.documentId && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    const { lang, documentId, onClose } = this.props;
    return (
      <div className="flex h-full flex-col" data-testid="viewer-error-boundary">
        <div className="flex items-center justify-end border-b border-gray-200 px-3 py-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
            title={lang === 'en' ? 'Close viewer' : 'Viewer sluiten'}
            data-testid="btn-viewer-boundary-close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <AlertCircle className="h-8 w-8 text-amber-500" />
          <p className="text-sm text-gray-700">
            {lang === 'en'
              ? 'This document could not be displayed in the viewer.'
              : 'Dit document kon niet in de viewer worden getoond.'}
          </p>
          <button
            type="button"
            onClick={() => openRagDocument(documentId).catch(() => {})}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            data-testid="btn-viewer-boundary-download"
          >
            <Download className="h-4 w-4" />
            {lang === 'en' ? 'Download instead' : 'In plaats daarvan downloaden'}
          </button>
        </div>
      </div>
    );
  }
}
