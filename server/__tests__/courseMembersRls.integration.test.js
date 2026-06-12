// Task #266 — Integratietest die blijvend bewaakt dat de docent-koppeling niet
// te omzeilen is via de Supabase-client. Migratie
// `20260611120000_course_members_rls.sql` zet RLS op `course_members` aan met
// uitsluitend een SELECT-policy (eigen rijen + admin). Schrijven (INSERT/UPDATE/
// DELETE) heeft GEEN policy en wordt dus door RLS geweigerd — de server schrijft
// enkel met de service-role-key. Zonder deze bewaking zou een toekomstige
// migratie de RLS per ongeluk weer kunnen uitschakelen, waardoor elke ingelogde
// gebruiker zichzelf opnieuw tot docent (`member_role='teacher'`) zou kunnen
// promoveren.
//
// Dit is een ECHTE integratietest tegen de Supabase-instantie:
//   • we maken via de service-role-key (RLS-bypass) twee testgebruikers, een
//     testcursus en twee lidmaatschapsrijen;
//   • we loggen in als gebruiker A en gebruiken een ge-authenticeerde anon-client;
//   • we bevestigen dat A alleen z'n eigen lidmaatschap leest (niet dat van B);
//   • we bevestigen dat A geen rij kan INSERTen (RLS WITH CHECK → 42501) en dat
//     een UPDATE van de eigen rij naar 'teacher' 0 rijen raakt en niets wijzigt;
//   • we bevestigen dat een niet-ingelogde anon-client niets leest.
// Alles wordt in afterAll weer opgeruimd.
//
// De test SKIPt zichzelf netjes wanneer de Supabase-credentials ontbreken
// (bijv. een CI zonder secrets), zodat de suite daar niet rood wordt.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.VITE_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.VITE_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const hasCreds = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_ROLE_KEY);

const rid = Math.random().toString(36).slice(2, 10);
const PASSWORD = `Rls!${rid}Aa1`;
const EMAIL_A = `rls-test-a-${rid}@example.com`;
const EMAIL_B = `rls-test-b-${rid}@example.com`;

function makeClient(key) {
  return createClient(SUPABASE_URL, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

describe.skipIf(!hasCreds)('course_members RLS — docent-koppeling niet te omzeilen', () => {
  let admin; // service-role client (RLS-bypass) voor setup/cleanup
  let userAId;
  let userBId;
  let courseId;
  let aClient; // ge-authenticeerde client voor gebruiker A

  beforeAll(async () => {
    admin = makeClient(SERVICE_ROLE_KEY);

    const ua = await admin.auth.admin.createUser({
      email: EMAIL_A, password: PASSWORD, email_confirm: true,
    });
    if (ua.error) throw ua.error;
    userAId = ua.data.user.id;

    const ub = await admin.auth.admin.createUser({
      email: EMAIL_B, password: PASSWORD, email_confirm: true,
    });
    if (ub.error) throw ub.error;
    userBId = ub.data.user.id;

    const course = await admin
      .from('courses')
      .insert({ name: `RLS Test ${rid}`, folder_name: `rls-test-${rid}` })
      .select()
      .single();
    if (course.error) throw course.error;
    courseId = course.data.id;

    const members = await admin.from('course_members').insert([
      { user_id: userAId, course_id: courseId, role: 'student', member_role: 'student' },
      { user_id: userBId, course_id: courseId, role: 'student', member_role: 'student' },
    ]);
    if (members.error) throw members.error;

    aClient = makeClient(ANON_KEY);
    const signIn = await aClient.auth.signInWithPassword({ email: EMAIL_A, password: PASSWORD });
    if (signIn.error) throw signIn.error;
  }, 30000);

  afterAll(async () => {
    if (!admin) return;
    if (courseId) {
      await admin.from('course_members').delete().eq('course_id', courseId);
      await admin.from('courses').delete().eq('id', courseId);
    }
    if (userAId) await admin.auth.admin.deleteUser(userAId);
    if (userBId) await admin.auth.admin.deleteUser(userBId);
  }, 30000);

  it('laat een gebruiker WEL z\'n eigen lidmaatschap lezen, maar NIET dat van anderen', async () => {
    const { data, error } = await aClient
      .from('course_members')
      .select('user_id, member_role, course_id')
      .eq('course_id', courseId);

    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
    // Alleen de eigen rij van A is zichtbaar; B's rij wordt door RLS verborgen.
    expect(data).toHaveLength(1);
    expect(data[0].user_id).toBe(userAId);
    expect(data.some((r) => r.user_id === userBId)).toBe(false);
  });

  it('weigert een INSERT door een ge-authenticeerde gebruiker (geen WITH CHECK-policy → 42501)', async () => {
    const { data, error } = await aClient
      .from('course_members')
      .insert({ user_id: userAId, course_id: courseId, role: 'teacher', member_role: 'teacher' })
      .select();

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error.code).toBe('42501'); // new row violates row-level security policy
  });

  it('laat een UPDATE naar member_role=teacher 0 rijen raken en wijzigt niets', async () => {
    const { data, error } = await aClient
      .from('course_members')
      .update({ role: 'teacher', member_role: 'teacher' })
      .eq('user_id', userAId)
      .eq('course_id', courseId)
      .select();

    // Zonder UPDATE-policy kwalificeert geen enkele rij: 0 rijen geüpdatet,
    // PostgREST geeft geen fout maar een lege uitslag.
    expect(error).toBeNull();
    expect(data).toEqual([]);

    // Controle via de service-role-client: niets is daadwerkelijk gewijzigd.
    const check = await admin
      .from('course_members')
      .select('user_id, member_role')
      .eq('course_id', courseId);
    expect(check.error).toBeNull();
    const aRow = check.data.find((r) => r.user_id === userAId);
    expect(aRow.member_role).toBe('student');
    // Beide leden zijn nog steeds student — niemand is docent geworden.
    expect(check.data.every((r) => r.member_role === 'student')).toBe(true);
  });

  it('weigert een DELETE door een ge-authenticeerde gebruiker (geen DELETE-policy)', async () => {
    const { data, error } = await aClient
      .from('course_members')
      .delete()
      .eq('user_id', userAId)
      .eq('course_id', courseId)
      .select();

    // Geen DELETE-policy → 0 rijen verwijderd, geen fout.
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const check = await admin
      .from('course_members')
      .select('user_id')
      .eq('course_id', courseId);
    expect(check.error).toBeNull();
    // Beide rijen bestaan nog.
    expect(check.data).toHaveLength(2);
  });

  it('laat een NIET-ingelogde anon-client niets uit course_members lezen', async () => {
    const anonClient = makeClient(ANON_KEY);
    const { data, error } = await anonClient
      .from('course_members')
      .select('user_id')
      .eq('course_id', courseId);

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});
