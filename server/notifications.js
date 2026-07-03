// ───────────────────────────────────────────────────────────────────────────
// Studiecafé-meldingen (Task #311) — buiten-de-app-kanaal voor reacties op je
// eigen thread + nieuwe aankondigingen.
//
// Ontwerp: meldingen worden NIET direct verzonden maar in studiecafe_notifications
// gezet (zie migratie 20260621130000). Een periodieke digest-worker (server/
// index.js) batcht de onverzonden meldingen per gebruiker tot één e-mail, zodat
// een druk gesprek de inbox niet overspoelt. De partiële unieke index op
// dedup_key (WHERE sent_at IS NULL) ontdubbelt al op insert-niveau.
//
// Alle beslissings-/opmaaklogica zit in PURE helpers (geen I/O) zodat ze los
// getest worden in server/__tests__/notifications.test.js. De e-mail-transport
// (Resend) staat onderaan en faalt zacht als er geen sleutel is geconfigureerd.
// ───────────────────────────────────────────────────────────────────────────

import { getDigestStrings } from './notificationI18n.js';

export const NOTIFICATION_KINDS = ['reply', 'announcement'];

export const DEFAULT_NOTIFICATION_PREFS = Object.freeze({
  email_replies: true,
  email_announcements: true,
});

// Maak een ruwe prefs-rij (of null) robuust tot een compleet voorkeur-object.
// Ontbrekend/onbekend ⇒ standaard aan (opt-OUT-model: je krijgt meldingen tenzij
// je ze uitzet).
export function normalizeNotificationPrefs(row) {
  const r = row && typeof row === 'object' ? row : {};
  return {
    email_replies: r.email_replies === false ? false : true,
    email_announcements: r.email_announcements === false ? false : true,
  };
}

// Mag deze gebruiker (gegeven zijn voorkeuren) dit soort melding per e-mail krijgen?
export function prefAllowsKind(prefs, kind) {
  const p = normalizeNotificationPrefs(prefs);
  if (kind === 'reply') return p.email_replies;
  if (kind === 'announcement') return p.email_announcements;
  return false;
}

// Stabiele ontdubbel-sleutel. Eén openstaande melding per (soort, thread,
// ontvanger): meerdere reacties op dezelfde thread vóór de digest draait ⇒ één rij.
export function buildDedupKey(kind, threadId, userId) {
  const k = kind === 'announcement' ? 'announce' : 'reply';
  return `${k}:${threadId || 'none'}:${userId || 'none'}`;
}

// Groepeer onverzonden meldingsrijen per ontvanger (user_id). Behoudt de rijen
// zelf zodat de caller voorkeuren kan toepassen en daarna kan opmaken.
export function groupPendingByUser(rows) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !row.user_id) continue;
    if (!map.has(row.user_id)) map.set(row.user_id, []);
    map.get(row.user_id).push(row);
  }
  return map;
}

// Splits de rijen van één gebruiker in {allowed, suppressed} op basis van zijn
// voorkeuren. Onderdrukte rijen worden in de worker alsnog als verzonden
// gemarkeerd (sent_at) zodat ze niet eindeloos terugkomen.
export function partitionByPrefs(rows, prefs) {
  const allowed = [];
  const suppressed = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (prefAllowsKind(prefs, row && row.kind)) allowed.push(row);
    else suppressed.push(row);
  }
  return { allowed, suppressed };
}

// Bepaal de definitieve aankondiging-doelgroep uit reeds-opgehaalde lijsten.
// Pure (geen I/O) zodat de zichtbaarheidsregel los getest kan worden. Spiegelt
// canAccessCourseContent: een actieve + zichtbare cursus is open voor ÁLLE
// studenten (geen course_members-rij nodig); bij verborgen/inactieve cursussen
// zien alleen ingeschreven leden (course_members) de inhoud, dus krijgen alleen
// zij de aankondiging. De afzender wordt uitgesloten en het geheel gecapt.
export function computeAnnouncementAudience({
  memberIds = [],
  studentIds = [],
  isActive = true,
  studentVisible = true,
  excludeUserId = null,
  max = 5000,
} = {}) {
  const ids = new Set();
  for (const id of Array.isArray(memberIds) ? memberIds : []) if (id) ids.add(id);
  // Actief + zichtbaar ⇒ open voor alle studenten (zichtbaarheids-gebaseerd).
  if (studentVisible !== false && isActive === true) {
    for (const id of Array.isArray(studentIds) ? studentIds : []) if (id) ids.add(id);
  }
  if (excludeUserId) ids.delete(excludeUserId);
  return [...ids].slice(0, max);
}

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Groepeer de meldingen van één gebruiker tot een compacte samenvatting:
//   { replies: [{threadId, title, count}], announcements: [{threadId, title}] }
// Reacties op dezelfde thread tellen op tot één regel ("3 nieuwe reacties in …").
export function summarizeUserNotifications(rows) {
  const replyMap = new Map();
  const announceMap = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const tid = row.thread_id || row.id || 'none';
    const title = (row.thread_title && String(row.thread_title).trim()) || '';
    if (row.kind === 'announcement') {
      if (!announceMap.has(tid)) announceMap.set(tid, { threadId: row.thread_id || null, title });
    } else {
      const cur = replyMap.get(tid);
      if (cur) cur.count += 1;
      else replyMap.set(tid, { threadId: row.thread_id || null, title, count: 1 });
    }
  }
  return { replies: [...replyMap.values()], announcements: [...announceMap.values()] };
}

// Bouw de digest-e-mail voor één gebruiker uit zijn (toegestane) meldingsrijen.
// Geeft { subject, html, text } of null als er niets te melden valt. De teksten
// worden per taal geresolved via getDigestStrings(lang) uit de frontend-locale-
// dictionaries (fallback doeltaal → en → nl), zodat álle 20 talen gelokaliseerde
// e-mails krijgen. De caller kan een vooraf-geresolvede `strings` meegeven om een
// dubbele lookup te vermijden.
export function buildDigestEmail(rows, { userName = '', lang = 'nl', baseUrl = '', strings = null } = {}) {
  const { replies, announcements } = summarizeUserNotifications(rows);
  if (!replies.length && !announcements.length) return null;
  const L = strings || getDigestStrings(lang);

  const replyCount = replies.reduce((s, r) => s + (r.count || 0), 0);
  let subject;
  if (replies.length && announcements.length) subject = L.subjectBoth;
  else if (announcements.length) subject = L.subjectAnnounce(announcements.length);
  else subject = L.subjectReplies(replyCount);

  const link = baseUrl ? `${String(baseUrl).replace(/\/+$/, '')}/studiecafe` : '';

  // Platte-tekst-versie.
  const textLines = [L.greeting(userName), ''];
  if (replies.length) {
    textLines.push(L.repliesHeading + ':');
    for (const r of replies) textLines.push('  • ' + L.replyLine(r.count, r.title || L.untitled));
    textLines.push('');
  }
  if (announcements.length) {
    textLines.push(L.announceHeading + ':');
    for (const a of announcements) textLines.push('  • ' + L.announceLine(a.title || L.untitled));
    textLines.push('');
  }
  if (link) textLines.push(`${L.cta}: ${link}`, '');
  textLines.push(L.footer);
  const text = textLines.join('\n');

  // HTML-versie.
  const parts = [];
  parts.push(`<p>${escapeHtml(L.greeting(userName))}</p>`);
  if (replies.length) {
    parts.push(`<h3 style="margin:16px 0 6px">${escapeHtml(L.repliesHeading)}</h3><ul>`);
    for (const r of replies) parts.push(`<li>${escapeHtml(L.replyLine(r.count, r.title || L.untitled))}</li>`);
    parts.push('</ul>');
  }
  if (announcements.length) {
    parts.push(`<h3 style="margin:16px 0 6px">${escapeHtml(L.announceHeading)}</h3><ul>`);
    for (const a of announcements) parts.push(`<li>${escapeHtml(L.announceLine(a.title || L.untitled))}</li>`);
    parts.push('</ul>');
  }
  if (link) {
    parts.push(
      `<p style="margin:20px 0"><a href="${escapeHtml(link)}" ` +
        `style="background:#f59e0b;color:#fff;padding:10px 18px;border-radius:10px;` +
        `text-decoration:none;font-weight:600;display:inline-block">${escapeHtml(L.cta)}</a></p>`,
    );
  }
  parts.push(`<hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>`);
  parts.push(`<p style="color:#888;font-size:12px">${escapeHtml(L.footer)}</p>`);
  const html = `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:15px;color:#222;line-height:1.5">${parts.join('')}</div>`;

  return { subject, html, text };
}

// ── E-mail-transport (Resend) ───────────────────────────────────────────────
// Haalt de API-sleutel op via de Replit-Resend-connector (indien gekoppeld) en
// valt terug op de RESEND_API_KEY-secret. Faalt ZACHT: zonder sleutel geeft
// getEmailConfig() null terug en blijft de wachtrij staan tot e-mail is
// geconfigureerd. Afzender via NOTIFICATION_FROM_EMAIL (Resend vereist een
// geverifieerd domein; 'onboarding@resend.dev' werkt out-of-the-box voor tests).

async function resolveResendKeyFromConnector() {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  if (!hostname) return null;
  const xReplitToken = process.env.REPL_IDENTITY
    ? 'repl ' + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? 'depl ' + process.env.WEB_REPL_RENEWAL
      : null;
  if (!xReplitToken) return null;
  try {
    const resp = await fetch(
      `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=resend`,
      { headers: { Accept: 'application/json', X_REPLIT_TOKEN: xReplitToken } },
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    const item = data && Array.isArray(data.items) ? data.items[0] : null;
    const s = item && item.settings ? item.settings : null;
    return (s && (s.api_key || s.apiKey)) || null;
  } catch {
    return null;
  }
}

// Geeft { apiKey, from } of null als e-mail niet is geconfigureerd.
export async function getEmailConfig() {
  const apiKey = process.env.RESEND_API_KEY || (await resolveResendKeyFromConnector());
  if (!apiKey) return null;
  const from = process.env.NOTIFICATION_FROM_EMAIL || 'Studiecafé <onboarding@resend.dev>';
  return { apiKey, from };
}

// Verstuur één e-mail via de Resend-REST-API. Geeft { ok, status, error }.
export async function sendEmailViaResend({ apiKey, from, to, subject, html, text }) {
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html, text }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return { ok: false, status: resp.status, error: body || `HTTP ${resp.status}` };
    }
    return { ok: true, status: resp.status };
  } catch (err) {
    return { ok: false, status: 0, error: err && err.message ? err.message : String(err) };
  }
}
