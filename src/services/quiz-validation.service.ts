import { supabase } from '../lib/supabase';
import { generateEmbeddings } from './llm.service';

export interface ValidationResult {
  questionId: string;
  status: 'validated' | 'not_validated' | 'rejected' | 'manual_approved';
  similarityScore: number;
  matchedDocumentId?: string;
  matchedChunkIds: string[];
  matchedConcepts: string[];
  notes?: string;
}

export interface ValidationProgress {
  stage: 'analyzing' | 'validating' | 'saving' | 'completed' | 'error';
  progress: number;
  message: string;
  questionsValidated?: number;
  totalQuestions?: number;
}

export type ValidationProgressCallback = (progress: ValidationProgress) => void;

export async function validateQuizQuestion(
  questionId: string,
  userId: string
): Promise<ValidationResult> {
  const { data: question, error: qError } = await supabase
    .from('quiz_questions')
    .select('*')
    .eq('id', questionId)
    .single();

  if (qError || !question) {
    throw new Error('Quiz vraag niet gevonden');
  }

  const questionText = `${question.question_text}\n${JSON.stringify(question.answer_options)}`;

  const [questionEmbedding] = await generateEmbeddings([questionText]);

  const { data: matches, error: matchError } = await supabase.rpc(
    'match_document_chunks',
    {
      query_embedding: questionEmbedding,
      match_threshold: 0.6,
      match_count: 10,
    }
  );

  if (matchError) {
    throw new Error(`Kon chunks niet matchen: ${matchError.message}`);
  }

  if (!matches || matches.length === 0) {
    const result: ValidationResult = {
      questionId,
      status: 'not_validated',
      similarityScore: 0,
      matchedChunkIds: [],
      matchedConcepts: [],
      notes: 'Geen matching document chunks gevonden',
    };

    await saveValidationResult(result, userId);
    return result;
  }

  const bestMatch = matches[0];
  const similarityScore = bestMatch.similarity;

  const matchedChunkIds = matches.slice(0, 5).map((m: any) => m.id);

  const documentIds = [...new Set(matches.map((m: any) => m.document_id))];

  const { data: relatedConcepts } = await supabase
    .from('concepts')
    .select('id, name')
    .in('source_document_id', documentIds)
    .eq('review_status', 'approved');

  const matchedConcepts = (relatedConcepts || []).map((c: any) => c.id);

  let status: 'validated' | 'not_validated' | 'rejected' | 'manual_approved' = 'not_validated';
  let notes = '';

  if (similarityScore >= 0.75) {
    status = 'validated';
    notes = 'Vraag komt overeen met cursusmateriaal (hoge similarity score)';
  } else if (similarityScore >= 0.60) {
    status = 'not_validated';
    notes = 'Vraag komt gedeeltelijk overeen met cursusmateriaal (medium similarity score)';
  } else {
    status = 'not_validated';
    notes = 'Vraag komt niet duidelijk overeen met cursusmateriaal (lage similarity score)';
  }

  const result: ValidationResult = {
    questionId,
    status,
    similarityScore,
    matchedDocumentId: bestMatch.document_id,
    matchedChunkIds,
    matchedConcepts,
    notes,
  };

  await saveValidationResult(result, userId);

  return result;
}

async function saveValidationResult(
  result: ValidationResult,
  userId: string
): Promise<void> {
  await supabase.from('quiz_validations').insert({
    question_id: result.questionId,
    validation_status: result.status,
    similarity_score: result.similarityScore,
    matched_document_id: result.matchedDocumentId,
    matched_chunk_ids: result.matchedChunkIds,
    matched_concepts: result.matchedConcepts,
    validation_notes: result.notes,
    validated_by: userId,
  });

  await supabase
    .from('quiz_questions')
    .update({
      validation_status: result.status,
      validation_score: result.similarityScore,
      validation_metadata: {
        matchedDocumentId: result.matchedDocumentId,
        matchedChunkIds: result.matchedChunkIds,
        matchedConcepts: result.matchedConcepts,
        notes: result.notes,
      },
      last_validated_at: new Date().toISOString(),
    })
    .eq('id', result.questionId);
}

export async function validateAllQuizQuestions(
  userId: string,
  onProgress?: ValidationProgressCallback
): Promise<{ validated: number; notValidated: number; total: number }> {
  onProgress?.({
    stage: 'analyzing',
    progress: 10,
    message: 'Quiz vragen ophalen...',
  });

  const { data: questions, error: qError } = await supabase
    .from('quiz_questions')
    .select('id, question_text')
    .or('validation_status.is.null,validation_status.eq.not_validated');

  if (qError) {
    throw new Error(`Kon vragen niet ophalen: ${qError.message}`);
  }

  const totalQuestions = questions?.length || 0;

  if (totalQuestions === 0) {
    onProgress?.({
      stage: 'completed',
      progress: 100,
      message: 'Geen vragen gevonden om te valideren',
      questionsValidated: 0,
      totalQuestions: 0,
    });
    return { validated: 0, notValidated: 0, total: 0 };
  }

  let validated = 0;
  let notValidated = 0;

  for (let i = 0; i < questions.length; i++) {
    const question = questions[i];

    onProgress?.({
      stage: 'validating',
      progress: 10 + Math.floor((i / totalQuestions) * 80),
      message: `Valideren vraag ${i + 1} van ${totalQuestions}...`,
      questionsValidated: i,
      totalQuestions,
    });

    try {
      const result = await validateQuizQuestion(question.id, userId);
      if (result.status === 'validated') {
        validated++;
      } else {
        notValidated++;
      }
    } catch (error) {
      console.error(`Fout bij validatie vraag ${question.id}:`, error);
      notValidated++;
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  onProgress?.({
    stage: 'completed',
    progress: 100,
    message: `Validatie voltooid: ${validated} gevalideerd, ${notValidated} niet gevalideerd`,
    questionsValidated: totalQuestions,
    totalQuestions,
  });

  return {
    validated,
    notValidated,
    total: totalQuestions,
  };
}

export async function manuallyApproveQuestion(
  questionId: string,
  userId: string,
  notes?: string
): Promise<void> {
  await supabase.from('quiz_validations').insert({
    question_id: questionId,
    validation_status: 'manual_approved',
    similarity_score: null,
    matched_document_id: null,
    matched_chunk_ids: [],
    matched_concepts: [],
    validation_notes: notes || 'Handmatig goedgekeurd door docent',
    validated_by: userId,
  });

  await supabase
    .from('quiz_questions')
    .update({
      validation_status: 'manual_approved',
      last_validated_at: new Date().toISOString(),
      validation_metadata: {
        notes: notes || 'Handmatig goedgekeurd',
      },
    })
    .eq('id', questionId);
}

export async function rejectQuestion(
  questionId: string,
  userId: string,
  reason: string
): Promise<void> {
  await supabase.from('quiz_validations').insert({
    question_id: questionId,
    validation_status: 'rejected',
    similarity_score: null,
    matched_document_id: null,
    matched_chunk_ids: [],
    matched_concepts: [],
    validation_notes: reason,
    validated_by: userId,
  });

  await supabase
    .from('quiz_questions')
    .update({
      validation_status: 'rejected',
      last_validated_at: new Date().toISOString(),
      validation_metadata: {
        notes: reason,
      },
    })
    .eq('id', questionId);
}

export async function getValidatedQuestions(): Promise<any[]> {
  const { data, error } = await supabase
    .from('quiz_questions')
    .select('*')
    .in('validation_status', ['validated', 'manual_approved'])
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Kon vragen niet ophalen: ${error.message}`);
  }

  return data || [];
}

export async function getQuestionValidationHistory(
  questionId: string
): Promise<any[]> {
  const { data, error } = await supabase
    .from('quiz_validations')
    .select(`
      *,
      validated_by_user:profiles!validated_by(full_name),
      matched_document:documents(title)
    `)
    .eq('question_id', questionId)
    .order('validated_at', { ascending: false });

  if (error) {
    throw new Error(`Kon validatie geschiedenis niet ophalen: ${error.message}`);
  }

  return data || [];
}

export async function getValidationStatistics(): Promise<{
  validated: number;
  notValidated: number;
  manuallyApproved: number;
  rejected: number;
  total: number;
}> {
  const { data, error } = await supabase
    .from('quiz_questions')
    .select('validation_status');

  if (error) {
    throw new Error(`Kon statistieken niet ophalen: ${error.message}`);
  }

  const stats = {
    validated: 0,
    notValidated: 0,
    manuallyApproved: 0,
    rejected: 0,
    total: data?.length || 0,
  };

  data?.forEach((q: any) => {
    switch (q.validation_status) {
      case 'validated':
        stats.validated++;
        break;
      case 'not_validated':
        stats.notValidated++;
        break;
      case 'manual_approved':
        stats.manuallyApproved++;
        break;
      case 'rejected':
        stats.rejected++;
        break;
    }
  });

  return stats;
}
