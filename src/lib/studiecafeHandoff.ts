import { type ChatExcerptAttachment } from '../components/ChatExcerptCard';

// Overdracht chat → Studiecafé (Task #351). De chat stalt een momentopname van
// het AI-antwoord in sessionStorage; StudiecafePage leest die bij binnenkomst
// uit, opent de composer met de juiste categorie en de bijlage. sessionStorage
// (niet de URL) omdat de inhoud markdown/KaTeX bevat en te groot/gevoelig is
// voor een query-string.
const KEY = 'leapvu:studiecafe-handoff';

export interface StudiecafeHandoff {
  v: 1;
  courseId: string | null;
  category: string;
  attachment: ChatExcerptAttachment;
  // 'thread' (standaard): open de nieuwe-thread-composer met de bijlage.
  // 'reply': de student wil het antwoord als reactie in een bestaand topic
  // plaatsen — StudiecafePage toont een kies-een-topic-banner en laadt de
  // bijlage in de reply-composer van de gekozen thread.
  mode?: 'thread' | 'reply';
}

export function stashStudiecafeHandoff(h: StudiecafeHandoff): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(h));
  } catch { /* sessionStorage niet beschikbaar */ }
}

// Leest én verwijdert de overdracht (eenmalig). Geeft null als er niets (geldigs) staat.
export function takeStudiecafeHandoff(): StudiecafeHandoff | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    sessionStorage.removeItem(KEY);
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== 1 || !parsed.attachment || parsed.attachment.type !== 'chat_excerpt') {
      return null;
    }
    return parsed as StudiecafeHandoff;
  } catch {
    return null;
  }
}
