import { supabase } from '../lib/supabase';
import { Database } from '../lib/database.types';

type Role = 'student' | 'docent' | 'admin';
type FolderPermission = Database['public']['Tables']['folder_permissions']['Row'];
type DocumentPermission = Database['public']['Tables']['document_permissions']['Row'];
type RAGAssignment = Database['public']['Tables']['folder_rag_assignments']['Row'];

export async function getFolderPermissions(folderId: string): Promise<FolderPermission[]> {
  const { data, error } = await supabase
    .from('folder_permissions')
    .select('*')
    .eq('folder_id', folderId);

  if (error) throw error;
  return data || [];
}

export async function setFolderPermission(
  folderId: string,
  role: Role,
  canView: boolean,
  canEdit: boolean
): Promise<void> {
  const { error } = await supabase
    .from('folder_permissions')
    .upsert({
      folder_id: folderId,
      role,
      can_view: canView,
      can_edit: canEdit,
    }, {
      onConflict: 'folder_id,role'
    });

  if (error) throw error;
}

export async function deleteFolderPermission(
  folderId: string,
  role: Role
): Promise<void> {
  const { error } = await supabase
    .from('folder_permissions')
    .delete()
    .eq('folder_id', folderId)
    .eq('role', role);

  if (error) throw error;
}

export async function getDocumentPermissions(documentId: string): Promise<DocumentPermission[]> {
  const { data, error } = await supabase
    .from('document_permissions')
    .select('*')
    .eq('document_id', documentId);

  if (error) throw error;
  return data || [];
}

export async function setDocumentPermission(
  documentId: string,
  role: Role,
  canView: boolean
): Promise<void> {
  const { error } = await supabase
    .from('document_permissions')
    .upsert({
      document_id: documentId,
      role,
      can_view: canView,
    }, {
      onConflict: 'document_id,role'
    });

  if (error) throw error;
}

export async function deleteDocumentPermission(
  documentId: string,
  role: Role
): Promise<void> {
  const { error } = await supabase
    .from('document_permissions')
    .delete()
    .eq('document_id', documentId)
    .eq('role', role);

  if (error) throw error;
}

export async function applyFolderPermissionsToDocuments(
  folderId: string,
  role: Role,
  canView: boolean
): Promise<void> {
  const { data: documents } = await supabase
    .from('documents')
    .select('id')
    .eq('folder_id', folderId);

  if (!documents || documents.length === 0) return;

  const permissions = documents.map(doc => ({
    document_id: doc.id,
    role,
    can_view: canView,
  }));

  const { error } = await supabase
    .from('document_permissions')
    .upsert(permissions, {
      onConflict: 'document_id,role'
    });

  if (error) throw error;
}

export async function checkFolderAccess(
  folderId: string,
  userRole: Role
): Promise<{ canView: boolean; canEdit: boolean }> {
  if (userRole === 'admin') {
    return { canView: true, canEdit: true };
  }

  const { data } = await supabase
    .from('folder_permissions')
    .select('can_view, can_edit')
    .eq('folder_id', folderId)
    .eq('role', userRole)
    .maybeSingle();

  return {
    canView: data?.can_view || false,
    canEdit: data?.can_edit || false,
  };
}

export async function checkDocumentAccess(
  documentId: string,
  userRole: Role
): Promise<boolean> {
  if (userRole === 'admin') {
    return true;
  }

  const { data: doc } = await supabase
    .from('documents')
    .select('folder_id')
    .eq('id', documentId)
    .maybeSingle();

  if (!doc) return false;

  if (doc.folder_id) {
    const folderAccess = await checkFolderAccess(doc.folder_id, userRole);
    if (folderAccess.canView) return true;
  }

  const { data: permission } = await supabase
    .from('document_permissions')
    .select('can_view')
    .eq('document_id', documentId)
    .eq('role', userRole)
    .maybeSingle();

  return permission?.can_view || false;
}

export async function getAccessibleFolders(userRole: Role): Promise<string[]> {
  if (userRole === 'admin') {
    const { data } = await supabase
      .from('document_folders')
      .select('id');

    return data?.map(f => f.id) || [];
  }

  const { data } = await supabase
    .from('folder_permissions')
    .select('folder_id')
    .eq('role', userRole)
    .eq('can_view', true);

  return data?.map(p => p.folder_id) || [];
}

export async function getRAGAssignments(folderId: string): Promise<RAGAssignment[]> {
  const { data, error } = await supabase
    .from('folder_rag_assignments')
    .select('*')
    .eq('folder_id', folderId);

  if (error) throw error;
  return data || [];
}

export async function setRAGAssignment(
  folderId: string,
  moduleType: 'general' | 'explain' | 'project' | 'quiz',
  isActive: boolean
): Promise<void> {
  const { error } = await supabase
    .from('folder_rag_assignments')
    .upsert({
      folder_id: folderId,
      module_type: moduleType,
      is_active: isActive,
    }, {
      onConflict: 'folder_id,module_type'
    });

  if (error) throw error;
}

export async function getActiveFoldersForModule(
  moduleType: 'general' | 'explain' | 'project' | 'quiz'
): Promise<string[]> {
  const { data, error } = await supabase
    .from('folder_rag_assignments')
    .select('folder_id')
    .eq('module_type', moduleType)
    .eq('is_active', true);

  if (error) throw error;
  return data?.map(a => a.folder_id) || [];
}
