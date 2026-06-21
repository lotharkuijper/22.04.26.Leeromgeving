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
      return res.json({ isStaff, currentUserId: auth.user.id, threads });
    } catch (err) {
      console.error('[studiecafe] feed unexpected:', err);
      return res.status(500).json({ error: err.message });
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
        .select('id, course_id, is_locked, reply_count, deleted_at')
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
        .select('id, course_id, author_id, deleted_at')
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
      const { data: row } = await supabaseAdmin
        .from(table)
        .select('id, course_id, kudos_at, deleted_at')
        .eq('id', targetId)
        .maybeSingle();
      if (!row || row.course_id !== courseId || row.deleted_at) {
        return res.status(404).json({ error: 'Doel niet gevonden' });
      }
      const giving = !row.kudos_at;
      const ts = await nowIso();
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
