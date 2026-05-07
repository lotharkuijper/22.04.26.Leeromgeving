import { useState, useEffect } from 'react';
import { CheckCircle, AlertTriangle, XCircle, Info, X } from 'lucide-react';

export type NoticeKind = 'info' | 'warning' | 'error' | 'success';

export interface NoticeData {
  kind: NoticeKind;
  message: string;
}

const STYLES: Record<NoticeKind, { box: string; icon: string }> = {
  info:    { box: 'bg-blue-50 border-blue-200 text-blue-900',       icon: 'text-blue-600' },
  warning: { box: 'bg-yellow-50 border-yellow-200 text-yellow-900', icon: 'text-yellow-600' },
  error:   { box: 'bg-red-50 border-red-200 text-red-900',          icon: 'text-red-600' },
  success: { box: 'bg-emerald-50 border-emerald-200 text-emerald-900', icon: 'text-emerald-600' },
};

function NoticeIcon({ kind, className }: { kind: NoticeKind; className: string }) {
  if (kind === 'success') return <CheckCircle className={className} />;
  if (kind === 'warning') return <AlertTriangle className={className} />;
  if (kind === 'error') return <XCircle className={className} />;
  return <Info className={className} />;
}

interface NoticeBannerProps {
  notice: NoticeData | null;
  onDismiss: () => void;
  className?: string;
}

export function NoticeBanner({ notice, onDismiss, className }: NoticeBannerProps) {
  if (!notice) return null;
  const s = STYLES[notice.kind];
  const isAlert = notice.kind === 'error' || notice.kind === 'warning';
  return (
    <div
      className={`flex items-start gap-3 border rounded-lg p-4 ${s.box} ${className ?? ''}`}
      role={isAlert ? 'alert' : 'status'}
      aria-live={isAlert ? 'assertive' : 'polite'}
      data-testid={`notice-${notice.kind}`}
    >
      <NoticeIcon kind={notice.kind} className={`w-5 h-5 mt-0.5 flex-shrink-0 ${s.icon}`} />
      <p className="flex-1 text-sm whitespace-pre-wrap">{notice.message}</p>
      <button
        type="button"
        onClick={onDismiss}
        className="opacity-70 hover:opacity-100"
        aria-label="Sluit melding"
        data-testid="button-dismiss-notice"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

export function useNotice(autoDismissMs = 6000) {
  const [notice, setNotice] = useState<NoticeData | null>(null);
  useEffect(() => {
    if (!notice) return;
    // Foutmeldingen en waarschuwingen blijven staan tot de gebruiker ze sluit.
    if (notice.kind === 'error' || notice.kind === 'warning') return;
    const timer = window.setTimeout(() => setNotice(null), autoDismissMs);
    return () => window.clearTimeout(timer);
  }, [notice, autoDismissMs]);
  return {
    notice,
    setNotice,
    clearNotice: () => setNotice(null),
  };
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'default';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Bevestigen',
  cancelLabel = 'Annuleren',
  variant = 'default',
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!open) return null;
  const confirmBtnClass =
    variant === 'danger'
      ? 'bg-red-600 hover:bg-red-700'
      : 'bg-blue-600 hover:bg-blue-700';
  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      data-testid="dialog-confirm"
    >
      <div className="bg-white rounded-lg p-6 max-w-md w-full shadow-xl">
        <h3
          id="confirm-dialog-title"
          className="text-lg font-semibold text-gray-900 mb-2"
          data-testid="text-confirm-title"
        >
          {title}
        </h3>
        {description && (
          <p className="text-sm text-gray-600 mb-4 whitespace-pre-wrap" data-testid="text-confirm-description">
            {description}
          </p>
        )}
        <div className="flex gap-3 justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50"
            data-testid="button-confirm-cancel"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`px-4 py-2 text-white font-medium rounded-lg transition-colors disabled:opacity-50 ${confirmBtnClass}`}
            data-testid="button-confirm-ok"
          >
            {busy ? 'Bezig...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
