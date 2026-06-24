import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import mammoth from 'mammoth';
import { STORAGE_CONFIG } from '../config/storage.config';

// pdfjs-dist v5 levert de worker uitsluitend als ES-module (`pdf.worker.min.mjs`);
// de oude cdnjs `pdf.worker.min.js`-URL bestaat niet meer voor v5, waardoor het
// dynamisch importeren faalde ("Setting up fake worker failed"). We laden daarom de
// gebundelde worker lokaal via Vite `?url`, identiek aan src/components/DocumentViewer.tsx.
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export interface DocumentChunk {
  text: string;
  metadata: {
    pageNumber?: number;
    startPosition: number;
    endPosition: number;
  };
}

export interface ProcessedDocument {
  text: string;
  chunks: DocumentChunk[];
  metadata: {
    pageCount?: number;
    wordCount: number;
  };
}

function estimateTokenCount(text: string): number {
  return Math.ceil(text.split(/\s+/).length * 1.3);
}

function chunkText(
  text: string,
  targetTokens: number = STORAGE_CONFIG.chunkConfig.targetTokens,
  overlapTokens: number = STORAGE_CONFIG.chunkConfig.overlapTokens
): DocumentChunk[] {
  const paragraphs = text.split(/\n\n+/);
  const chunks: DocumentChunk[] = [];
  let currentChunk = '';
  let startPosition = 0;

  const maxTokens = STORAGE_CONFIG.chunkConfig.maxTokens;
  const minTokens = STORAGE_CONFIG.chunkConfig.minTokens;

  for (const paragraph of paragraphs) {
    const trimmedParagraph = paragraph.trim();
    if (!trimmedParagraph) continue;

    const testChunk = currentChunk ? `${currentChunk}\n\n${trimmedParagraph}` : trimmedParagraph;
    const tokenCount = estimateTokenCount(testChunk);

    if (tokenCount > targetTokens && currentChunk) {
      const currentTokenCount = estimateTokenCount(currentChunk);

      if (currentTokenCount > maxTokens) {
        const sentences = currentChunk.match(/[^.!?]+[.!?]+/g) || [currentChunk];
        let subChunk = '';

        for (const sentence of sentences) {
          const testSubChunk = subChunk ? `${subChunk} ${sentence}` : sentence;
          const subTokenCount = estimateTokenCount(testSubChunk);

          if (subTokenCount > maxTokens && subChunk) {
            const endPosition = startPosition + subChunk.length;
            chunks.push({
              text: subChunk,
              metadata: {
                startPosition,
                endPosition,
              },
            });

            const words = subChunk.split(/\s+/);
            const overlapWords = Math.floor(overlapTokens / 1.3);
            const overlap = words.slice(-overlapWords).join(' ');

            startPosition = endPosition - overlap.length;
            subChunk = overlap ? `${overlap} ${sentence}` : sentence;
          } else {
            subChunk = testSubChunk;
          }
        }

        if (subChunk) {
          currentChunk = subChunk;
        }
      }

      if (currentTokenCount >= minTokens || currentChunk.length > 0) {
        const endPosition = startPosition + currentChunk.length;
        chunks.push({
          text: currentChunk,
          metadata: {
            startPosition,
            endPosition,
          },
        });

        const words = currentChunk.split(/\s+/);
        const overlapWords = Math.floor(overlapTokens / 1.3);
        const overlap = words.slice(-overlapWords).join(' ');

        startPosition = endPosition - overlap.length;
        currentChunk = overlap ? `${overlap}\n\n${trimmedParagraph}` : trimmedParagraph;
      }
    } else {
      currentChunk = testChunk;
    }
  }

  if (currentChunk) {
    const finalTokenCount = estimateTokenCount(currentChunk);
    if (finalTokenCount >= minTokens || chunks.length === 0) {
      chunks.push({
        text: currentChunk,
        metadata: {
          startPosition,
          endPosition: startPosition + currentChunk.length,
        },
      });
    } else if (chunks.length > 0) {
      const lastChunk = chunks[chunks.length - 1];
      lastChunk.text = `${lastChunk.text}\n\n${currentChunk}`;
      lastChunk.metadata.endPosition = lastChunk.metadata.startPosition + lastChunk.text.length;
    }
  }

  return chunks;
}

export async function processPDF(file: File): Promise<ProcessedDocument> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdfDoc = await loadingTask.promise;

    const textParts: string[] = [];
    const numPages = pdfDoc.numPages;

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item: any) => item.str)
        .join(' ');
      textParts.push(pageText);
    }

    const text = textParts.join('\n\n');
    const chunks = chunkText(text);

    return {
      text,
      chunks,
      metadata: {
        pageCount: numPages,
        wordCount: text.split(/\s+/).length,
      },
    };
  } catch (error) {
    throw new Error(`Failed to process PDF: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function processDOCX(file: File): Promise<ProcessedDocument> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });

    const text = result.value;
    const chunks = chunkText(text);

    return {
      text,
      chunks,
      metadata: {
        wordCount: text.split(/\s+/).length,
      },
    };
  } catch (error) {
    throw new Error(`Failed to process DOCX: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function processPPTX(file: File): Promise<ProcessedDocument> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);

    let text = '';

    const decoder = new TextDecoder('utf-8');
    const fileContent = decoder.decode(uint8Array);

    const slideTextMatches = fileContent.matchAll(/<a:t[^>]*>([^<]+)<\/a:t>/g);
    const textParts: string[] = [];

    for (const match of slideTextMatches) {
      if (match[1] && match[1].trim()) {
        textParts.push(match[1].trim());
      }
    }

    text = textParts.join('\n\n');

    if (!text || text.trim().length < 10) {
      throw new Error('Could not extract text from PowerPoint file. The file may be empty or corrupted.');
    }

    const chunks = chunkText(text);

    return {
      text,
      chunks,
      metadata: {
        wordCount: text.split(/\s+/).length,
      },
    };
  } catch (error) {
    throw new Error(`Failed to process PPTX: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function processTXT(file: File): Promise<ProcessedDocument> {
  try {
    const text = await file.text();
    const chunks = chunkText(text);

    return {
      text,
      chunks,
      metadata: {
        wordCount: text.split(/\s+/).length,
      },
    };
  } catch (error) {
    throw new Error(`Failed to process TXT: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function processDocument(file: File): Promise<ProcessedDocument> {
  const extension = file.name.split('.').pop()?.toLowerCase();

  switch (extension) {
    case 'pdf':
      return processPDF(file);
    case 'docx':
      return processDOCX(file);
    case 'pptx':
      return processPPTX(file);
    case 'txt':
      return processTXT(file);
    default:
      throw new Error(`Unsupported file type: ${extension}`);
  }
}

export function validateDocumentFile(file: File, bucketType: string = 'rag_sources'): { valid: boolean; error?: string } {
  const maxSize = bucketType === 'datasets' ? 50 * 1024 * 1024 : bucketType === 'docs_general' ? 10 * 1024 * 1024 : 20 * 1024 * 1024;

  const allowedTypesMap: Record<string, string[]> = {
    rag_sources: [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain',
    ],
    datasets: [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv',
      'application/octet-stream',
    ],
    docs_general: [],
  };

  const allowedExtensionsMap: Record<string, string[]> = {
    rag_sources: ['pdf', 'docx', 'pptx', 'txt'],
    datasets: ['xlsx', 'csv', 'omv'],
    docs_general: ['pdf', 'docx', 'pptx', 'txt', 'xlsx', 'csv', 'zip', 'jpg', 'png'],
  };

  if (file.size > maxSize) {
    const maxSizeMB = Math.floor(maxSize / (1024 * 1024));
    return { valid: false, error: `Bestand is te groot. Maximum is ${maxSizeMB}MB.` };
  }

  const extension = file.name.split('.').pop()?.toLowerCase();
  const allowedExtensions = allowedExtensionsMap[bucketType] || allowedExtensionsMap.rag_sources;

  if (!extension || !allowedExtensions.includes(extension)) {
    return {
      valid: false,
      error: `Bestandstype .${extension} is niet toegestaan voor ${bucketType}. Toegestaan: ${allowedExtensions.join(', ')}.`,
    };
  }

  const allowedTypes = allowedTypesMap[bucketType] || [];
  if (allowedTypes.length > 0 && !allowedTypes.includes(file.type) && file.type !== '') {
    return { valid: false, error: 'Bestandstype wordt niet ondersteund.' };
  }

  return { valid: true };
}
