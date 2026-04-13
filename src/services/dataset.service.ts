import { supabase } from '../lib/supabase';
import { STORAGE_CONFIG, getBucketForType } from '../config/storage.config';

export interface Dataset {
  id: string;
  name: string;
  description: string | null;
  file_path: string;
  file_size: number;
  file_type: string;
  uploaded_by: string;
  folder_id: string | null;
  created_at: string;
  uploader_name?: string;
}

export async function uploadDataset(
  file: File,
  name: string,
  description: string | null,
  folderId: string | null
): Promise<{ success: boolean; error?: string; datasetId?: string }> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return { success: false, error: 'Not authenticated' };
    }

    const extension = file.name.split('.').pop()?.toLowerCase();
    if (!['xlsx', 'csv', 'omv'].includes(extension || '')) {
      return { success: false, error: 'Invalid file type for dataset' };
    }

    const fileName = `${user.id}/${Date.now()}_${file.name}`;
    const bucket = STORAGE_CONFIG.buckets.DATASETS;

    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(fileName, file, {
        cacheControl: '3600',
        upsert: false,
      });

    if (uploadError) {
      console.error('Upload error:', uploadError);
      return { success: false, error: uploadError.message };
    }

    const { data: document, error: dbError } = await supabase
      .from('documents')
      .insert({
        name,
        description,
        file_path: fileName,
        file_size: file.size,
        file_type: file.type || 'application/octet-stream',
        uploaded_by: user.id,
        folder_id: folderId,
        bucket: bucket,
        processing_status: 'completed',
      })
      .select()
      .single();

    if (dbError) {
      await supabase.storage.from(bucket).remove([fileName]);
      return { success: false, error: dbError.message };
    }

    return { success: true, datasetId: document.id };
  } catch (error: any) {
    console.error('Error uploading dataset:', error);
    return { success: false, error: error.message || 'Unknown error' };
  }
}

export async function getDatasets(folderId?: string): Promise<Dataset[]> {
  try {
    let query = supabase
      .from('documents')
      .select(`
        *,
        profiles!documents_uploaded_by_fkey (
          full_name
        )
      `)
      .eq('bucket', STORAGE_CONFIG.buckets.DATASETS)
      .order('created_at', { ascending: false });

    if (folderId) {
      query = query.eq('folder_id', folderId);
    }

    const { data, error } = await query;

    if (error) throw error;

    return (data || []).map(doc => ({
      id: doc.id,
      name: doc.name,
      description: doc.description,
      file_path: doc.file_path,
      file_size: doc.file_size,
      file_type: doc.file_type,
      uploaded_by: doc.uploaded_by,
      folder_id: doc.folder_id,
      created_at: doc.created_at,
      uploader_name: doc.profiles?.full_name,
    }));
  } catch (error: any) {
    console.error('Error fetching datasets:', error);
    return [];
  }
}

export async function downloadDataset(dataset: Dataset): Promise<{ success: boolean; error?: string; blob?: Blob }> {
  try {
    const { data, error } = await supabase.storage
      .from(STORAGE_CONFIG.buckets.DATASETS)
      .download(dataset.file_path);

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, blob: data };
  } catch (error: any) {
    console.error('Error downloading dataset:', error);
    return { success: false, error: error.message };
  }
}

export async function deleteDataset(datasetId: string, filePath: string): Promise<{ success: boolean; error?: string }> {
  try {
    const { error: storageError } = await supabase.storage
      .from(STORAGE_CONFIG.buckets.DATASETS)
      .remove([filePath]);

    if (storageError) {
      console.error('Storage deletion error:', storageError);
    }

    const { error: dbError } = await supabase
      .from('documents')
      .delete()
      .eq('id', datasetId);

    if (dbError) {
      return { success: false, error: dbError.message };
    }

    return { success: true };
  } catch (error: any) {
    console.error('Error deleting dataset:', error);
    return { success: false, error: error.message };
  }
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

export function getFileIcon(fileType: string): string {
  if (fileType.includes('sheet') || fileType.includes('excel')) return '📊';
  if (fileType.includes('csv')) return '📄';
  return '📦';
}
