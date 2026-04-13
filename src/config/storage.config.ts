export const STORAGE_CONFIG = {
  buckets: {
    RAG_SOURCES: 'rag_sources',
    DATASETS: 'datasets',
    DOCS_GENERAL: 'docs_general',
  },

  allowedFileTypes: {
    rag_sources: ['.pdf', '.docx', '.pptx', '.txt'],
    datasets: ['.xlsx', '.csv', '.omv'],
    docs_general: ['.pdf', '.docx', '.pptx', '.txt', '.xlsx', '.csv', '.zip', '.jpg', '.png'],
  },

  maxFileSizes: {
    rag_sources: 20 * 1024 * 1024,
    datasets: 50 * 1024 * 1024,
    docs_general: 10 * 1024 * 1024,
  },

  ragEnabled: {
    rag_sources: true,
    datasets: false,
    docs_general: false,
  },

  chunkConfig: {
    targetTokens: 1000,
    minTokens: 400,
    maxTokens: 1200,
    overlapTokens: 150,
  },

  mimeTypes: {
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.txt': 'text/plain',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.csv': 'text/csv',
    '.omv': 'application/octet-stream',
    '.zip': 'application/zip',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
  },
} as const;

export type BucketType = keyof typeof STORAGE_CONFIG.allowedFileTypes;
export type BucketName = typeof STORAGE_CONFIG.buckets[keyof typeof STORAGE_CONFIG.buckets];

export function getBucketForType(bucketType: BucketType): BucketName {
  return STORAGE_CONFIG.buckets[bucketType.toUpperCase() as keyof typeof STORAGE_CONFIG.buckets] || STORAGE_CONFIG.buckets.DOCS_GENERAL;
}

export function getMaxFileSize(bucketType: BucketType): number {
  return STORAGE_CONFIG.maxFileSizes[bucketType] || STORAGE_CONFIG.maxFileSizes.docs_general;
}

export function getAllowedFileTypes(bucketType: BucketType): string[] {
  return STORAGE_CONFIG.allowedFileTypes[bucketType] || [];
}

export function isRagEnabled(bucketType: BucketType): boolean {
  return STORAGE_CONFIG.ragEnabled[bucketType] || false;
}

export function validateFileForBucket(fileName: string, bucketType: BucketType): { valid: boolean; error?: string } {
  const extension = '.' + fileName.split('.').pop()?.toLowerCase();
  const allowedTypes = getAllowedFileTypes(bucketType);

  if (!allowedTypes.includes(extension)) {
    return {
      valid: false,
      error: `Bestandstype ${extension} is niet toegestaan voor ${bucketType}. Toegestaan: ${allowedTypes.join(', ')}`,
    };
  }

  return { valid: true };
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}
