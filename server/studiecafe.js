// ───────────────────────────────────────────────────────────────────────────
// Studiecafé (Task #304) — per-cursus discussieforum.
//
// Alle schrijfacties lopen hier server-side via de service-role (supabaseAdmin),
// die RLS omzeilt. De poortwachters zijn:
//   - userHasCourseAccess(user, profile, courseId)  → mag lezen/posten in deze cursus?
//   - isStaffForCourse(user, profile, courseId)      → docent/admin van deze cursus?
// Studenten hebben vaak GEEN course_members-rij (zichtbaarheids-gebaseerde
// toegang), dus we gaten NOOIT op lidmaatschap. Elke mutatie verifieert daarnaast
// dat de doel-rij dezelfde course_id heeft als de :courseId in het pad, zodat een
// gelekt id uit een andere cursus niet te misbruiken is.
//
// De pure helpers onderaan (validatie, reactie-toggle, permissie-predicaten)
// bevatten alle beslissingslogica en worden los getest in
// server/__tests__/studiecafe.test.js.
// ───────────────────────────────────────────────────────────────────────────

import {
  buildDedupKey,
  normalizeNotificationPrefs,
  computeAnnouncementAudience,
  DEFAULT_NOTIFICATION_PREFS,
} from './notifications.js';

export const STUDIECAFE_CATEGORIES = ['vraag', 'discussie', 'samenwerken', 'check-llm'];
// Bewuste allowlist: voorkomt willekeurige/agressieve emoji-payloads.
export const ALLOWED_REACTION_EMOJI = ['👍', '❤️', '🎉', '🤔', '✅', '🙌'];
export const MAX_TITLE_LEN = 200;
export const MAX_BODY_LEN = 8000;
export const MAX_REACTION_USERS = 1000; // cap per emoji-array

// Bijlagen (Task #351): geciteerde fragmenten, bijv. een AI-antwoord uit de chat.
export const ATTACHMENT_TYPES = ['chat_excerpt'];
export const MAX_ATTACHMENTS = 3;
export const MAX_ATTACHMENT_CONTENT_LEN = 12000;
export const MAX_ATTACHMENT_SOURCES = 12;
export const MAX_ATTACHMENT_TITLE_LEN = 300;
export const MAX_ATTACHMENT_DOCUMENT_ID_LEN = 200;
export const MAX_ATTACHMENT_MODULE_LEN = 40;
export const MAX_ATTACHMENT_COURSE_ID_LEN = 64;

export function sanitizeCategory(cat) {
  return STUDIECAFE_CATEGORIES.includes(cat) ? cat : 'vraag';
}

// Maakt één bronvermelding schoon: index (1-based int), title (verplicht),
// optioneel documentId. Onbekende velden worden weggegooid. Geeft null bij ongeldig.
function sanitizeAttachmentSource(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, MAX_ATTACHMENT_TITLE_LEN) : '';
  if (!title) return null;
  const out = { title };
  const idx = Number(raw.index);
  if (Number.isFinite(idx) && idx >= 1 && idx <= 999) out.index = Math.floor(idx);
  if (typeof raw.documentId === 'string' && raw.documentId.trim()) {
    out.documentId = raw.documentId.trim().slice(0, MAX_ATTACHMENT_DOCUMENT_ID_LEN);
  }
  return out;
}

// Maakt één bijlage schoon. Alleen bekende types met niet-lege content overleven;
// content + bronnen worden begrensd. Geeft null bij ongeldig.
function sanitizeAttachmentItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = typeof raw.type === 'string' ? raw.type : '';
  if (!ATTACHMENT_TYPES.includes(type)) return null;
  const content = typeof raw.content === 'string' ? raw.content.trim().slice(0, MAX_ATTACHMENT_CONTENT_LEN) : '';
  if (!content) return null;
  const sourcesRaw = Array.isArray(raw.sources) ? raw.sources : [];
  const sources = sourcesRaw
    .slice(0, MAX_ATTACHMENT_SOURCES)
    .map(sanitizeAttachmentSource)
    .filter(Boolean);
  const item = { type, content };
  if (sources.length) item.sources = sources;
  // Herkomst-metadata (Task #351): module + cursus + tijdstip waarop het fragment
  // is geciteerd. Alles tolerant + begrensd; ongeldige velden worden weggegooid.
  const meta = {};
  const module = raw?.meta?.module;
  if (typeof module === 'string' && module.trim()) {
    meta.module = module.trim().slice(0, MAX_ATTACHMENT_MODULE_LEN);
  }
  const courseId = raw?.meta?.courseId;
  if (typeof courseId === 'string' && courseId.trim()) {
    meta.courseId = courseId.trim().slice(0, MAX_ATTACHMENT_COURSE_ID_LEN);
  }
  const capturedAt = raw?.meta?.capturedAt;
  if (typeof capturedAt === 'string' && capturedAt.trim()) {
    const d = new Date(capturedAt.trim());
    if (!Number.isNaN(d.getTime())) meta.capturedAt = d.toISOString();
  }
  if (Object.keys(meta).length) item.meta = meta;
  return item;
}

// Valideert + begrenst de bijlagen-array van een thread/reply. Tolerant: ongeldige
// items worden stil weggegooid; geeft altijd een (mogelijk lege) array terug.
export function sanitizeAttachments(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, MAX_ATTACHMENTS)
    .map(sanitizeAttachmentItem)
    .filter(Boolean);
}

export function validateThreadInput({ title, body } = {}) {
  const t = typeof title === 'string' ? title.trim() : '';
  const b = typeof body === 'string' ? body.trim() : '';
  if (!t) return { ok: false, error: 'Titel is verplicht' };
  if (t.length > MAX_TITLE_LEN) return { ok: false, error: `Titel mag maximaal ${MAX_TITLE_LEN} tekens zijn` };
  if (!b) return { ok: false, error: 'Bericht is verplicht' };
  if (b.length > MAX_BODY_LEN) return { ok: false, error: `Bericht mag maximaal ${MAX_BODY_LEN} tekens zijn` };
  return { ok: true, value: { title: t, body: b } };
}

export function validateReplyInput({ body } = {}) {
  const b = typeof body === 'string' ? body.trim() : '';
  if (!b) return { ok: false, error: 'Bericht is verplicht' };
  if (b.length > MAX_BODY_LEN) return { ok: false, error: `Bericht mag maximaal ${MAX_BODY_LEN} tekens zijn` };
  return { ok: true, value: { body: b } };
}

export function isAllowedEmoji(emoji) {
  return ALLOWED_REACTION_EMOJI.includes(emoji);
}

// Normaliseer een ruw reactions-object: enkel toegestane emoji, unieke string-
// user-ids, gecapt, en lege arrays verwijderd. Defensief tegen rommel uit de DB.
export function normalizeReactions(reactions) {
  const out = {};
  if (!reactions || typeof reactions !== 'object') return out;
  for (const emoji of ALLOWED_REACTION_EMOJI) {
    const arr = reactions[emoji];
    if (Array.isArray(arr)) {
      const uniq = [...new Set(arr.filter((x) => typeof x === 'string' && x))].slice(0, MAX_REACTION_USERS);
      if (uniq.length) out[emoji] = uniq;
    }
  }
  return out;
}

// Toggle userId op emoji → nieuw genormaliseerd reactions-object. null als de
// emoji niet is toegestaan of userId ontbreekt (caller geeft dan 400).
export function toggleReaction(reactions, emoji, userId) {
  if (!isAllowedEmoji(emoji) || !userId) return null;
  const base = normalizeReactions(reactions);
  const arr = base[emoji] ? [...base[emoji]] : [];
  const idx = arr.indexOf(userId);
  if (idx >= 0) arr.splice(idx, 1);
  else arr.push(userId);
  if (arr.length) base[emoji] = arr.slice(0, MAX_REACTION_USERS);
  else delete base[emoji];
  return base;
}

// Samenvatting voor één lezer: [{emoji, count, mine}] in allowlist-volgorde,
// alleen niet-lege reacties.
export function summarizeReactions(reactions, userId) {
  const norm = normalizeReactions(reactions);
  const out = [];
  for (const emoji of ALLOWED_REACTION_EMOJI) {
    const arr = norm[emoji];
    if (arr && arr.length) {
      out.push({ emoji, count: arr.length, mine: !!userId && arr.includes(userId) });
    }
  }
  return out;
}

// Tabellen waarop een reactie-toggle is toegestaan. Gebruikt om de tabelnaam
// te valideren vóór ze in een SQL-string wordt geïnterpoleerd (de naam komt uit
// een server-side ternary, maar we whitelisten defensief tegen injectie).
export const REACTION_TABLES = ['studiecafe_threads', 'studiecafe_replies'];

// Race-veilige reactie-toggle via pgPool. Het oorspronkelijke pad las eerst de
// reactions-jsonb, berekende de nieuwe waarde in JS en schreef terug; bij twee
// gelijktijdige reacties op dezelfde post overschreef de tweede write de eerste,
// waardoor een reactie stil verloren ging. Hier serialiseren we per rij met
// `SELECT ... FOR UPDATE` binnen één transactie zodat de read-modify-write
// atomair is. De allowlist/dedupe/cap-logica blijft in de pure `toggleReaction`.
// Retourneert { next } bij succes, { notFound } of { invalid } anders.
export async function toggleReactionAtomicPg({ pgPool, table, targetId, courseId, emoji, userId }) {
  if (!REACTION_TABLES.includes(table)) return { invalid: true };
  if (!isAllowedEmoji(emoji) || !userId) return { invalid: true };
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    const sel = await client.query(
      `SELECT course_id, reactions, deleted_at FROM ${table} WHERE id = $1 FOR UPDATE`,
      [targetId],
    );
    const row = sel.rows[0];
    if (!row || row.course_id !== courseId || row.deleted_at) {
      await client.query('ROLLBACK');
      return { notFound: true };
    }
    const next = toggleReaction(row.reactions, emoji, userId);
    if (!next) {
      await client.query('ROLLBACK');
      return { invalid: true };
    }
    await client.query(
      `UPDATE ${table} SET reactions = $2::jsonb WHERE id = $1`,
      [targetId, JSON.stringify(next)],
    );
    await client.query('COMMIT');
    return { next };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ── Ongelezen-indicator (Task #307) ─────────────────────────────────────────
// Pure helper: telt threads met activiteit ná het laatste bezoek. lastSeenAt null
// (nog nooit geopend) ⇒ géén ongelezen (zachte uitrol: geen badge-vloed voor oude
// content). Splitst aankondigingen apart zodat de UI die kan benadrukken.
export function summarizeUnread(threads, lastSeenAt) {
  const out = { count: 0, announcementCount: 0, latestActivityAt: null };
  if (!Array.isArray(threads)) return out;
  for (const th of threads) {
    const act = th && th.last_activity_at;
    if (!act) continue;
    if (!out.latestActivityAt || act > out.latestActivityAt) out.latestActivityAt = act;
    if (!lastSeenAt) continue;
    if (act > lastSeenAt) {
      out.count += 1;
      if (th.is_announcement) out.announcementCount += 1;
    }
  }
  return out;
}

// Is één thread ongelezen voor deze lezer? lastSeenAt null ⇒ nooit ongelezen.
export function isThreadUnread(lastActivityAt, lastSeenAt) {
  if (!lastActivityAt || !lastSeenAt) return false;
  return lastActivityAt > lastSeenAt;
}

// Race-veilige pluim (kudos)-toggle via pgPool. Net als bij reacties las het
// oorspronkelijke pad eerst `kudos_at`, besloot in JS geven/verwijderen en
// schreef terug; twee gelijktijdige toggles op dezelfde post konden elkaars
// write overschrijven. Hier serialiseren we per rij met `SELECT ... FOR UPDATE`
// binnen één transactie. Retourneert { giving, by, at } bij succes (with by/at
// null wanneer de pluim is weggehaald) of { notFound } anders.
export async function toggleKudosAtomicPg({ pgPool, table, targetId, courseId, userId, ts }) {
  if (!REACTION_TABLES.includes(table)) return { invalid: true };
  if (!userId) return { invalid: true };
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    const sel = await client.query(
      `SELECT course_id, kudos_at, deleted_at FROM ${table} WHERE id = $1 FOR UPDATE`,
      [targetId],
    );
    const row = sel.rows[0];
    if (!row || row.course_id !== courseId || row.deleted_at) {
      await client.query('ROLLBACK');
      return { notFound: true };
    }
    const giving = !row.kudos_at;
    const by = giving ? userId : null;
    const at = giving ? ts : null;
    await client.query(
      `UPDATE ${table} SET kudos_by = $2, kudos_at = $3 WHERE id = $1`,
      [targetId, by, at],
    );
    await client.query('COMMIT');
    return { giving, by, at };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ── Per-thread ongelezen-indicator (Task #312/#327) ─────────────────────────
// Een thread is ongelezen voor deze lezer wanneer zijn laatste activiteit ná de
// zachte-uitrol-vloer (per-cursus last_seen) ligt ÉN de lezer hem sindsdien niet
// heeft geopend: geen read-rij, of de read is ouder dan de laatste activiteit.
//   manualUnread true (bewust ongelezen)      ⇒ ALTIJD ongelezen (omzeilt de vloer).
//   floorAt null  (cursus nooit bezocht)      ⇒ niets ongelezen (zachte uitrol).
//   activiteit ≤ floorAt (vóór eerste bezoek) ⇒ gelezen (backlog onderdrukt).
//   threadReadAt ≥ activiteit (geopend)       ⇒ gelezen.
// Task #327: de manualUnread-marker laat een student ELK gesprek (ook backlog vóór
// de vloer) weer als "nieuw" tonen; hij omzeilt daarom de vloer- en read-checks.
export function isThreadUnreadFor(lastActivityAt, floorAt, threadReadAt, manualUnread) {
  if (!lastActivityAt) return false;
  if (manualUnread) return true;
  if (!floorAt) return false;
  if (lastActivityAt <= floorAt) return false;
  if (threadReadAt && lastActivityAt <= threadReadAt) return false;
  return true;
}

// Tel ongelezen threads voor de nav-badge met per-thread leesstatus. readMap mag
// een Map of een plain object (thread_id → read_at ISO) zijn. Splitst
// aankondigingen apart zodat de UI die kan benadrukken.
// manualUnreadSet (Task #327): optionele Set/array van thread-ids die de lezer
// bewust weer als ongelezen heeft gemarkeerd; die tellen altijd mee, ook backlog.
export function summarizeUnreadThreads(threads, floorAt, readMap, manualUnreadSet) {
  const out = { count: 0, announcementCount: 0, latestActivityAt: null };
  if (!Array.isArray(threads)) return out;
  const reads = readMap instanceof Map ? readMap : new Map(Object.entries(readMap || {}));
  const manual = manualUnreadSet instanceof Set ? manualUnreadSet : new Set(manualUnreadSet || []);
  for (const th of threads) {
    const act = th && th.last_activity_at;
    if (!act) continue;
    if (!out.latestActivityAt || act > out.latestActivityAt) out.latestActivityAt = act;
    const readAt = th.id ? reads.get(th.id) || null : null;
    const isManual = th.id ? manual.has(th.id) : false;
    if (isThreadUnreadFor(act, floorAt, readAt, isManual)) {
      out.count += 1;
      if (th.is_announcement) out.announcementCount += 1;
    }
  }
  return out;
}

// ── Permissie-predicaten ────────────────────────────────────────────────────
// Modereren (pinnen, sluiten, aankondigen, pluim) = alleen staff van de cursus.
export function canModerate({ isStaff } = {}) { return !!isStaff; }
// Verwijderen van een post = auteur of staff.
export function canDeletePost({ isStaff, isAuthor } = {}) { return !!isStaff || !!isAuthor; }
// Bewerken van een post (titel/body/categorie) = auteur of staff.
export function canEditPost({ isStaff, isAuthor } = {}) { return !!isStaff || !!isAuthor; }
// "Opgelost"-markering = auteur (eigen vraag) of staff.
export function canSetResolved({ isStaff, isAuthor } = {}) { return !!isStaff || !!isAuthor; }
// Reageren op een gesloten thread mag alleen staff; open threads iedereen.
export function canReplyToThread({ isStaff, isLocked } = {}) { return !!isStaff || !isLocked; }

// Velden voor een soft-delete-redactie. We behouden ALLEEN deleted_at/deleted_by
// (audit) en wissen alle student-zichtbare inhoud (body/auteur/kudos/reacties; voor
// threads ook de titel). Cruciaal: de SELECT-RLS laat cursusgenoten de rij én de
// realtime UPDATE-payload direct lezen, dus zonder deze redactie zou verwijderde
// inhoud buiten de server om lekken. isThread voegt title='' + updated_at toe.
export function buildSoftDeleteRedaction({ ts, userId, isThread } = {}) {
  const fields = {
    deleted_at: ts,
    deleted_by: userId,
    body: '',
    author_id: null,
    kudos_by: null,
    kudos_at: null,
    reactions: {},
  };
  if (isThread) {
    fields.title = '';
    fields.updated_at = ts;
  }
  return fields;
}

// ── Opruimen van wees-toegangsrijen (Task #323 + #325) ──────────────────────
// Toegang tot een cursus is ZICHTBAARHEIDS-gebaseerd (zie userHasCourseAccess /
// canAccessCourseContent), niet membership-gebaseerd. Daardoor blijven per-
// (gebruiker, cursus)-rijen achter wanneer een student de toegang verliest
// ZONDER dat de cursus wordt verwijderd (de ON DELETE CASCADE op course_id dekt
// alleen echte cursus-verwijdering). Concreet verliest een student toegang als:
//   - de cursus verborgen wordt (student_visible=false) → alleen docenten houden
//     toegang;
//   - de cursus gearchiveerd wordt (is_active=false) → alleen leden + docenten.
// Een actieve, zichtbare cursus is open voor iedereen, dus daar wordt nooit iets
// opgeruimd. Deze SQL spiegelt canAccessCourseContent exact en verwijdert elke
// rij waarvan de gebruiker geen toegang meer heeft. Admins/superuser houden
// altijd toegang en worden nooit opgeruimd.
//
// Geldt voor meerdere tabellen met dezelfde (user_id, course_id)-vorm:
//   - studiecafe_thread_reads (per-thread leesmarkeringen, Task #323);
//   - studiecafe_last_seen    (per-cursus zachte-uitrol-vloer, Task #325);
//   - student_course_levels   (zelf-ingesteld leerniveau per cursus, Task #296).
// Alle laten wees-rijen achter bij toegangsverlies; dezelfde regels gelden.
//
// `hasStudentVisible` schakelt de student_visible-tak uit op een oude DB zonder
// die kolom (dan geldt elke cursus als zichtbaar → enkel de archief-regel telt).
// $1 = superuser-e-mailadres.
export const ORPHAN_CLEANUP_TABLES = [
  'studiecafe_thread_reads',
  'studiecafe_last_seen',
  'student_course_levels',
];

export function buildOrphanCourseAccessCleanupSql(table, hasStudentVisible = true) {
  // Whitelist de tabelnaam vóór interpolatie (defensief tegen injectie, ook al
  // komt de naam uit een server-side constante).
  if (!ORPHAN_CLEANUP_TABLES.includes(table)) {
    throw new Error(`buildOrphanCourseAccessCleanupSql: ongeldige tabel "${table}"`);
  }
  const notAdmin = `NOT EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = r.user_id AND (p.role = 'admin' OR p.email = $1)
    )`;
  if (!hasStudentVisible) {
    // Zonder student_visible: alleen gearchiveerde cursussen ruimen op; leden
    // (incl. docenten) houden toegang.
    return `DELETE FROM ${table} r
  USING courses c
  WHERE r.course_id = c.id
    AND c.is_active = false
    AND ${notAdmin}
    AND NOT EXISTS (
      SELECT 1 FROM course_members m
      WHERE m.course_id = c.id AND m.user_id = r.user_id
    )`;
  }
  return `DELETE FROM ${table} r
  USING courses c
  WHERE r.course_id = c.id
    AND (c.student_visible = false OR c.is_active = false)
    AND ${notAdmin}
    AND NOT EXISTS (
      SELECT 1 FROM course_members m
      WHERE m.course_id = c.id AND m.user_id = r.user_id
        AND (
          (c.student_visible = false AND m.member_role = 'teacher')
          OR (c.student_visible IS DISTINCT FROM false AND c.is_active = false)
        )
    )`;
}

// Backwards-compat wrapper voor de oorspronkelijke thread_reads-opruimer.
export function buildOrphanThreadReadsCleanupSql(hasStudentVisible = true) {
  return buildOrphanCourseAccessCleanupSql('studiecafe_thread_reads', hasStudentVisible);
}

// Ruim één tabel op via een geïnjecteerde `pgPool`. Retourneert het aantal
// verwijderde rijen, of `null` als de tabel (nog) niet bestaat / niet kon worden
// opgeruimd. De fallback-logica zit hier zodat ze los van de module-state in
// server/index.js getest kan worden:
//   • 42703 (kolom student_visible ontbreekt) → opnieuw met de kolomloze SQL;
//   • 42P01 (tabel ontbreekt, ook na fallback) → stil `null` (geen fout);
//   • elke andere fout → waarschuwen + `null` (breekt de andere tabellen niet af).
export async function cleanupOrphanCourseAccessTableOnce({
  pgPool,
  table,
  hasStudentVisible,
  superuserEmail,
  logger = console,
} = {}) {
  let result;
  try {
    result = await pgPool.query(
      buildOrphanCourseAccessCleanupSql(table, hasStudentVisible),
      [superuserEmail],
    );
  } catch (err) {
    // 42P01 = tabel ontbreekt (oude DB); 42703 = student_visible-kolom ontbreekt
    // toch → val terug op de variant zonder die kolom.
    if (err && err.code === '42703') {
      try {
        result = await pgPool.query(
          buildOrphanCourseAccessCleanupSql(table, false),
          [superuserEmail],
        );
      } catch (err2) {
        if (err2 && err2.code === '42P01') return null;
        logger.warn?.(`[studiecafe-reads-cleanup] fallback (${table}) mislukt:`, err2.message);
        return null;
      }
    } else {
      if (err && err.code === '42P01') return null;
      logger.warn?.(`[studiecafe-reads-cleanup] (${table}) mislukt:`, err.message);
      return null;
    }
  }
  return result && typeof result.rowCount === 'number' ? result.rowCount : 0;
}

// Per-tabel log-labels (na het `[studiecafe-reads-cleanup] `-prefix) voor de
// standaard set wees-opruim-tabellen.
export const ORPHAN_CLEANUP_TABLE_LABELS = [
  { name: 'studiecafe_thread_reads', label: (n) => `${n} wees-leesmarkering(en) opgeruimd (toegang verlopen).` },
  { name: 'studiecafe_last_seen', label: (n) => `${n} wees-'laatst gezien'-rij(en) opgeruimd (toegang verlopen).` },
  { name: 'student_course_levels', label: (n) => `${n} wees-leerniveau-rij(en) opgeruimd (toegang verlopen).` },
];

// Bouwt een injecteerbare opruim-runner met een eigen overlap-gate. De pgPool,
// hasStudentVisible en superuserEmail worden via getters geleverd zodat de runner
// altijd de actuele module-state van server/index.js leest (die wijzigt na
// startup-detectie). Zonder pgPool: stil no-op. Een lopende run blokkeert een
// tweede gelijktijdige run (`isRunning()` exposeert de gate voor tests).
export function createOrphanCourseAccessCleanupRunner({
  getPgPool,
  getHasStudentVisible,
  getSuperuserEmail,
  tables = ORPHAN_CLEANUP_TABLE_LABELS,
  logger = console,
} = {}) {
  let running = false;
  async function runOnce() {
    if (running) return;
    const pgPool = getPgPool?.();
    if (!pgPool) return; // zonder directe Postgres-verbinding: niets te doen
    running = true;
    try {
      const hasStudentVisible = !!getHasStudentVisible?.();
      const superuserEmail = getSuperuserEmail?.();
      for (const t of tables) {
        const count = await cleanupOrphanCourseAccessTableOnce({
          pgPool,
          table: t.name,
          hasStudentVisible,
          superuserEmail,
          logger,
        });
        if (count > 0) {
          logger.log?.(`[studiecafe-reads-cleanup] ${t.label(count)}`);
        }
      }
    } finally {
      running = false;
    }
  }
  runOnce.isRunning = () => running;
  return runOnce;
}

// Standaard-startvertraging: éénmaal kort na startup draaien (10s) en daarna op
// interval. Apart benoemd zodat de wiring testbaar is met nep-timers.
export const ORPHAN_CLEANUP_STARTUP_DELAY_MS = 10000;

// Plant de periodieke opruim-cyclus: éénmaal na `startupDelayMs` en daarna elke
// `intervalMs`. De overlap-gate van `runOnce` zorgt dat een nog-lopende run niet
// opnieuw wordt gestart wanneer de volgende tik valt (langzame run > interval →
// geen tweede gelijktijdige run). De timer-functies zijn injecteerbaar zodat
// tests met nep-timers de wiring (startvertraging + interval) end-to-end kunnen
// uitoefenen, niet alleen de kale `runOnce`-closure. Beide timers worden ge-unref't
// zodat ze het proces niet levend houden. Retourneert de timers zodat de aanroeper
// (of een test) ze kan opruimen.
export function scheduleOrphanCourseAccessCleanup({
  runOnce,
  startupDelayMs = ORPHAN_CLEANUP_STARTUP_DELAY_MS,
  intervalMs,
  onError = (e) => console.warn('[studiecafe-reads-cleanup] cyclus mislukt:', e?.message ?? e),
  setTimeoutFn = setTimeout,
  setIntervalFn = setInterval,
} = {}) {
  const tick = () => {
    try {
      Promise.resolve(runOnce()).catch(onError);
    } catch (e) {
      onError(e);
    }
  };
  const startupTimer = setTimeoutFn(tick, startupDelayMs);
  startupTimer?.unref?.();
  const intervalTimer = setIntervalFn(tick, intervalMs);
  intervalTimer?.unref?.();
  return { startupTimer, intervalTimer };
}

// ── Route-registratie ───────────────────────────────────────────────────────
export function registerStudiecafeRoutes(app, deps) {
  const {
    supabaseAdmin,
    requireAuthUser,
    userHasCourseAccess,
    isStaffForCourse,
    pgPool,
  } = deps;

  // ── Meldingen (Task #311) ─────────────────────────────────────────────────
  // Zet meldingen in studiecafe_notifications; de digest-worker (server/index.js)
  // batcht ze later tot één e-mail per gebruiker. Best-effort: een falende enqueue
  // mag NOOIT de hoofd-actie (reactie/thread plaatsen) breken. Ontdubbeling via de
  // partiële unieke index op dedup_key (WHERE sent_at IS NULL): zolang er nog een
  // onverzonden melding voor dezelfde (ontvanger, thread, soort) staat, voegen we
  // er geen extra bij — zo overspoelt een druk gesprek de inbox niet.
  const MAX_ANNOUNCE_AUDIENCE = 5000;
  const ENQUEUE_CHUNK = 500; // rijen per bulk-insert (8 params/rij, ruim onder de pg-limiet)

  // Bulk-insert van meldingen in één multi-row statement per chunk (i.p.v. één
  // query per ontvanger), zodat een aankondiging met een grote doelgroep snel
  // wegschrijft. Ontdubbeling via de partiële unieke index op dedup_key.
  async function enqueueNotifications(items) {
    if (!Array.isArray(items) || !items.length) return;
    const rows = items
      .filter((it) => it && it.userId && it.courseId && it.kind)
      .map((it) => ({
        user_id: it.userId,
        course_id: it.courseId,
        kind: it.kind,
        thread_id: it.threadId || null,
        reply_id: it.replyId || null,
        actor_id: it.actorId || null,
        thread_title: it.threadTitle || null,
        dedup_key: buildDedupKey(it.kind, it.threadId, it.userId),
      }));
    if (!rows.length) return;
    try {
      for (let i = 0; i < rows.length; i += ENQUEUE_CHUNK) {
        const chunk = rows.slice(i, i + ENQUEUE_CHUNK);
        if (pgPool) {
          const params = [];
          const valueGroups = chunk.map((r) => {
            const base = params.length;
            params.push(r.user_id, r.course_id, r.kind, r.thread_id, r.reply_id, r.actor_id, r.thread_title, r.dedup_key);
            return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8})`;
          });
          await pgPool
            .query(
              `INSERT INTO studiecafe_notifications
                 (user_id, course_id, kind, thread_id, reply_id, actor_id, thread_title, dedup_key)
               VALUES ${valueGroups.join(',')}
               ON CONFLICT (dedup_key) WHERE sent_at IS NULL DO NOTHING`,
              params,
            )
            .catch((e) => console.warn('[studiecafe] enqueue melding (bulk) mislukt:', e.message));
        } else {
          // Fallback zonder pgPool (bv. testomgeving): best-effort insert zonder de
          // partiële-index-ontdubbeling (die kan PostgREST niet uitdrukken).
          await supabaseAdmin
            .from('studiecafe_notifications')
            .insert(chunk)
            .then(({ error }) => {
              if (error) console.warn('[studiecafe] enqueue melding (fallback) mislukt:', error.message);
            });
        }
      }
    } catch (e) {
      console.warn('[studiecafe] enqueue melding onverwacht:', e.message);
    }
  }

  // Bepaal de doelgroep voor een aankondiging volgens het ZICHTBAARHEIDS-model
  // (zie canAccessCourseContent): een actieve + zichtbare cursus is open voor
  // ÁLLE studenten (de meesten hebben géén course_members-rij), dus die krijgen
  // állemaal de aankondiging. Bij een verborgen of inactieve cursus zien alleen
  // ingeschreven leden de inhoud, dus beperken we de doelgroep tot course_members.
  // De afzender wordt uitgesloten; het geheel wordt gecapt op MAX_ANNOUNCE_AUDIENCE.
  async function announcementAudience(courseId, excludeUserId) {
    // Cursus-status (defensief: student_visible kan ontbreken op een oude DB).
    let isActive = true;
    let studentVisible = true;
    try {
      const { data: course } = await supabaseAdmin
        .from('courses')
        .select('*')
        .eq('id', courseId)
        .maybeSingle();
      if (course) {
        if (typeof course.is_active === 'boolean') isActive = course.is_active;
        if (typeof course.student_visible === 'boolean') studentVisible = course.student_visible;
      }
    } catch (e) {
      console.warn('[studiecafe] aankondiging-doelgroep (cursus) mislukt:', e.message);
    }

    // Ingeschreven leden (docenten + expliciet toegevoegde studenten).
    const memberIds = [];
    try {
      const { data: members } = await supabaseAdmin
        .from('course_members')
        .select('user_id')
        .eq('course_id', courseId);
      for (const r of members || []) if (r.user_id) memberIds.push(r.user_id);
    } catch (e) {
      console.warn('[studiecafe] aankondiging-doelgroep (members) mislukt:', e.message);
    }

    // Alle studenten — alleen relevant als de cursus open is (actief + zichtbaar).
    const studentIds = [];
    if (studentVisible !== false && isActive === true) {
      try {
        const { data: students } = await supabaseAdmin
          .from('profiles')
          .select('id')
          .eq('role', 'student')
          .limit(MAX_ANNOUNCE_AUDIENCE);
        for (const r of students || []) if (r.id) studentIds.push(r.id);
      } catch (e) {
        console.warn('[studiecafe] aankondiging-doelgroep (studenten) mislukt:', e.message);
      }
    }

    return computeAnnouncementAudience({
      memberIds,
      studentIds,
      isActive,
      studentVisible,
      excludeUserId,
      max: MAX_ANNOUNCE_AUDIENCE,
    });
  }

  async function enqueueAnnouncement({ courseId, threadId, title, actorId }) {
    const audience = await announcementAudience(courseId, actorId);
    if (!audience.length) return;
    await enqueueNotifications(
      audience.map((userId) => ({
        userId,
        courseId,
        kind: 'announcement',
        threadId,
        actorId,
        threadTitle: title,
      })),
    );
  }

  // GET/PATCH meldingsvoorkeuren (per gebruiker, niet cursus-gebonden). Bewust
  // vóór de :courseId-routes geregistreerd zodat 'notification-prefs' niet als
  // courseId wordt opgevat.
  app.get('/api/studiecafe/notification-prefs', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    try {
      const { data } = await supabaseAdmin
        .from('studiecafe_notification_prefs')
        .select('email_replies, email_announcements')
        .eq('user_id', auth.user.id)
        .maybeSingle();
      return res.json(normalizeNotificationPrefs(data));
    } catch {
      return res.json(DEFAULT_NOTIFICATION_PREFS);
    }
  });

  app.patch('/api/studiecafe/notification-prefs', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const b = req.body || {};
    const update = { user_id: auth.user.id, updated_at: new Date().toISOString() };
    if (typeof b.emailReplies === 'boolean') update.email_replies = b.emailReplies;
    if (typeof b.emailAnnouncements === 'boolean') update.email_announcements = b.emailAnnouncements;
    try {
      const { data, error } = await supabaseAdmin
        .from('studiecafe_notification_prefs')
        .upsert(update, { onConflict: 'user_id' })
        .select('email_replies, email_announcements')
        .single();
      if (error) {
        console.warn('[studiecafe] prefs upsert mislukt:', error.message);
        return res.json(normalizeNotificationPrefs(update));
      }
      return res.json(normalizeNotificationPrefs(data));
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // Bijlagen-kolom (Task #351) kan ontbreken op een nog-niet-gemigreerde DB. We
  // detecteren dat één keer (gememoïseerd) en laten 'attachments' dan weg uit
  // zowel de SELECT-kolommen als de INSERT-payload — net als de manual_unread-
  // fallback elders in dit bestand, zodat oude DB's niet stil 500'en.
  const THREAD_COLS =
    'id, course_id, author_id, title, body, category, is_pinned, is_locked, is_announcement, is_resolved, kudos_by, kudos_at, reactions, reply_count, last_activity_at, created_at, updated_at';
  const REPLY_COLS =
    'id, thread_id, course_id, author_id, body, kudos_by, kudos_at, reactions, deleted_at, created_at';
  let attachmentsColReady = null;   // null = nog onbekend
  let attachmentsColProbe = null;   // gedeelde probe-promise (één keer)
  async function attachmentsReady() {
    if (attachmentsColReady !== null) return attachmentsColReady;
    if (!attachmentsColProbe) {
      attachmentsColProbe = (async () => {
        try {
          const { error } = await supabaseAdmin
            .from('studiecafe_threads')
            .select('attachments')
            .limit(1);
          // 42703 = kolom ontbreekt (oude DB) → fail-closed. Andere (transiente)
          // fouten → optimistisch true, zodat we bijlagen niet stil weggooien.
          if (error && (error.code === '42703' || /attachments/i.test(error.message || ''))) {
            return false;
          }
          return true;
        } catch {
          return true;
        }
      })();
    }
    attachmentsColReady = await attachmentsColProbe;
    return attachmentsColReady;
  }
  async function threadCols() {
    return (await attachmentsReady()) ? `${THREAD_COLS}, attachments` : THREAD_COLS;
  }
  async function replyCols() {
    return (await attachmentsReady()) ? `${REPLY_COLS}, attachments` : REPLY_COLS;
  }
  // Voegt sanitized bijlagen toe aan een insert-payload, maar alleen als de kolom
  // bestaat (anders 500't de INSERT op een oude DB).
  async function withAttachments(insert, rawAttachments) {
    if (await attachmentsReady()) insert.attachments = sanitizeAttachments(rawAttachments);
    return insert;
  }

  async function buildNameResolver(ids) {
    const uniq = [...new Set((ids || []).filter(Boolean))];
    const map = new Map();
    if (uniq.length) {
      const { data } = await supabaseAdmin
        .from('profiles')
        .select('id, full_name, email')
        .in('id', uniq);
      for (const p of data || []) map.set(p.id, p);
    }
    return (id) => {
      if (!id) return null;
      const p = map.get(id);
      if (!p) return 'Onbekend';
      return p.full_name || (p.email ? String(p.email).split('@')[0] : null) || 'Onbekend';
    };
  }

  function shapeThread(r, nameFor, viewerId) {
    return {
      id: r.id,
      courseId: r.course_id,
      authorId: r.author_id,
      authorName: nameFor(r.author_id),
      title: r.title,
      body: r.body,
      category: r.category,
      attachments: Array.isArray(r.attachments) ? r.attachments : [],
      isPinned: !!r.is_pinned,
      isLocked: !!r.is_locked,
      isAnnouncement: !!r.is_announcement,
      isResolved: !!r.is_resolved,
      kudos: r.kudos_at ? { by: r.kudos_by, byName: nameFor(r.kudos_by), at: r.kudos_at } : null,
      reactions: summarizeReactions(r.reactions, viewerId),
      replyCount: r.reply_count || 0,
      lastActivityAt: r.last_activity_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      isMine: !!viewerId && r.author_id === viewerId,
    };
  }

  function shapeReply(r, nameFor, viewerId) {
    if (r.deleted_at) {
      return {
        id: r.id,
        threadId: r.thread_id,
        deleted: true,
        body: '',
        authorName: null,
        reactions: [],
        kudos: null,
        createdAt: r.created_at,
        isMine: false,
      };
    }
    return {
      id: r.id,
      threadId: r.thread_id,
      authorId: r.author_id,
      authorName: nameFor(r.author_id),
      body: r.body,
      attachments: Array.isArray(r.attachments) ? r.attachments : [],
      kudos: r.kudos_at ? { by: r.kudos_by, byName: nameFor(r.kudos_by), at: r.kudos_at } : null,
      reactions: summarizeReactions(r.reactions, viewerId),
      createdAt: r.created_at,
      isMine: !!viewerId && r.author_id === viewerId,
      deleted: false,
    };
  }

  async function nowIso() { return new Date().toISOString(); }

  // Lees de last_seen_at van één gebruiker voor één cursus. Defensief: als de
  // studiecafe_last_seen-tabel (migratie #307) nog niet bestaat, geef null terug
  // zodat de feed gewoon blijft werken (geen ongelezen-markeringen).
  async function getLastSeen(userId, courseId) {
    try {
      const { data, error } = await supabaseAdmin
        .from('studiecafe_last_seen')
        .select('last_seen_at')
        .eq('user_id', userId)
        .eq('course_id', courseId)
        .maybeSingle();
      if (error) return null;
      return data ? data.last_seen_at : null;
    } catch {
      return null;
    }
  }

  // Lees alle per-thread leesmomenten van één gebruiker binnen één cursus
  // (Task #312/#327) → { reads: Map thread_id → read_at, manual: Set thread_id }.
  // De manual-Set bevat threads die de gebruiker bewust weer als ongelezen heeft
  // gemarkeerd (Task #327). Defensief: ontbrekende tabel ⇒ leeg; ontbrekende
  // manual_unread-kolom (oude DB) ⇒ retry zonder de kolom zodat de feed blijft
  // werken (geen handmatige markeringen).
  async function getThreadReads(userId, courseId) {
    const reads = new Map();
    const manual = new Set();
    const fill = (rows) => {
      for (const r of rows || []) {
        if (r.read_at) reads.set(r.thread_id, r.read_at);
        if (r.manual_unread) manual.add(r.thread_id);
      }
    };
    try {
      const { data, error } = await supabaseAdmin
        .from('studiecafe_thread_reads')
        .select('thread_id, read_at, manual_unread')
        .eq('user_id', userId)
        .eq('course_id', courseId);
      if (!error) {
        fill(data);
        return { reads, manual };
      }
      // Kolom manual_unread ontbreekt nog (migratie #327 niet toegepast) → retry.
      if (/manual_unread/.test(error.message || '')) {
        const { data: d2, error: e2 } = await supabaseAdmin
          .from('studiecafe_thread_reads')
          .select('thread_id, read_at')
          .eq('user_id', userId)
          .eq('course_id', courseId);
        if (!e2) fill(d2);
      }
      return { reads, manual };
    } catch {
      return { reads, manual };
    }
  }

  // Markeer één thread als gelezen voor deze gebruiker (Task #312). Upsert per
  // (user, thread) met read_at=now() én manual_unread=false zodat openen een
  // eerder bewust-ongelezen markering (Task #327) opheft. Defensief: ontbrekende
  // manual_unread-kolom ⇒ retry zonder de kolom.
  async function markThreadRead(userId, courseId, threadId, ts) {
    const base = { user_id: userId, course_id: courseId, thread_id: threadId, read_at: ts };
    try {
      const { error } = await supabaseAdmin
        .from('studiecafe_thread_reads')
        .upsert({ ...base, manual_unread: false }, { onConflict: 'user_id,thread_id' });
      if (!error) return;
      if (/manual_unread/.test(error.message || '')) {
        const { error: e2 } = await supabaseAdmin
          .from('studiecafe_thread_reads')
          .upsert(base, { onConflict: 'user_id,thread_id' });
        if (e2) console.warn('[studiecafe] thread-read upsert mislukt:', e2.message);
        return;
      }
      console.warn('[studiecafe] thread-read upsert mislukt:', error.message);
    } catch (err) {
      console.warn('[studiecafe] thread-read unexpected:', err.message);
    }
  }

  // Markeer één thread weer als ongelezen voor deze gebruiker (Task #324/#327):
  // zet de expliciete manual_unread-marker zodat de thread opnieuw als "nieuw"
  // oplicht — óók backlog-threads met activiteit vóór de zachte-uitrol-vloer.
  // Upsert per (user, thread) zodat ook een thread zonder bestaande read-rij
  // gemarkeerd kan worden (read_at krijgt dan de kolom-default). Defensief: een
  // oude DB zonder manual_unread-kolom valt terug op het oude gedrag (read-rij
  // verwijderen), dat alleen voor post-vloer-threads werkt.
  async function markThreadUnread(userId, courseId, threadId) {
    try {
      const { error } = await supabaseAdmin
        .from('studiecafe_thread_reads')
        .upsert(
          { user_id: userId, course_id: courseId, thread_id: threadId, manual_unread: true },
          { onConflict: 'user_id,thread_id' },
        );
      if (!error) return;
      if (/manual_unread/.test(error.message || '')) {
        const { error: e2 } = await supabaseAdmin
          .from('studiecafe_thread_reads')
          .delete()
          .eq('user_id', userId)
          .eq('thread_id', threadId);
        if (e2) console.warn('[studiecafe] thread-unread fallback delete mislukt:', e2.message);
        return;
      }
      console.warn('[studiecafe] thread-unread upsert mislukt:', error.message);
    } catch (err) {
      console.warn('[studiecafe] thread-unread unexpected:', err.message);
    }
  }

  // GET feed — niet-verwijderde threads, pinned + aankondigingen bovenaan.
  app.get('/api/studiecafe/:courseId/threads', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId } = req.params;
    if (!(await userHasCourseAccess(auth.user, auth.profile, courseId))) {
      return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
    }
    try {
      const isStaff = await isStaffForCourse(auth.user, auth.profile, courseId);
      const { data: rows, error } = await supabaseAdmin
        .from('studiecafe_threads')
        .select(await threadCols())
        .eq('course_id', courseId)
        .is('deleted_at', null)
        .order('is_pinned', { ascending: false })
        .order('is_announcement', { ascending: false })
        .order('last_activity_at', { ascending: false })
        .limit(200);
      if (error) {
        console.error('[studiecafe] feed error:', error.message);
        return res.status(500).json({ error: error.message });
      }
      const nameFor = await buildNameResolver(
        (rows || []).flatMap((r) => [r.author_id, r.kudos_by]),
      );
      const threads = (rows || []).map((r) => shapeThread(r, nameFor, auth.user.id));
      // lastSeenAt = zachte-uitrol-vloer (zie #307/#312). reads = per-thread
      // leesmomenten (#312): de client markeert een thread "nieuw" als zijn
      // activiteit ná de vloer ligt én hij niet individueel is geopend.
      // manualUnread (#327) = threads die de gebruiker bewust weer als ongelezen
      // markeerde; die lichten altijd op, ook backlog vóór de vloer.
      const [lastSeenAt, threadReads] = await Promise.all([
        getLastSeen(auth.user.id, courseId),
        getThreadReads(auth.user.id, courseId),
      ]);
      return res.json({
        isStaff,
        currentUserId: auth.user.id,
        threads,
        lastSeenAt,
        reads: Object.fromEntries(threadReads.reads),
        manualUnread: [...threadReads.manual],
      });
    } catch (err) {
      console.error('[studiecafe] feed unexpected:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // GET ongelezen-samenvatting — voedt de nav-badge. Zuiver (geen side-effects):
  // lastSeenAt null (nog nooit geopend) ⇒ count 0. Defensief bij ontbrekende
  // last_seen-tabel (getLastSeen geeft dan null → count 0).
  app.get('/api/studiecafe/:courseId/unread', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId } = req.params;
    if (!(await userHasCourseAccess(auth.user, auth.profile, courseId))) {
      return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
    }
    try {
      const [lastSeenAt, threadReads] = await Promise.all([
        getLastSeen(auth.user.id, courseId),
        getThreadReads(auth.user.id, courseId),
      ]);
      const { data: rows, error } = await supabaseAdmin
        .from('studiecafe_threads')
        .select('id, last_activity_at, is_announcement')
        .eq('course_id', courseId)
        .is('deleted_at', null)
        .order('last_activity_at', { ascending: false })
        .limit(200);
      if (error) {
        console.error('[studiecafe] unread error:', error.message);
        return res.status(500).json({ error: error.message });
      }
      // Per-thread leesstatus (#312): tel alleen threads met activiteit ná de
      // vloer die de gebruiker niet individueel heeft geopend. Bewust-ongelezen
      // markeringen (#327) tellen altijd mee, ook backlog vóór de vloer.
      const summary = summarizeUnreadThreads(rows || [], lastSeenAt, threadReads.reads, threadReads.manual);
      return res.json({ ...summary, lastSeenAt });
    } catch (err) {
      console.error('[studiecafe] unread unexpected:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /seen — markeer het studiecafé van deze cursus als gezien (now()).
  // Upsert per (user, course). Defensief: ontbrekende last_seen-tabel ⇒ stil ok.
  app.post('/api/studiecafe/:courseId/seen', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId } = req.params;
    if (!(await userHasCourseAccess(auth.user, auth.profile, courseId))) {
      return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
    }
    const ts = await nowIso();
    try {
      const { error } = await supabaseAdmin
        .from('studiecafe_last_seen')
        .upsert(
          { user_id: auth.user.id, course_id: courseId, last_seen_at: ts },
          { onConflict: 'user_id,course_id' },
        );
      if (error) {
        // Ontbrekende tabel of andere fout: niet fataal, de feed werkt door.
        console.warn('[studiecafe] seen upsert mislukt:', error.message);
        return res.json({ ok: false, lastSeenAt: ts });
      }
      return res.json({ ok: true, lastSeenAt: ts });
    } catch (err) {
      console.warn('[studiecafe] seen unexpected:', err.message);
      return res.json({ ok: false, lastSeenAt: ts });
    }
  });

  // POST /threads/:threadId/read — markeer één thread als gelezen voor deze
  // gebruiker (Task #312). Wordt aangeroepen wanneer de student de thread
  // uitklapt/opent; alleen die ene thread verliest zijn "nieuw"-markering.
  // Verifieert dat de thread bij deze cursus hoort. Defensief/idempotent.
  app.post('/api/studiecafe/:courseId/threads/:threadId/read', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId, threadId } = req.params;
    if (!(await userHasCourseAccess(auth.user, auth.profile, courseId))) {
      return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
    }
    const ts = await nowIso();
    try {
      const { data: thread } = await supabaseAdmin
        .from('studiecafe_threads')
        .select('id, course_id')
        .eq('id', threadId)
        .maybeSingle();
      if (!thread || thread.course_id !== courseId) {
        return res.status(404).json({ error: 'Thread niet gevonden' });
      }
      await markThreadRead(auth.user.id, courseId, threadId, ts);
      return res.json({ ok: true, readAt: ts });
    } catch (err) {
      console.warn('[studiecafe] read unexpected:', err.message);
      return res.json({ ok: false, readAt: ts });
    }
  });

  // POST /threads/:threadId/unread — markeer één thread weer als ongelezen voor
  // deze gebruiker (Task #324/#327). Zet de expliciete manual_unread-marker zodat
  // de thread opnieuw als "nieuw" oplicht, ÓÓK backlog-threads met activiteit vóór
  // de zachte-uitrol-vloer. Verifieert dat de thread bij deze cursus hoort.
  // Defensief/idempotent.
  app.post('/api/studiecafe/:courseId/threads/:threadId/unread', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId, threadId } = req.params;
    if (!(await userHasCourseAccess(auth.user, auth.profile, courseId))) {
      return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
    }
    try {
      const { data: thread } = await supabaseAdmin
        .from('studiecafe_threads')
        .select('id, course_id')
        .eq('id', threadId)
        .maybeSingle();
      if (!thread || thread.course_id !== courseId) {
        return res.status(404).json({ error: 'Thread niet gevonden' });
      }
      await markThreadUnread(auth.user.id, courseId, threadId);
      return res.json({ ok: true });
    } catch (err) {
      console.warn('[studiecafe] unread unexpected:', err.message);
      return res.json({ ok: false });
    }
  });

  // POST /read-all — markeer ALLE zichtbare (niet-verwijderde) threads van deze
  // cursus als gelezen voor deze gebruiker (Task #314). Upsert per thread een
  // read-rij op now(); idempotent op (user, thread). Geeft de gemarkeerde
  // thread-ids + timestamp terug zodat de client optimistisch kan bijwerken en de
  // nav-badge meteen op 0 zet. Defensief: ontbrekende tabel/fout ⇒ stil ok=false.
  app.post('/api/studiecafe/:courseId/read-all', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId } = req.params;
    if (!(await userHasCourseAccess(auth.user, auth.profile, courseId))) {
      return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
    }
    const ts = await nowIso();
    try {
      const { data: rows, error } = await supabaseAdmin
        .from('studiecafe_threads')
        .select('id')
        .eq('course_id', courseId)
        .is('deleted_at', null)
        .limit(500);
      if (error) {
        console.warn('[studiecafe] read-all feed mislukt:', error.message);
        return res.json({ ok: false, readAt: ts, threadIds: [] });
      }
      const threadIds = (rows || []).map((r) => r.id);
      if (threadIds.length) {
        // read_at=now() én manual_unread=false: "alles gelezen" heft ook eerdere
        // bewust-ongelezen markeringen (#327) op.
        if (pgPool) {
          // Atomair pad: één multi-row INSERT ... ON CONFLICT (user_id, thread_id)
          // DO UPDATE (gespiegeld op de reactie-/pluim-/melding-pgPool-paden). De
          // upsert is idempotent per (user, thread), maar de directe Postgres-route
          // houdt deze mutatie consistent met de andere muterende routes en blijft
          // robuust als de logica groeit (deel-markeringen, conditioneel wissen van
          // manual_unread). Defensief: oude DB zonder manual_unread-kolom (42703)
          // valt terug op een INSERT zonder die kolom.
          // params: [user_id, course_id, read_at, ...threadIds]; elke thread is
          // $4, $5, … zodat één multi-row VALUES-lijst alle reads in één keer zet.
          const params = [auth.user.id, courseId, ts, ...threadIds];
          const valuesWithManual = threadIds
            .map((_, i) => `($1, $2, $${i + 4}, $3, false)`)
            .join(',');
          const valuesLegacy = threadIds
            .map((_, i) => `($1, $2, $${i + 4}, $3)`)
            .join(',');
          try {
            await pgPool.query(
              `INSERT INTO studiecafe_thread_reads
                  (user_id, course_id, thread_id, read_at, manual_unread)
                VALUES ${valuesWithManual}
                ON CONFLICT (user_id, thread_id)
                DO UPDATE SET read_at = EXCLUDED.read_at,
                             manual_unread = EXCLUDED.manual_unread`,
              params,
            );
          } catch (e) {
            // Oude DB zonder manual_unread-kolom (42703): herhaal de INSERT zonder
            // die kolom, net als de Supabase-fallback hieronder.
            if (/manual_unread/.test(e.message || '')) {
              await pgPool.query(
                `INSERT INTO studiecafe_thread_reads
                    (user_id, course_id, thread_id, read_at)
                  VALUES ${valuesLegacy}
                  ON CONFLICT (user_id, thread_id)
                  DO UPDATE SET read_at = EXCLUDED.read_at`,
                params,
              );
            } else {
              console.warn('[studiecafe] read-all atomic upsert mislukt:', e.message);
              return res.json({ ok: false, readAt: ts, threadIds: [] });
            }
          }
          return res.json({ ok: true, readAt: ts, threadIds });
        }
        // Fallback zonder pgPool (bv. testomgeving): Supabase REST upsert.
        // Idempotent per (user, thread); geen directe Postgres-verbinding nodig.
        // Defensief: oude DB zonder de kolom valt terug op de upsert zonder
        // manual_unread.
        const buildPayload = (withManual) =>
          threadIds.map((id) => ({
            user_id: auth.user.id,
            course_id: courseId,
            thread_id: id,
            read_at: ts,
            ...(withManual ? { manual_unread: false } : {}),
          }));
        let { error: upErr } = await supabaseAdmin
          .from('studiecafe_thread_reads')
          .upsert(buildPayload(true), { onConflict: 'user_id,thread_id' });
        if (upErr && /manual_unread/.test(upErr.message || '')) {
          ({ error: upErr } = await supabaseAdmin
            .from('studiecafe_thread_reads')
            .upsert(buildPayload(false), { onConflict: 'user_id,thread_id' }));
        }
        if (upErr) {
          console.warn('[studiecafe] read-all upsert mislukt:', upErr.message);
          return res.json({ ok: false, readAt: ts, threadIds: [] });
        }
      }
      return res.json({ ok: true, readAt: ts, threadIds });
    } catch (err) {
      console.warn('[studiecafe] read-all unexpected:', err.message);
      return res.json({ ok: false, readAt: ts, threadIds: [] });
    }
  });

  // GET replies van één thread.
  app.get('/api/studiecafe/:courseId/threads/:threadId/replies', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId, threadId } = req.params;
    if (!(await userHasCourseAccess(auth.user, auth.profile, courseId))) {
      return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
    }
    try {
      const isStaff = await isStaffForCourse(auth.user, auth.profile, courseId);
      const { data: thread } = await supabaseAdmin
        .from('studiecafe_threads')
        .select('id, course_id, deleted_at')
        .eq('id', threadId)
        .maybeSingle();
      if (!thread || thread.course_id !== courseId || thread.deleted_at) {
        return res.status(404).json({ error: 'Thread niet gevonden' });
      }
      const { data: rows, error } = await supabaseAdmin
        .from('studiecafe_replies')
        .select(await replyCols())
        .eq('thread_id', threadId)
        .order('created_at', { ascending: true })
        .limit(500);
      if (error) {
        console.error('[studiecafe] replies error:', error.message);
        return res.status(500).json({ error: error.message });
      }
      const nameFor = await buildNameResolver(
        (rows || []).flatMap((r) => [r.author_id, r.kudos_by]),
      );
      const replies = (rows || []).map((r) => shapeReply(r, nameFor, auth.user.id));
      return res.json({ isStaff, currentUserId: auth.user.id, replies });
    } catch (err) {
      console.error('[studiecafe] replies unexpected:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST nieuwe thread.
  app.post('/api/studiecafe/:courseId/threads', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId } = req.params;
    if (!(await userHasCourseAccess(auth.user, auth.profile, courseId))) {
      return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
    }
    const v = validateThreadInput(req.body || {});
    if (!v.ok) return res.status(400).json({ error: v.error });
    try {
      const isStaff = await isStaffForCourse(auth.user, auth.profile, courseId);
      const isAnnouncement = !!(req.body && req.body.isAnnouncement) && isStaff;
      const insert = await withAttachments({
        course_id: courseId,
        author_id: auth.user.id,
        title: v.value.title,
        body: v.value.body,
        category: sanitizeCategory(req.body && req.body.category),
        is_announcement: isAnnouncement,
        last_activity_at: await nowIso(),
      }, req.body && req.body.attachments);
      const { data, error } = await supabaseAdmin
        .from('studiecafe_threads')
        .insert(insert)
        .select(await threadCols())
        .single();
      if (error) {
        console.error('[studiecafe] create thread error:', error.message);
        return res.status(500).json({ error: error.message });
      }

      // Aankondiging? Meld het aan de doelgroep. Fire-and-forget: het opbouwen
      // van een grote doelgroep mag het plaatsen van de aankondiging niet ophouden.
      if (isAnnouncement) {
        void enqueueAnnouncement({
          courseId,
          threadId: data.id,
          title: data.title,
          actorId: auth.user.id,
        }).catch((e) => console.warn('[studiecafe] enqueue aankondiging mislukt:', e.message));
      }

      // De auteur heeft zijn eigen thread "gelezen": markeer hem zodat hij niet
      // als ongelezen voor zichzelf verschijnt (Task #312).
      await markThreadRead(auth.user.id, courseId, data.id, data.last_activity_at || (await nowIso()));

      const nameFor = await buildNameResolver([data.author_id, data.kudos_by]);
      return res.json({ thread: shapeThread(data, nameFor, auth.user.id) });
    } catch (err) {
      console.error('[studiecafe] create thread unexpected:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST nieuwe reply.
  app.post('/api/studiecafe/:courseId/threads/:threadId/replies', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId, threadId } = req.params;
    if (!(await userHasCourseAccess(auth.user, auth.profile, courseId))) {
      return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
    }
    const v = validateReplyInput(req.body || {});
    if (!v.ok) return res.status(400).json({ error: v.error });
    try {
      const isStaff = await isStaffForCourse(auth.user, auth.profile, courseId);
      const { data: thread } = await supabaseAdmin
        .from('studiecafe_threads')
        .select('id, course_id, is_locked, reply_count, deleted_at, author_id, title')
        .eq('id', threadId)
        .maybeSingle();
      if (!thread || thread.course_id !== courseId || thread.deleted_at) {
        return res.status(404).json({ error: 'Thread niet gevonden' });
      }
      if (!canReplyToThread({ isStaff, isLocked: thread.is_locked })) {
        return res.status(403).json({ error: 'Deze thread is gesloten' });
      }
      const replyInsert = await withAttachments({
        thread_id: threadId,
        course_id: courseId,
        author_id: auth.user.id,
        body: v.value.body,
      }, req.body && req.body.attachments);
      const { data, error } = await supabaseAdmin
        .from('studiecafe_replies')
        .insert(replyInsert)
        .select(await replyCols())
        .single();
      if (error) {
        console.error('[studiecafe] create reply error:', error.message);
        return res.status(500).json({ error: error.message });
      }
      // Tel-bump + activiteit. Atomair via pgPool indien beschikbaar.
      if (pgPool) {
        await pgPool.query(
          'UPDATE studiecafe_threads SET reply_count = reply_count + 1, last_activity_at = now(), updated_at = now() WHERE id = $1',
          [threadId],
        );
      } else {
        await supabaseAdmin
          .from('studiecafe_threads')
          .update({ reply_count: (thread.reply_count || 0) + 1, last_activity_at: await nowIso() })
          .eq('id', threadId);
      }

      // Meld de thread-auteur (niet jezelf) dat er een reactie is (best-effort).
      if (thread.author_id && thread.author_id !== auth.user.id) {
        await enqueueNotifications([
          {
            userId: thread.author_id,
            courseId,
            kind: 'reply',
            threadId,
            replyId: data.id,
            actorId: auth.user.id,
            threadTitle: thread.title,
          },
        ]).catch((e) => console.warn('[studiecafe] enqueue reactie-melding mislukt:', e.message));
      }

      // De auteur heeft de thread waarop hij reageert effectief gelezen:
      // markeer hem zodat zijn eigen reactie hem niet als ongelezen markeert (#312).
      await markThreadRead(auth.user.id, courseId, threadId, await nowIso());

      const nameFor = await buildNameResolver([data.author_id, data.kudos_by]);
      return res.json({ reply: shapeReply(data, nameFor, auth.user.id) });
    } catch (err) {
      console.error('[studiecafe] create reply unexpected:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // DELETE thread (soft) — auteur of staff.
  app.delete('/api/studiecafe/:courseId/threads/:threadId', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId, threadId } = req.params;
    if (!(await userHasCourseAccess(auth.user, auth.profile, courseId))) {
      return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
    }
    try {
      const { data: thread } = await supabaseAdmin
        .from('studiecafe_threads')
        .select('id, course_id, author_id, deleted_at')
        .eq('id', threadId)
        .maybeSingle();
      if (!thread || thread.course_id !== courseId) {
        return res.status(404).json({ error: 'Thread niet gevonden' });
      }
      if (thread.deleted_at) return res.json({ ok: true });
      const isStaff = await isStaffForCourse(auth.user, auth.profile, courseId);
      const isAuthor = thread.author_id === auth.user.id;
      if (!canDeletePost({ isStaff, isAuthor })) {
        return res.status(403).json({ error: 'Je mag deze post niet verwijderen' });
      }
      const ts = await nowIso();
      // Beveiligingskritisch: de thread én al zijn child-replies moeten ATOMAIR
      // geredigeerd worden. De SELECT-RLS laat cursusgenoten studiecafe_replies
      // RECHTSTREEKS lezen (buiten de server-shape om), dus als de thread wél maar
      // de replies NIET geredigeerd worden, blijft de inhoud van een verwijderde
      // thread via zijn reacties cursus-breed leesbaar. Met pgPool draaien beide
      // updates in één transactie; faalt er iets, dan rollt alles terug.
      if (pgPool) {
        const client = await pgPool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `UPDATE studiecafe_threads
               SET deleted_at = $2, deleted_by = $3, body = '', title = '',
                   author_id = NULL, kudos_by = NULL, kudos_at = NULL,
                   reactions = '{}'::jsonb, updated_at = $2
             WHERE id = $1`,
            [threadId, ts, auth.user.id],
          );
          await client.query(
            `UPDATE studiecafe_replies
               SET deleted_at = $2, deleted_by = $3, body = '',
                   author_id = NULL, kudos_by = NULL, kudos_at = NULL,
                   reactions = '{}'::jsonb
             WHERE thread_id = $1 AND deleted_at IS NULL`,
            [threadId, ts, auth.user.id],
          );
          // Task #315: een soft-delete laat de thread-rij staan, dus de
          // ON DELETE CASCADE naar studiecafe_thread_reads vuurt nooit. Ruim de
          // per-(gebruiker, thread) leesmarkeringen hier expliciet op zodat ze
          // niet onbeperkt blijven opstapelen voor verwijderde threads.
          // Defensief: ontbrekende tabel (oude DB) breekt de transactie niet af.
          try {
            await client.query(`DELETE FROM studiecafe_thread_reads WHERE thread_id = $1`, [
              threadId,
            ]);
          } catch (readErr) {
            if (readErr && readErr.code !== '42P01') throw readErr;
          }
          await client.query('COMMIT');
        } catch (txErr) {
          await client.query('ROLLBACK').catch(() => {});
          console.error('[studiecafe] delete thread tx error:', txErr.message);
          return res.status(500).json({ error: txErr.message });
        } finally {
          client.release();
        }
        return res.json({ ok: true });
      }
      // Fallback zonder pgPool (bv. testomgeving): redigeer EERST de replies en pas
      // dáárna de thread. Faalt de reply-cascade, dan is de thread nog NIET
      // verwijderd → geen leesbare replies onder een verwijderde thread (fail-closed).
      // Reeds verwijderde replies slaan we over zodat hun audit intact blijft.
      const { error: cascadeErr } = await supabaseAdmin
        .from('studiecafe_replies')
        .update(buildSoftDeleteRedaction({ ts, userId: auth.user.id, isThread: false }))
        .eq('thread_id', threadId)
        .is('deleted_at', null);
      if (cascadeErr) {
        console.error('[studiecafe] delete thread reply-cascade error:', cascadeErr.message);
        return res.status(500).json({ error: cascadeErr.message });
      }
      const { error: delErr } = await supabaseAdmin
        .from('studiecafe_threads')
        .update(buildSoftDeleteRedaction({ ts, userId: auth.user.id, isThread: true }))
        .eq('id', threadId);
      if (delErr) {
        console.error('[studiecafe] delete thread error:', delErr.message);
        return res.status(500).json({ error: delErr.message });
      }
      // Task #315: ruim de per-(gebruiker, thread) leesmarkeringen op (de
      // ON DELETE CASCADE vuurt niet bij een soft-delete). Defensief: stil falen
      // bij ontbrekende tabel/fout zodat de delete zelf geslaagd blijft.
      try {
        await supabaseAdmin.from('studiecafe_thread_reads').delete().eq('thread_id', threadId);
      } catch (readErr) {
        console.warn('[studiecafe] delete thread read-cleanup error:', readErr.message);
      }
      return res.json({ ok: true });
    } catch (err) {
      console.error('[studiecafe] delete thread unexpected:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // DELETE reply (soft) — auteur of staff; verlaagt reply_count.
  app.delete('/api/studiecafe/:courseId/replies/:replyId', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId, replyId } = req.params;
    if (!(await userHasCourseAccess(auth.user, auth.profile, courseId))) {
      return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
    }
    try {
      const { data: reply } = await supabaseAdmin
        .from('studiecafe_replies')
        .select('id, course_id, thread_id, author_id, deleted_at')
        .eq('id', replyId)
        .maybeSingle();
      if (!reply || reply.course_id !== courseId) {
        return res.status(404).json({ error: 'Reactie niet gevonden' });
      }
      if (reply.deleted_at) return res.json({ ok: true });
      const isStaff = await isStaffForCourse(auth.user, auth.profile, courseId);
      const isAuthor = reply.author_id === auth.user.id;
      if (!canDeletePost({ isStaff, isAuthor })) {
        return res.status(403).json({ error: 'Je mag deze reactie niet verwijderen' });
      }
      const ts = await nowIso();
      const { error: delErr } = await supabaseAdmin
        .from('studiecafe_replies')
        .update(buildSoftDeleteRedaction({ ts, userId: auth.user.id, isThread: false }))
        .eq('id', replyId);
      if (delErr) {
        // Beveiligingskritisch: een stil falen zou de inhoud NIET redigeren.
        console.error('[studiecafe] delete reply error:', delErr.message);
        return res.status(500).json({ error: delErr.message });
      }
      if (pgPool) {
        await pgPool.query(
          'UPDATE studiecafe_threads SET reply_count = GREATEST(reply_count - 1, 0), updated_at = now() WHERE id = $1',
          [reply.thread_id],
        );
      } else {
        const { data: th } = await supabaseAdmin
          .from('studiecafe_threads').select('reply_count').eq('id', reply.thread_id).maybeSingle();
        await supabaseAdmin
          .from('studiecafe_threads')
          .update({ reply_count: Math.max((th?.reply_count || 0) - 1, 0) })
          .eq('id', reply.thread_id);
      }
      return res.json({ ok: true });
    } catch (err) {
      console.error('[studiecafe] delete reply unexpected:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // PATCH reply — inhoud bewerken; auteur of staff.
  app.patch('/api/studiecafe/:courseId/replies/:replyId', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId, replyId } = req.params;
    if (!(await userHasCourseAccess(auth.user, auth.profile, courseId))) {
      return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
    }
    const v = validateReplyInput(req.body || {});
    if (!v.ok) return res.status(400).json({ error: v.error });
    try {
      const { data: reply } = await supabaseAdmin
        .from('studiecafe_replies')
        .select('id, course_id, author_id, deleted_at')
        .eq('id', replyId)
        .maybeSingle();
      if (!reply || reply.course_id !== courseId || reply.deleted_at) {
        return res.status(404).json({ error: 'Reactie niet gevonden' });
      }
      const isStaff = await isStaffForCourse(auth.user, auth.profile, courseId);
      const isAuthor = reply.author_id === auth.user.id;
      if (!canEditPost({ isStaff, isAuthor })) {
        return res.status(403).json({ error: 'Je mag deze reactie niet bewerken' });
      }
      const { data, error } = await supabaseAdmin
        .from('studiecafe_replies')
        .update({ body: v.value.body })
        .eq('id', replyId)
        .select(await replyCols())
        .single();
      if (error) {
        console.error('[studiecafe] patch reply error:', error.message);
        return res.status(500).json({ error: error.message });
      }
      const nameFor = await buildNameResolver([data.author_id, data.kudos_by]);
      return res.json({ reply: shapeReply(data, nameFor, auth.user.id) });
    } catch (err) {
      console.error('[studiecafe] patch reply unexpected:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // PATCH thread — moderatie + bewerken. pin/lock/aankondiging = staff;
  // resolved + inhoud (titel/body/categorie) = auteur of staff.
  app.patch('/api/studiecafe/:courseId/threads/:threadId', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId, threadId } = req.params;
    if (!(await userHasCourseAccess(auth.user, auth.profile, courseId))) {
      return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
    }
    try {
      const { data: thread } = await supabaseAdmin
        .from('studiecafe_threads')
        .select('id, course_id, author_id, deleted_at, is_announcement')
        .eq('id', threadId)
        .maybeSingle();
      if (!thread || thread.course_id !== courseId || thread.deleted_at) {
        return res.status(404).json({ error: 'Thread niet gevonden' });
      }
      const isStaff = await isStaffForCourse(auth.user, auth.profile, courseId);
      const isAuthor = thread.author_id === auth.user.id;
      const b = req.body || {};
      const update = {};
      // Inhoud bewerken (titel/body/categorie) — auteur of staff.
      const wantsEdit =
        typeof b.title === 'string' || typeof b.body === 'string' || typeof b.category === 'string';
      if (wantsEdit) {
        if (!canEditPost({ isStaff, isAuthor })) {
          return res.status(403).json({ error: 'Je mag deze post niet bewerken' });
        }
        const v = validateThreadInput({ title: b.title, body: b.body });
        if (!v.ok) return res.status(400).json({ error: v.error });
        update.title = v.value.title;
        update.body = v.value.body;
        if (typeof b.category === 'string') update.category = sanitizeCategory(b.category);
      }
      if (typeof b.isPinned === 'boolean') {
        if (!canModerate({ isStaff })) return res.status(403).json({ error: 'Alleen docenten mogen pinnen' });
        update.is_pinned = b.isPinned;
      }
      if (typeof b.isLocked === 'boolean') {
        if (!canModerate({ isStaff })) return res.status(403).json({ error: 'Alleen docenten mogen sluiten' });
        update.is_locked = b.isLocked;
      }
      if (typeof b.isAnnouncement === 'boolean') {
        if (!canModerate({ isStaff })) return res.status(403).json({ error: 'Alleen docenten mogen aankondigingen beheren' });
        update.is_announcement = b.isAnnouncement;
      }
      if (typeof b.isResolved === 'boolean') {
        if (!canSetResolved({ isStaff, isAuthor })) return res.status(403).json({ error: 'Je mag dit niet markeren' });
        update.is_resolved = b.isResolved;
      }
      if (!Object.keys(update).length) {
        return res.status(400).json({ error: 'Geen geldige velden om te wijzigen' });
      }
      update.updated_at = await nowIso();
      const { data, error } = await supabaseAdmin
        .from('studiecafe_threads')
        .update(update)
        .eq('id', threadId)
        .select(await threadCols())
        .single();
      if (error) {
        console.error('[studiecafe] patch thread error:', error.message);
        return res.status(500).json({ error: error.message });
      }
      // Nieuw als aankondiging gemarkeerd? Meld de doelgroep. Fire-and-forget
      // zodat een grote doelgroep de PATCH-respons niet ophoudt.
      if (update.is_announcement === true && thread.is_announcement !== true) {
        void enqueueAnnouncement({
          courseId,
          threadId: data.id,
          title: data.title,
          actorId: auth.user.id,
        }).catch((e) => console.warn('[studiecafe] enqueue aankondiging (patch) mislukt:', e.message));
      }
      const nameFor = await buildNameResolver([data.author_id, data.kudos_by]);
      return res.json({ thread: shapeThread(data, nameFor, auth.user.id) });
    } catch (err) {
      console.error('[studiecafe] patch thread unexpected:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST reactie-toggle — iedereen met cursustoegang.
  app.post('/api/studiecafe/:courseId/reactions', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId } = req.params;
    if (!(await userHasCourseAccess(auth.user, auth.profile, courseId))) {
      return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
    }
    const { targetType, targetId, emoji } = req.body || {};
    if (!['thread', 'reply'].includes(targetType) || !targetId) {
      return res.status(400).json({ error: 'Ongeldig doel' });
    }
    if (!isAllowedEmoji(emoji)) {
      return res.status(400).json({ error: 'Emoji niet toegestaan' });
    }
    const table = targetType === 'thread' ? 'studiecafe_threads' : 'studiecafe_replies';
    try {
      // Atomair pad: serialiseer de read-modify-write per rij met
      // `SELECT ... FOR UPDATE` zodat twee gelijktijdige toggles elkaar niet
      // overschrijven (gespiegeld op de atomic pgPool-aanpak elders in de app).
      if (pgPool) {
        const result = await toggleReactionAtomicPg({
          pgPool, table, targetId, courseId, emoji, userId: auth.user.id,
        });
        if (result.notFound) return res.status(404).json({ error: 'Doel niet gevonden' });
        if (result.invalid) return res.status(400).json({ error: 'Emoji niet toegestaan' });
        return res.json({ reactions: summarizeReactions(result.next, auth.user.id) });
      }
      // Fallback zonder pgPool (bv. testomgeving): best-effort read-modify-write.
      // Hier bestaat het lost-update-risico nog, maar dit pad draait alleen waar
      // er geen directe Postgres-verbinding is.
      const { data: row } = await supabaseAdmin
        .from(table)
        .select('id, course_id, reactions, deleted_at')
        .eq('id', targetId)
        .maybeSingle();
      if (!row || row.course_id !== courseId || row.deleted_at) {
        return res.status(404).json({ error: 'Doel niet gevonden' });
      }
      const next = toggleReaction(row.reactions, emoji, auth.user.id);
      if (!next) return res.status(400).json({ error: 'Emoji niet toegestaan' });
      const { error } = await supabaseAdmin.from(table).update({ reactions: next }).eq('id', targetId);
      if (error) {
        console.error('[studiecafe] reaction error:', error.message);
        return res.status(500).json({ error: error.message });
      }
      return res.json({ reactions: summarizeReactions(next, auth.user.id) });
    } catch (err) {
      console.error('[studiecafe] reaction unexpected:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST pluim (kudos)-toggle — alleen staff van de cursus.
  app.post('/api/studiecafe/:courseId/kudos', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId } = req.params;
    if (!(await userHasCourseAccess(auth.user, auth.profile, courseId))) {
      return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
    }
    if (!(await isStaffForCourse(auth.user, auth.profile, courseId))) {
      return res.status(403).json({ error: 'Alleen docenten mogen een pluim geven' });
    }
    const { targetType, targetId } = req.body || {};
    if (!['thread', 'reply'].includes(targetType) || !targetId) {
      return res.status(400).json({ error: 'Ongeldig doel' });
    }
    const table = targetType === 'thread' ? 'studiecafe_threads' : 'studiecafe_replies';
    try {
      const ts = await nowIso();
      // Atomair pad: serialiseer de read-modify-write per rij met
      // `SELECT ... FOR UPDATE` zodat twee gelijktijdige pluim-toggles elkaar
      // niet overschrijven (gespiegeld op het reactie-pad hierboven).
      if (pgPool) {
        const result = await toggleKudosAtomicPg({
          pgPool, table, targetId, courseId, userId: auth.user.id, ts,
        });
        if (result.notFound) return res.status(404).json({ error: 'Doel niet gevonden' });
        if (result.invalid) return res.status(400).json({ error: 'Ongeldig doel' });
        return res.json({ kudos: result.giving ? { by: result.by, at: result.at } : null });
      }
      // Fallback zonder pgPool (bv. testomgeving): best-effort read-modify-write.
      // Hier bestaat het lost-update-risico nog, maar dit pad draait alleen waar
      // er geen directe Postgres-verbinding is.
      const { data: row } = await supabaseAdmin
        .from(table)
        .select('id, course_id, kudos_at, deleted_at')
        .eq('id', targetId)
        .maybeSingle();
      if (!row || row.course_id !== courseId || row.deleted_at) {
        return res.status(404).json({ error: 'Doel niet gevonden' });
      }
      const giving = !row.kudos_at;
      const update = giving ? { kudos_by: auth.user.id, kudos_at: ts } : { kudos_by: null, kudos_at: null };
      const { error } = await supabaseAdmin.from(table).update(update).eq('id', targetId);
      if (error) {
        console.error('[studiecafe] kudos error:', error.message);
        return res.status(500).json({ error: error.message });
      }
      return res.json({ kudos: giving ? { by: auth.user.id, at: ts } : null });
    } catch (err) {
      console.error('[studiecafe] kudos unexpected:', err);
      return res.status(500).json({ error: err.message });
    }
  });
}
