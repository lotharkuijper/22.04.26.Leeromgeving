import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import multer from 'multer';
import { registerCourseInfoRoutes } from '../courseInfo.js';

// ───────────────────────────────────────────────────────────────────────────
// Integratietests voor de Cursus-info-endpoints (Task #203). De routes worden
// op een echte Express-app gemount; alle externe afhankelijkheden komen via
// dependency-injectie binnen als testdoubles. We sturen echte HTTP-verzoeken
// (via fetch tegen app.listen(0)) zodat routing + middleware meelopen.
//
// De toegangsregels die we bewaken:
//   - lezen (GET info, download)      → cursuslid (userHasCourseAccess)
//   - schrijven/koppelen/uploaden/    → staff van die cursus (isStaffForCourse)
//     ontkoppelen
//   - geen cross-course-lekkage: vreemde document-id's of documenten buiten de
//     cursusmappen worden geweigerd.
// ───────────────────────────────────────────────────────────────────────────

// Mutabele teststaat: per test stellen we het gedrag van de auth-doubles in.
let authState; // null ⇒ requireAuthUser antwoordt 401; anders {user, profile}
let accessState; // resultaat van userHasCourseAccess
let staffState; // resultaat van isStaffForCourse

// Per-tabel FIFO-wachtrij met Supabase-resultaten ({data, error}). Elke
// ge-awaite query consumeert het volgende item voor die tabel.
let sbQueues;
// Storage-resultaten.
let storageState;
// pgPool.query-resultaat.
let pgRows;

function queueResult(table, result) {
  (sbQueues[table] ||= []).push(result);
}

function nextResult(table) {
  const q = sbQueues[table];
  if (q && q.length) return q.shift();
  return { data: null, error: null };
}

// Chainable + thenable query-builder die het volgende wachtrij-item oplevert.
function makeBuilder(table) {
  const builder = {
    select: () => builder,
    insert: () => builder,
    upsert: () => builder,
    update: () => builder,
    delete: () => builder,
    eq: () => builder,
    in: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: () => Promise.resolve(nextResult(table)),
    single: () => Promise.resolve(nextResult(table)),
    then: (onFulfilled, onRejected) =>
      Promise.resolve(nextResult(table)).then(onFulfilled, onRejected),
  };
  return builder;
}

const supabaseAdminMock = {
  from: (table) => makeBuilder(table),
  storage: {
    from: () => ({
      upload: () => Promise.resolve(storageState.upload),
      remove: () => Promise.resolve({ data: null, error: null }),
      createSignedUrl: () => Promise.resolve(storageState.signed),
    }),
  },
};

const pgPoolMock = {
  query: () => Promise.resolve({ rows: pgRows }),
};

const requireAuthUserMock = async (req, res) => {
  if (!authState) {
    res.status(401).json({ error: 'Niet geauthenticeerd' });
    return null;
  }
  return authState;
};

const deps = {
  supabaseAdmin: supabaseAdminMock,
  pgPool: pgPoolMock,
  getFileMimeType: () => 'application/octet-stream',
  requireAuthUser: requireAuthUserMock,
  userHasCourseAccess: async () => accessState,
  isStaffForCourse: async () => staffState,
  docUpload: multer({ storage: multer.memoryStorage() }),
};

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  registerCourseInfoRoutes(app, deps);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  if (server) server.close();
});

beforeEach(() => {
  // Standaard: ingelogd cursuslid, geen staff, lege query-wachtrijen.
  authState = { user: { id: 'user-1' }, profile: { role: 'student', email: 's@vu.nl' } };
  accessState = true;
  staffState = false;
  sbQueues = {};
  storageState = {
    upload: { data: { path: 'p' }, error: null },
    signed: { data: { signedUrl: 'https://signed.example/file' }, error: null },
  };
  pgRows = [];
});

const COURSE = 'course-abc';

function api(path, opts = {}) {
  return fetch(`${baseUrl}${path}`, {
    headers: { Authorization: 'Bearer tkn', 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
}

describe('GET /api/courses/:courseId/info (lezen = cursuslid)', () => {
  it('weigert niet-geauthenticeerde gebruiker met 401', async () => {
    authState = null;
    const res = await api(`/api/courses/${COURSE}/info`);
    expect(res.status).toBe(401);
  });

  it('weigert niet-lid met 403', async () => {
    accessState = false;
    const res = await api(`/api/courses/${COURSE}/info`);
    expect(res.status).toBe(403);
  });

  it('staat cursuslid lezen toe en geeft canEdit=false voor niet-staff', async () => {
    accessState = true;
    staffState = false;
    queueResult('course_info', { data: { body: 'Welkom', updated_at: '2026-01-01' }, error: null });
    queueResult('course_info_documents', { data: [], error: null }); // loadCourseInfoDocuments
    const res = await api(`/api/courses/${COURSE}/info`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.body).toBe('Welkom');
    expect(json.canEdit).toBe(false);
  });

  it('geeft canEdit=true voor staff', async () => {
    accessState = true;
    staffState = true;
    queueResult('course_info', { data: { body: '', updated_at: null }, error: null });
    queueResult('course_info_documents', { data: [], error: null });
    const res = await api(`/api/courses/${COURSE}/info`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.canEdit).toBe(true);
  });
});

describe('PUT /api/courses/:courseId/info (schrijven = staff)', () => {
  it('weigert lid-maar-niet-staff met 403', async () => {
    accessState = true;
    staffState = false;
    const res = await api(`/api/courses/${COURSE}/info`, {
      method: 'PUT',
      body: JSON.stringify({ body: 'nieuw' }),
    });
    expect(res.status).toBe(403);
  });

  it('staat staff toe op te slaan (200)', async () => {
    staffState = true;
    queueResult('course_info', { error: null }); // upsert
    const res = await api(`/api/courses/${COURSE}/info`, {
      method: 'PUT',
      body: JSON.stringify({ body: 'nieuw' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('weigert te lange tekst met 400 (staff)', async () => {
    staffState = true;
    const res = await api(`/api/courses/${COURSE}/info`, {
      method: 'PUT',
      body: JSON.stringify({ body: 'x'.repeat(20001) }),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/courses/:courseId/info/available-files (staff-only)', () => {
  it('weigert niet-staff met 403', async () => {
    staffState = false;
    const res = await api(`/api/courses/${COURSE}/info/available-files`);
    expect(res.status).toBe(403);
  });

  it('staat staff toe en filtert al gekoppelde bestanden weg', async () => {
    staffState = true;
    // getCourseFolderIds: course_folder_assignments, document_folders
    queueResult('course_folder_assignments', { data: [{ folder_id: 'f1' }], error: null });
    queueResult('document_folders', { data: [{ id: 'f1', parent_folder_id: null }], error: null });
    // documents in folder
    queueResult('documents', {
      data: [
        { id: 'd1', title: 'A', filename: 'a.pdf', file_type: 'pdf', file_size: 1, folder_id: 'f1', document_folders: { name: 'Map' } },
        { id: 'd2', title: 'B', filename: 'b.pdf', file_type: 'pdf', file_size: 2, folder_id: 'f1', document_folders: { name: 'Map' } },
      ],
      error: null,
    });
    // reeds gekoppeld
    queueResult('course_info_documents', { data: [{ document_id: 'd1' }], error: null });
    const res = await api(`/api/courses/${COURSE}/info/available-files`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.files.map((f) => f.id)).toEqual(['d2']);
  });
});

describe('POST /api/courses/:courseId/info/documents (koppelen = staff, geen cross-course)', () => {
  it('weigert niet-staff met 403', async () => {
    staffState = false;
    const res = await api(`/api/courses/${COURSE}/info/documents`, {
      method: 'POST',
      body: JSON.stringify({ documentIds: ['d1'] }),
    });
    expect(res.status).toBe(403);
  });

  it('weigert lege selectie met 400', async () => {
    staffState = true;
    const res = await api(`/api/courses/${COURSE}/info/documents`, {
      method: 'POST',
      body: JSON.stringify({ documentIds: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('weigert een vreemd document buiten de cursusmappen met 400', async () => {
    staffState = true;
    // getCourseFolderIds → cursusmappen = {f1}
    queueResult('course_folder_assignments', { data: [{ folder_id: 'f1' }], error: null });
    queueResult('document_folders', { data: [{ id: 'f1', parent_folder_id: null }], error: null });
    // documents-lookup geeft een doc terug dat in een VREEMDE map (fX) zit
    queueResult('documents', { data: [{ id: 'foreign', folder_id: 'fX' }], error: null });
    const res = await api(`/api/courses/${COURSE}/info/documents`, {
      method: 'POST',
      body: JSON.stringify({ documentIds: ['foreign'] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/geldige cursusbestanden/i);
  });

  it('koppelt geldige cursusbestanden (200)', async () => {
    staffState = true;
    queueResult('course_folder_assignments', { data: [{ folder_id: 'f1' }], error: null });
    queueResult('document_folders', { data: [{ id: 'f1', parent_folder_id: null }], error: null });
    queueResult('documents', { data: [{ id: 'd1', folder_id: 'f1' }], error: null });
    queueResult('course_info_documents', { data: [{ sort_order: 0 }], error: null }); // nextSortOrder
    queueResult('course_info_documents', { error: null }); // upsert
    queueResult('course_info_documents', { data: [], error: null }); // loadCourseInfoDocuments
    const res = await api(`/api/courses/${COURSE}/info/documents`, {
      method: 'POST',
      body: JSON.stringify({ documentIds: ['d1'] }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});

describe('POST /api/courses/:courseId/info/documents/upload (upload = staff)', () => {
  function uploadReq(extraStaff = true) {
    staffState = extraStaff;
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('hello')], { type: 'text/plain' }), 'notes.txt');
    return fetch(`${baseUrl}/api/courses/${COURSE}/info/documents/upload`, {
      method: 'POST',
      headers: { Authorization: 'Bearer tkn' },
      body: form,
    });
  }

  it('weigert niet-staff met 403', async () => {
    const res = await uploadReq(false);
    expect(res.status).toBe(403);
  });

  it('staat staff toe te uploaden en koppelt het bestand (200)', async () => {
    // ensureCourseInfoFolder: course_folder_assignments + maybeSingle(existing)
    queueResult('course_folder_assignments', {
      data: [{ folder_id: 'f1', document_folders: { id: 'f1', folder_type: 'course' } }],
      error: null,
    });
    queueResult('document_folders', { data: { id: 'sub-info' }, error: null }); // existing maybeSingle
    // documents.insert().select().single()
    queueResult('documents', { data: { id: 'newdoc' }, error: null });
    // nextCourseInfoSortOrder
    queueResult('course_info_documents', { data: [], error: null });
    // insert koppeling
    queueResult('course_info_documents', { error: null });
    // loadCourseInfoDocuments
    queueResult('course_info_documents', { data: [], error: null });
    const res = await uploadReq(true);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});

describe('DELETE /api/courses/:courseId/info/documents/:documentId (ontkoppelen = staff)', () => {
  it('weigert niet-staff met 403', async () => {
    staffState = false;
    const res = await api(`/api/courses/${COURSE}/info/documents/d1`, { method: 'DELETE' });
    expect(res.status).toBe(403);
  });

  it('staat staff toe te ontkoppelen (200)', async () => {
    staffState = true;
    queueResult('course_info_documents', { error: null }); // delete
    const res = await api(`/api/courses/${COURSE}/info/documents/d1`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});

describe('GET /api/courses/:courseId/info/documents/:documentId/download (lezen = cursuslid, koppeling vereist)', () => {
  it('weigert niet-lid met 403', async () => {
    accessState = false;
    const res = await api(`/api/courses/${COURSE}/info/documents/d1/download`);
    expect(res.status).toBe(403);
  });

  it('weigert een document dat niet aan deze cursus gekoppeld is met 404', async () => {
    accessState = true;
    queueResult('course_info_documents', { data: null, error: null }); // geen koppeling
    const res = await api(`/api/courses/${COURSE}/info/documents/foreign/download`);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/niet gekoppeld/i);
  });

  it('geeft een signed URL voor een gekoppeld bestand (200)', async () => {
    accessState = true;
    queueResult('course_info_documents', { data: { document_id: 'd1' }, error: null }); // koppeling bestaat
    queueResult('documents', {
      data: { id: 'd1', title: 'A', filename: 'a.pdf', file_path: 'course/a.pdf', bucket: 'docs_general', mime_type: 'application/pdf', file_type: 'pdf' },
      error: null,
    });
    const res = await api(`/api/courses/${COURSE}/info/documents/d1/download`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.url).toBe('https://signed.example/file');
  });
});
