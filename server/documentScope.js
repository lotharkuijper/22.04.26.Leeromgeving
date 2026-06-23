// Pure helper voor Task #335: bereken de set folder-ids die een docent mag
// zien én beheren in de Documenten-tab, gegeven de aan zijn cursus(sen)
// gekoppelde submap-ids en de volledige mappenlijst. Geen Supabase-afhankelijkheid
// zodat de beveiligingslogica los unit-getest kan worden.
//
// De Documenten-tab draait op de admin-endpoints (service-role, RLS-bypass), dus
// autorisatie moet op applicatieniveau. Het mappenmodel is:
//   root (is_root=true)
//     └─ cursus-map (folder_type='course')        ← NIET in course_folder_assignments
//          ├─ RAG (rag_sources)  ┐
//          ├─ Data (data)        ├─ WEL gekoppeld via course_folder_assignments
//          └─ Uploads (uploads)  ┘
//
// Beveiliging: een gekoppelde submap breidt de scope alleen uit naar zijn ouder
// als die ouder folder_type==='course' én niet is_root is. Zo kan een foutieve
// koppeling waarvan de ouder de globale root (of een niet-cursus-map) is nooit
// de hele boom ontsluiten. Vervolgens verzamelt een BFS alle nakomelingen van de
// startpunten (inclusief later door docenten aangemaakte submappen).
export function computeTeacherFolderScope(assignedFolderIds, folders) {
  const out = new Set();
  const assigned = [...new Set((assignedFolderIds || []).filter(Boolean))];
  if (!assigned.length) return out;

  const byId = new Map();
  const childrenOf = new Map();
  for (const f of folders || []) {
    if (!f || !f.id) continue;
    byId.set(f.id, f);
    if (f.parent_folder_id) {
      if (!childrenOf.has(f.parent_folder_id)) childrenOf.set(f.parent_folder_id, []);
      childrenOf.get(f.parent_folder_id).push(f.id);
    }
  }

  // BFS-startpunten: elke gekoppelde submap zelf + ALLEEN een gevalideerde
  // 'course'-shell als ouder. Nooit een root/niet-course ouder toevoegen.
  const roots = new Set();
  for (const fid of assigned) {
    if (!byId.has(fid)) continue;
    roots.add(fid);
    const parentId = byId.get(fid).parent_folder_id;
    const parent = parentId ? byId.get(parentId) : null;
    if (parent && parent.folder_type === 'course' && parent.is_root !== true) {
      roots.add(parent.id);
    }
  }

  const stack = [...roots];
  while (stack.length) {
    const id = stack.pop();
    if (out.has(id)) continue;
    out.add(id);
    for (const c of childrenOf.get(id) || []) stack.push(c);
  }
  return out;
}
