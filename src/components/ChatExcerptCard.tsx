import { useState } from 'react';
import { Quote, X, Copy, Check } from 'lucide-react';
import { MarkdownMessage } from './MarkdownMessage';
import { type CitationSource } from './CitationText';
import { useLanguage } from '../i18n';
import { openRagDocument } from '../services/rag.service';

// Bijlage-vorm (Task #351): een geciteerd AI-antwoord uit de chat. Spiegelt de
// server-side gevalideerde vorm (sanitizeAttachments in server/studiecafe.js).
export interface AttachmentSource {
  index?: number;
  title: string;
  documentId?: string;
}

export interface ChatExcerptAttachment {
  type: 'chat_excerpt';
  content: string;
  sources?: AttachmentSource[];
  meta?: { module?: string; courseId?: string; capturedAt?: string };
}

interface ChatExcerptCardProps {
  attachment: ChatExcerptAttachment;
  /** Toon een verwijder-knop (alleen in de composer). */
  onRemove?: () => void;
}

// Rendert een geciteerd chat-antwoord als omkaderde kaart: markdown + KaTeX +
// bronvermeldingen. "Open bron" loopt via een geauthenticeerde fetch
// (openRagDocument), zodat de Supabase-token meegaat en de download niet 401't.
export function ChatExcerptCard({ attachment, onRemove }: ChatExcerptCardProps) {
  const { t } = useLanguage();
  const [copied, setCopied] = useState(false);

  const citationSources: CitationSource[] = (attachment.sources ?? []).map((s, i) => ({
    index: typeof s.index === 'number' ? s.index : i + 1,
    title: s.title,
    documentId: s.documentId,
  }));

  const handleOpenSource = (s: CitationSource) => {
    if (s.documentId) openRagDocument(s.documentId).catch(() => { /* stil */ });
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(attachment.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard niet beschikbaar */ }
  };

  return (
    <div
      className="rounded-xl border border-amber-200 bg-amber-50/60 overflow-hidden"
      data-testid="card-chat-excerpt"
    >
      <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-100/70 text-amber-800 text-xs font-semibold">
        <Quote className="w-3.5 h-3.5 shrink-0" />
        <span className="truncate">{t('studiecafe.attachment.chatExcerpt')}</span>
        <div className="ml-auto flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={handleCopy}
            className="p-1 rounded-md text-amber-700 hover:bg-amber-200/70 transition-colors"
            title={t('studiecafe.attachment.copyMarkdown')}
            data-testid="button-copy-attachment"
          >
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
          {onRemove && (
            <button
              type="button"
              onClick={onRemove}
              className="p-1 rounded-md text-amber-700 hover:bg-amber-200/70 transition-colors"
              title={t('studiecafe.attachment.remove')}
              data-testid="button-remove-attachment"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
      <div className="px-3 py-2 bg-white/70">
        <MarkdownMessage
          content={attachment.content}
          sources={citationSources}
          onSourceOpen={handleOpenSource}
          className="prose prose-sm max-w-none text-slate-700 prose-p:my-1.5"
        />
      </div>
    </div>
  );
}
