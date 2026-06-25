import { supabase } from '../lib/supabase';

async function callChatAPI(messages: { role: string; content: string }[], options: Record<string, any> = {}): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
  } catch {}
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: undefined,
      messages,
      ...options,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || err.error || `API Error: ${response.status}`);
  }

  const data = await response.json();
  const content = data.choices[0]?.message?.content;
  if (!content) throw new Error('Geen response van AI');
  return content;
}

export interface ExtractedConcept {
  name: string;
  definition: string;
  keyPoints: string[];
  examples: string[];
  chunkIds: string[];
  confidence: number;
}

export interface ExtractionProgress {
  stage: 'analyzing' | 'extracting' | 'saving' | 'completed' | 'error';
  progress: number;
  message: string;
  conceptsFound?: number;
}

export type ExtractionProgressCallback = (progress: ExtractionProgress) => void;

export async function extractConceptsFromDocument(
  documentId: string,
  userId: string,
  onProgress?: ExtractionProgressCallback
): Promise<{ conceptIds: string[]; conceptCount: number }> {
  try {
    onProgress?.({
      stage: 'analyzing',
      progress: 10,
      message: 'Document ophalen...',
    });

    const { data: doc, error: docError } = await supabase
      .from('documents')
      .select('*, document_chunks(id, content, chunk_index)')
      .eq('id', documentId)
      .single();

    if (docError || !doc) {
      throw new Error('Document niet gevonden');
    }

    if (!doc.document_chunks || doc.document_chunks.length === 0) {
      throw new Error('Document heeft geen chunks. Verwerk het document eerst opnieuw.');
    }

    onProgress?.({
      stage: 'analyzing',
      progress: 20,
      message: `${doc.document_chunks.length} chunks analyseren...`,
    });

    const chunks = doc.document_chunks
      .sort((a: any, b: any) => a.chunk_index - b.chunk_index)
      .slice(0, 20);

    const combinedText = chunks
      .map((chunk: any, idx: number) => `[Chunk ${idx + 1}]\n${chunk.content}`)
      .join('\n\n---\n\n');

    onProgress?.({
      stage: 'extracting',
      progress: 40,
      message: 'Begrippen identificeren met AI...',
    });

    const systemPrompt = `Je bent een expert in epidemiologie en biostatistiek. Analyseer de volgende Nederlandse tekst en extraheer alle belangrijke begrippen (concepten) die worden uitgelegd.

Voor elk begrip, geef:
1. name: De naam van het begrip
2. definition: Een heldere definitie (1-2 zinnen)
3. keyPoints: Array van 2-4 kernpunten over dit begrip
4. examples: Array van 1-2 voorbeelden (indien aanwezig in de tekst)
5. chunkIndices: Array van chunk nummers waar dit begrip wordt besproken
6. confidence: Score tussen 0.0 en 1.0 voor hoe zeker je bent dat dit een belangrijk begrip is

Zoek naar:
- Termen die gedefinieerd worden
- Statistische of epidemiologische concepten
- Termen met vetgedrukte of gemarkeerde tekst
- Onderwerpen met kopjes of secties
- Belangrijke formules of methoden

Retourneer een JSON array van begrippen. Alleen begrippen met confidence >= 0.7.

Voorbeeld output:
[
  {
    "name": "Relative Risk",
    "definition": "De ratio van de incidentie in de exposed groep ten opzichte van de non-exposed groep.",
    "keyPoints": [
      "RR = 1 betekent geen associatie",
      "RR > 1 betekent verhoogd risico",
      "RR < 1 betekent beschermend effect"
    ],
    "examples": ["RR van 2.0 betekent dubbel zo hoog risico"],
    "chunkIndices": [1, 2],
    "confidence": 0.95
  }
]`;

    const content = await callChatAPI([
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Analyseer deze tekst en extraheer alle begrippen:\n\n${combinedText}`,
      },
    ], { temperature: 0.3, max_tokens: 4000 });

    let extractedConcepts: ExtractedConcept[];
    try {
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        throw new Error('Geen JSON array gevonden in response');
      }
      const parsed = JSON.parse(jsonMatch[0]);

      extractedConcepts = parsed
        .filter((c: any) => c.confidence >= 0.7)
        .map((c: any) => ({
          name: c.name,
          definition: c.definition,
          keyPoints: Array.isArray(c.keyPoints) ? c.keyPoints : [],
          examples: Array.isArray(c.examples) ? c.examples : [],
          chunkIds: (c.chunkIndices || []).map(
            (idx: number) => chunks[idx - 1]?.id
          ).filter((id: any) => id),
          confidence: c.confidence,
        }));
    } catch (parseError) {
      throw new Error('Kon AI response niet parsen. Probeer opnieuw.');
    }

    onProgress?.({
      stage: 'saving',
      progress: 70,
      message: `${extractedConcepts.length} begrippen opslaan...`,
      conceptsFound: extractedConcepts.length,
    });

    const conceptIds: string[] = [];

    for (const concept of extractedConcepts) {
      const { data: existingConcept } = await supabase
        .from('concepts')
        .select('id')
        .ilike('name', concept.name)
        .maybeSingle();

      if (existingConcept) {
        conceptIds.push(existingConcept.id);
        continue;
      }

      const { data: newConcept, error: insertError } = await supabase
        .from('concepts')
        .insert({
          name: concept.name,
          definition: concept.definition,
          key_points: concept.keyPoints,
          examples: concept.examples,
          source_document_id: documentId,
          extraction_method: 'auto_extracted',
          review_status: 'needs_review',
          extracted_at: new Date().toISOString(),
          related_chunk_ids: concept.chunkIds,
        })
        .select('id')
        .single();

      if (insertError) {
        console.error('Fout bij opslaan begrip:', insertError);
        continue;
      }

      if (newConcept) {
        conceptIds.push(newConcept.id);
      }
    }

    onProgress?.({
      stage: 'completed',
      progress: 100,
      message: `${conceptIds.length} begrippen succesvol geëxtraheerd!`,
      conceptsFound: conceptIds.length,
    });

    return {
      conceptIds,
      conceptCount: conceptIds.length,
    };
  } catch (error) {
    onProgress?.({
      stage: 'error',
      progress: 0,
      message: error instanceof Error ? error.message : 'Onbekende fout',
    });
    throw error;
  }
}

export async function extractConceptsFromAllDocuments(
  userId: string,
  onProgress?: (documentId: string, progress: ExtractionProgress) => void
): Promise<{ totalConcepts: number; processedDocuments: number }> {
  const { data: documents, error: docsError } = await supabase
    .from('documents')
    .select('id, title')
    .eq('processing_status', 'completed')
    .order('created_at', { ascending: true });

  if (docsError || !documents) {
    throw new Error('Kon documenten niet ophalen');
  }

  let totalConcepts = 0;
  let processedDocuments = 0;

  for (const doc of documents) {
    try {
      const result = await extractConceptsFromDocument(
        doc.id,
        userId,
        (progress) => onProgress?.(doc.id, progress)
      );
      totalConcepts += result.conceptCount;
      processedDocuments++;
    } catch (error) {
      console.error(`Fout bij extractie uit ${doc.title}:`, error);
    }
  }

  return { totalConcepts, processedDocuments };
}

export async function approveExtractedConcept(
  conceptId: string,
  adminId: string
): Promise<void> {
  const { error } = await supabase
    .from('concepts')
    .update({
      review_status: 'approved',
      reviewed_by: adminId,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', conceptId);

  if (error) {
    throw new Error(`Kon begrip niet goedkeuren: ${error.message}`);
  }
}

export async function rejectExtractedConcept(
  conceptId: string,
  adminId: string
): Promise<void> {
  const { error } = await supabase
    .from('concepts')
    .update({
      review_status: 'rejected',
      reviewed_by: adminId,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', conceptId);

  if (error) {
    throw new Error(`Kon begrip niet afwijzen: ${error.message}`);
  }
}

export async function getExtractedConceptsForReview(): Promise<any[]> {
  const { data, error } = await supabase
    .from('concepts')
    .select(`
      *,
      source_document:documents(id, title),
      reviewer:profiles!reviewed_by(full_name)
    `)
    .eq('review_status', 'needs_review')
    .order('extracted_at', { ascending: false });

  if (error) {
    throw new Error(`Kon begrippen niet ophalen: ${error.message}`);
  }

  return data || [];
}
