---
name: Admin document-folder tree scoping
description: How teacher access to the "Beheer > Documenten" folder tree is scoped, and the folder→course model behind it.
---

# Admin document-folder tree scoping

The "Beheer > Documenten" tab (`src/pages/DocumentsPage.tsx`) runs **entirely** on
the `/api/admin/...` document endpoints, which use `supabaseAdmin` (service-role) and
therefore **bypass RLS**. Any per-course access control for those endpoints must be
enforced at the application layer — RLS will not save you here.

## Folder → course model
Course creation builds: `root (is_root=true)` → `cursus-map (folder_type='course')`
→ subfolders RAG (`rag_sources`) / Data (`data`) / Uploads (`uploads`).
`course_folder_assignments` links a `course_id` **only to the 3 subfolders** — never
to the `course` shell and never to the root.

## Scoping rule (teachers)
A teacher's manageable scope = BFS over the folder tree starting from each assigned
subfolder **plus** its parent, but the parent is added **only if**
`parent.folder_type === 'course' && parent.is_root !== true`.

**Why:** if you BFS from an *unvalidated* parent, a malformed/legacy
`course_folder_assignments` row whose parent is the global root would expand the
teacher to every folder (root + all other courses). Validating the `course` shell
keeps a bad row contained to just that orphan subfolder.

**How to apply:** the pure algorithm lives in `server/documentScope.js`
(`computeTeacherFolderScope`, unit-tested). Server gates go through
`resolveDocFolderAccess(r, folderId)` (admin→always, non-teacher or missing
folderId→deny, else scope membership). Additional non-admin guards: force
`folder_type='general'` on folder create (don't trust client type / let teachers mint
privileged types), block deletion of `is_root`/`folder_type='course'` containers, and
`SELECT folder_id` + fail-closed on download/delete-document.
