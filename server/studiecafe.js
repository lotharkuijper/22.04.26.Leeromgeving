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

export const STUDIECAFE_CATEGORIES = ['vraag', 'discussie', 'samenwerken'];
// Bewuste allowlist: voorkomt willekeurige/agressieve emoji-payloads.
export const ALLOWED_REACTION_EMOJI = ['👍', '❤️', '🎉', '🤔', '✅', '🙌'];
export const MAX_TITLE_LEN = 200;
export const MAX_BODY_LEN = 8000;
export const MAX_REACTION_USERS = 1000; // cap per emoji-array

export function sanitizeCategory(cat) {
  return STUDIECAFE_CATEGORIES.includes(cat) ? cat : 'vraag';
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

// ── Per-thread ongelezen-indicator (Task #312) ──────────────────────────────
// Een thread is ongelezen voor deze lezer wanneer zijn laatste activiteit ná de
// zachte-uitrol-vloer (per-cursus last_seen) ligt ÉN de lezer hem sindsdien niet
// heeft geopend: geen read-rij, of de read is ouder dan de laatste activiteit.
//   floorAt null  (cursus nooit bezocht)      ⇒ niets ongelezen (zachte uitrol).
//   activiteit ≤ floorAt (vóór eerste bezoek) ⇒ gelezen (backlog onderdrukt).
//   threadReadAt ≥ activiteit (geopend)       ⇒ gelezen.
export function isThreadUnreadFor(lastActivityAt, floorAt, threadReadAt) {
  if (!lastActivityAt || !floorAt) return false;
  if (lastActivityAt <= floorAt) return false;
  if (threadReadAt && lastActivityAt <= threadReadAt) return false;
  return true;
}

// Tel ongelezen threads voor de nav-badge met per-thread leesstatus. readMap mag
// een Map of een plain object (thread_id → read_at ISO) zijn. Splitst
// aankondigingen apart zodat de UI die kan benadrukken.
export function summarizeUnreadThreads(threads, floorAt, readMap) {
  const out = { count: 0, announcementCount: 0, latestActivityAt: null };
  if (!Array.isArray(threads)) return out;
  const reads = readMap instanceof Map ? readMap : new Map(Object.entries(readMap || {}));
  for (const th of threads) {
    const act = th && th.last_activity_at;
    if (!act) continue;
    if (!out.latestActivityAt || act > out.latestActivityAt) out.latestActivityAt = act;
    const readAt = th.id ? reads.get(th.id) || null : null;
    if (isThreadUnreadFor(act, floorAt, readAt)) {
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

  const THREAD_COLS =
    'id, course_id, author_id, title, body, category, is_pinned, is_locked, is_announcement, is_resolved, kudos_by, kudos_at, reactions, reply_count, last_activity_at, created_at, updated_at';
  const REPLY_COLS =
    'id, thread_id, course_id, author_id, body, kudos_by, kudos_at, reactions, deleted_at, created_at';

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
  // (Task #312) → Map thread_id → read_at. Defensief: ontbrekende tabel ⇒ lege Map
  // zodat de feed gewoon blijft werken (geen per-thread markeringen).
  async function getThreadReads(userId, courseId) {
    const map = new Map();
    try {
      const { data, error } = await supabaseAdmin
        .from('studiecafe_thread_reads')
        .select('thread_id, read_at')
        .eq('user_id', userId)
        .eq('course_id', courseId);
      if (error) return map;
      for (const r of data || []) map.set(r.thread_id, r.read_at);
      return map;
    } catch {
      return map;
    }
  }

  // Markeer één thread als gelezen voor deze gebruiker (Task #312). Upsert per
  // (user, thread). Defensief: ontbrekende tabel/fout ⇒ stil falen (de feed werkt
  // door, de markering blijft alleen staan).
  async function markThreadRead(userId, courseId, threadId, ts) {
    try {
      const { error } = await supabaseAdmin
        .from('studiecafe_thread_reads')
        .upsert(
          { user_id: userId, course_id: courseId, thread_id: threadId, read_at: ts },
          { onConflict: 'user_id,thread_id' },
        );
      if (error) console.warn('[studiecafe] thread-read upsert mislukt:', error.message);
    } catch (err) {
      console.warn('[studiecafe] thread-read unexpected:', err.message);
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
        .select(THREAD_COLS)
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
      const [lastSeenAt, readMap] = await Promise.all([
        getLastSeen(auth.user.id, courseId),
        getThreadReads(auth.user.id, courseId),
      ]);
      return res.json({
        isStaff,
        currentUserId: auth.user.id,
        threads,
        lastSeenAt,
        reads: Object.fromEntries(readMap),
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
      const [lastSeenAt, readMap] = await Promise.all([
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
      // vloer die de gebruiker niet individueel heeft geopend.
      const summary = summarizeUnreadThreads(rows || [], lastSeenAt, readMap);
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
        .select(REPLY_COLS)
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
      const insert = {
        course_id: courseId,
        author_id: auth.user.id,
        title: v.value.title,
        body: v.value.body,
        category: sanitizeCategory(req.body && req.body.category),
        is_announcement: isAnnouncement,
        last_activity_at: await nowIso(),
      };
      const { data, error } = await supabaseAdmin
        .from('studiecafe_threads')
        .insert(insert)
        .select(THREAD_COLS)
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
      const { data, error } = await supabaseAdmin
        .from('studiecafe_replies')
        .insert({
          thread_id: threadId,
          course_id: courseId,
          author_id: auth.user.id,
          body: v.value.body,
        })
        .select(REPLY_COLS)
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
        .select(REPLY_COLS)
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
        .select(THREAD_COLS)
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
