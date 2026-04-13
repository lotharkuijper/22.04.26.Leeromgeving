import { supabase } from '../lib/supabase';
import { Database } from '../lib/database.types';

type Folder = Database['public']['Tables']['document_folders']['Row'];
type FolderInsert = Database['public']['Tables']['document_folders']['Insert'];
type FolderUpdate = Database['public']['Tables']['document_folders']['Update'];

export interface FolderWithDocumentCount extends Folder {
  document_count: number;
  children?: FolderWithDocumentCount[];
  folder_type?: string | null;
  is_root?: boolean | null;
}

export interface BreadcrumbItem {
  id: string;
  name: string;
}

async function batchGetDocumentCounts(folderIds: string[]): Promise<Map<string, number>> {
  if (folderIds.length === 0) return new Map();

  const { data, error } = await supabase
    .from('documents')
    .select('folder_id')
    .in('folder_id', folderIds);

  if (error) {
    console.error('Error fetching document counts:', error);
    return new Map();
  }

  const countMap = new Map<string, number>();
  for (const row of data || []) {
    if (row.folder_id) {
      countMap.set(row.folder_id, (countMap.get(row.folder_id) || 0) + 1);
    }
  }
  return countMap;
}

export async function getAllFolders(): Promise<FolderWithDocumentCount[]> {
  const { data, error } = await supabase
    .from('document_folders')
    .select('*')
    .order('name');

  if (error) throw error;

  const folders = data as Folder[];
  const folderMap = new Map<string, FolderWithDocumentCount>();

  const folderIds = folders.map(f => f.id);
  const docCountMap = await batchGetDocumentCounts(folderIds);

  const foldersWithCounts = folders.map((folder) => ({
    ...folder,
    document_count: docCountMap.get(folder.id) || 0,
    children: [],
  }));

  foldersWithCounts.forEach(folder => {
    folderMap.set(folder.id, folder);
  });

  const rootFolders: FolderWithDocumentCount[] = [];

  foldersWithCounts.forEach(folder => {
    if (folder.parent_folder_id) {
      const parent = folderMap.get(folder.parent_folder_id);
      if (parent) {
        parent.children!.push(folder);
      }
    } else {
      rootFolders.push(folder);
    }
  });

  return rootFolders;
}

export async function getFolderById(folderId: string): Promise<FolderWithDocumentCount | null> {
  const { data, error } = await supabase
    .from('document_folders')
    .select('*')
    .eq('id', folderId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const { count } = await supabase
    .from('documents')
    .select('*', { count: 'exact', head: true })
    .eq('folder_id', folderId);

  return {
    ...data,
    document_count: count || 0,
  };
}

export async function createFolder(
  name: string,
  description: string | null,
  parentFolderId: string | null,
  userId: string
): Promise<Folder> {
  const folderData: FolderInsert = {
    name,
    description,
    parent_folder_id: parentFolderId,
    created_by: userId,
  };

  const { data, error } = await supabase
    .from('document_folders')
    .insert(folderData)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function updateFolder(
  folderId: string,
  updates: FolderUpdate
): Promise<Folder> {
  const { data, error } = await supabase
    .from('document_folders')
    .update(updates)
    .eq('id', folderId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function deleteFolder(folderId: string): Promise<void> {
  const { count: docCount } = await supabase
    .from('documents')
    .select('*', { count: 'exact', head: true })
    .eq('folder_id', folderId);

  if (docCount && docCount > 0) {
    throw new Error('Cannot delete folder with documents. Please move or delete documents first.');
  }

  const { count: childCount } = await supabase
    .from('document_folders')
    .select('*', { count: 'exact', head: true })
    .eq('parent_folder_id', folderId);

  if (childCount && childCount > 0) {
    throw new Error('Cannot delete folder with subfolders. Please delete subfolders first.');
  }

  const { error } = await supabase
    .from('document_folders')
    .delete()
    .eq('id', folderId);

  if (error) throw error;
}

export async function moveDocumentToFolder(
  documentId: string,
  targetFolderId: string | null
): Promise<void> {
  const { error } = await supabase
    .from('documents')
    .update({ folder_id: targetFolderId })
    .eq('id', documentId);

  if (error) throw error;

  if (targetFolderId) {
    const { data: doc } = await supabase
      .from('documents')
      .select('file_path')
      .eq('id', documentId)
      .single();

    if (doc?.file_path) {
      const fileName = doc.file_path.split('/').pop();
      const newPath = `${targetFolderId}/${fileName}`;

      const { data: fileData, error: downloadError } = await supabase.storage
        .from('documents')
        .download(doc.file_path);

      if (!downloadError && fileData) {
        await supabase.storage
          .from('documents')
          .upload(newPath, fileData);

        await supabase.storage
          .from('documents')
          .remove([doc.file_path]);

        await supabase
          .from('documents')
          .update({ file_path: newPath })
          .eq('id', documentId);
      }
    }
  }
}

export async function getDocumentsInFolder(folderId: string | null) {
  const query = supabase
    .from('documents')
    .select('*')
    .order('created_at', { ascending: false });

  if (folderId === null) {
    query.is('folder_id', null);
  } else {
    query.eq('folder_id', folderId);
  }

  const { data, error } = await query;

  if (error) throw error;
  return data;
}

export async function getRootFolder(): Promise<Folder | null> {
  const { data, error } = await supabase
    .from('document_folders')
    .select('*')
    .eq('is_root', true)
    .maybeSingle();

  if (error) throw error;

  // Bolt fallback: create root folder if missing
  if (!data) {
    const { data: newRoot, error: insertError } = await supabase
      .from('document_folders')
      .insert({
        name: 'Documenten',
        description: 'Root folder',
        parent_folder_id: null,
        is_root: true,
        created_by: 'bolt-temp-user'
      })
      .select()
      .single();

    if (insertError) throw insertError;
    return newRoot;
  }

  return data;
}

export async function getSubfolders(parentFolderId: string | null): Promise<FolderWithDocumentCount[]> {
  const query = supabase
    .from('document_folders')
    .select('*')
    .order('name');

  if (parentFolderId === null) {
    query.is('parent_folder_id', null);
  } else {
    query.eq('parent_folder_id', parentFolderId);
  }

  const { data, error } = await query;

  if (error) throw error;

  const folders = data as Folder[];
  const folderIds = folders.map(f => f.id);
  const docCountMap = await batchGetDocumentCounts(folderIds);

  const foldersWithCounts = folders.map((folder) => ({
    ...folder,
    document_count: docCountMap.get(folder.id) || 0,
    children: [],
  }));

  return foldersWithCounts;
}

export async function getBreadcrumbPath(folderId: string | null): Promise<BreadcrumbItem[]> {
  if (!folderId) return [];

  const breadcrumbs: BreadcrumbItem[] = [];
  let currentId: string | null = folderId;

  while (currentId) {
    const { data, error } = await supabase
      .from('document_folders')
      .select('id, name, parent_folder_id')
      .eq('id', currentId)
      .maybeSingle();

    if (error) throw error;
    if (!data) break;

    breadcrumbs.unshift({ id: data.id, name: data.name });
    currentId = data.parent_folder_id;
  }

  return breadcrumbs;
}

export async function getFullFolderPath(folderId: string): Promise<string> {
  const breadcrumbs = await getBreadcrumbPath(folderId);
  return breadcrumbs.map(b => b.name).join(' / ');
}

export async function createSubfolder(
  name: string,
  description: string | null,
  parentFolderId: string,
  folderType: string,
  userId: string
): Promise<Folder> {
  const folderData: FolderInsert = {
    name,
    description,
    parent_folder_id: parentFolderId,
    folder_type: folderType,
    is_root: false,
    created_by: userId,
  };

  const { data, error } = await supabase
    .from('document_folders')
    .insert(folderData)
    .select()
    .single();

  if (error) throw error;

  await supabase
    .from('folder_permissions')
    .insert([
      { folder_id: data.id, role: 'admin', can_view: true, can_edit: true },
      { folder_id: data.id, role: 'docent', can_view: true, can_edit: true },
      { folder_id: data.id, role: 'student', can_view: true, can_edit: false },
    ]);

  return data;
}

export async function canUserEditFolder(folderId: string, userId: string): Promise<boolean> {
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .maybeSingle();

  if (!profile) return false;
  if (profile.role === 'admin' || profile.role === 'superuser') return true;

  const { data: permission } = await supabase
    .from('folder_permissions')
    .select('can_edit')
    .eq('folder_id', folderId)
    .eq('role', profile.role)
    .maybeSingle();

  return permission?.can_edit || false;
}

export async function getFolderTree(): Promise<FolderWithDocumentCount[]> {
  const rootFolder = await getRootFolder();
  if (!rootFolder) return [];

  const buildTree = async (folderId: string): Promise<FolderWithDocumentCount> => {
    const folder = await getFolderById(folderId);
    if (!folder) throw new Error('Folder not found');

    const children = await getSubfolders(folderId);
    const childTrees = await Promise.all(
      children.map(child => buildTree(child.id))
    );

    return {
      ...folder,
      children: childTrees,
    };
  };

  const tree = await buildTree(rootFolder.id);
  return [tree];
}

export async function uploadDocument(folderId: string, file: File) {
  const filePath = `${folderId}/${Date.now()}_${file.name}`;

  // Upload naar Supabase Storage
  const { error: uploadError } = await supabase.storage
    .from("documents")
    .upload(filePath, file);

  if (uploadError) throw uploadError;

  // Registreer document in database
  const { data, error } = await supabase
    .from("documents")
    .insert({
      name: file.name,
      folder_id: folderId,
      file_path: filePath,
    })
    .select()
    .single();

  if (error) throw error;

  return data;
}
