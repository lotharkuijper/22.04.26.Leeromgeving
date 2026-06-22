// Task #334 — Integratietest die bewaakt dat de per-cursus-afbakening op
// `documents` niet te omzeilen is via de oorspronkelijke uploader. Migratie
// `20260622120000_documents_rls_drop_uploader_bypass.sql` verwijderde de
// `uploaded_by = auth.uid()`-omzeiling, zodat een GEDEGRADEERDE (oud-)docent een
// eerder geüpload document NIET meer mag UPDATEN of VERWIJDEREN. Schrijven mag
// uitsluitend: admin OF actuele docent van de cursus van de map.
//
// Dit is een ECHTE integratietest tegen de Supabase-instantie:
//   • via de service-role-key (RLS-bypass) maken we een testgebruiker, een map,
//     een cursus + course_folder_assignment en een document (uploaded_by = user);
//   • we geven de gebruiker een docent-lidmaatschap en loggen als hem in;
//   • als docent kan hij het document UPDATEN (sanity);
//   • we degraderen hem naar 'student';
//   • we bevestigen dat UPDATE/DELETE nu 0 rijen raken en het document
//     ongewijzigd blijft bestaan (RLS blokkeert, geen uploader-omzeiling).
// Alles wordt in afterAll opgeruimd. De test SKIPt netjes zonder credentials.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.VITE_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.VITE_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const hasCreds = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_ROLE_KEY);

const rid = Math.random().toString(36).slice(2, 10);
const PASSWORD = `Doc!${rid}Aa1`;
const EMAIL = `doc-rls-${rid}@example.com`;

function makeClient(key) {
  return createClient(SUPABASE_URL, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

describe.skipIf(!hasCreds)('documents RLS — gedegradeerde docent kan niet meer schrijven', () => {
  let admin;
  let userId;
  let courseId;
  let folderId;
  let docId;
  let userClient;

  beforeAll(async () => {
    admin = makeClient(SERVICE_ROLE_KEY);

    const u = await admin.auth.admin.createUser({
      email: EMAIL, password: PASSWORD, email_confirm: true,
    });
    if (u.error) throw u.error;
    userId = u.data.user.id;

    const course = await admin
      .from('courses')
      .insert({ name: `Doc RLS ${rid}`, folder_name: `doc-rls-${rid}` })
      .select()
      .single();
    if (course.error) throw course.error;
    courseId = course.data.id;

    const folder = await admin
      .from('document_folders')
      .insert({ name: `Doc RLS map ${rid}`, created_by: userId })
      .select()
      .single();
    if (folder.error) throw folder.error;
    folderId = folder.data.id;

    const assign = await admin
      .from('course_folder_assignments')
      .insert({ course_id: courseId, folder_id: folderId });
    if (assign.error) throw assign.error;

    const doc = await admin
      .from('documents')
      .insert({
        title: `Doc ${rid}`,
        filename: `doc-${rid}.txt`,
        file_type: 'text/plain',
        folder_id: folderId,
        uploaded_by: userId,
      })
      .select()
      .single();
    if (doc.error) throw doc.error;
    docId = doc.data.id;

    // Docent-lidmaatschap (beide rol-kolommen — `role` is legacy NOT NULL).
    const mem = await admin
      .from('course_members')
      .insert({ user_id: userId, course_id: courseId, role: 'teacher', member_role: 'teacher' });
    if (mem.error) throw mem.error;

    userClient = makeClient(ANON_KEY);
    const signIn = await userClient.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
    if (signIn.error) throw signIn.error;
  });

  afterAll(async () => {
    if (!admin) return;
    if (docId) await admin.from('documents').delete().eq('id', docId);
    if (folderId) await admin.from('course_folder_assignments').delete().eq('folder_id', folderId);
    if (folderId) await admin.from('document_folders').delete().eq('id', folderId);
    if (courseId) await admin.from('course_members').delete().eq('course_id', courseId);
    if (courseId) await admin.from('courses').delete().eq('id', courseId);
    if (userId) await admin.auth.admin.deleteUser(userId);
  });

  it('staat UPDATE toe zolang de gebruiker docent van de cursus is', async () => {
    const { data, error } = await userClient
      .from('documents')
      .update({ title: `Gewijzigd door docent ${rid}` })
      .eq('id', docId)
      .select();
    expect(error).toBeNull();
    expect(Array.isArray(data) ? data.length : 0).toBe(1);
  });

  it('weigert UPDATE en DELETE nadat de docent is gedegradeerd naar student', async () => {
    // Degradeer via service-role (beide rol-kolommen).
    const demote = await admin
      .from('course_members')
      .update({ role: 'student', member_role: 'student' })
      .eq('user_id', userId)
      .eq('course_id', courseId);
    expect(demote.error).toBeNull();

    // UPDATE-poging als ex-docent: RLS blokkeert → 0 rijen geraakt.
    const upd = await userClient
      .from('documents')
      .update({ title: `Mag niet ${rid}` })
      .eq('id', docId)
      .select();
    expect(upd.error).toBeNull();
    expect(Array.isArray(upd.data) ? upd.data.length : 0).toBe(0);

    // DELETE-poging als ex-docent: RLS blokkeert → 0 rijen geraakt.
    const del = await userClient
      .from('documents')
      .delete()
      .eq('id', docId)
      .select();
    expect(del.error).toBeNull();
    expect(Array.isArray(del.data) ? del.data.length : 0).toBe(0);

    // Service-role-controle: document bestaat nog en titel is niet gewijzigd.
    const check = await admin.from('documents').select('id, title').eq('id', docId).maybeSingle();
    expect(check.error).toBeNull();
    expect(check.data).not.toBeNull();
    expect(check.data.title).not.toBe(`Mag niet ${rid}`);
  });
});
