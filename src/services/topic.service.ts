import { supabase } from '../lib/supabase';

export interface Topic {
  id: string;
  name: string;
  slug: string;
  description?: string;
  category?: string | null;
  parent_topic_id?: string;
  display_order: number;
  created_at: string;
  updated_at: string;
}

export async function getAllTopics(): Promise<Topic[]> {
  const { data, error } = await supabase
    .from('topics')
    .select('*')
    .order('display_order', { ascending: true });

  if (error) {
    throw new Error(`Kon topics niet ophalen: ${error.message}`);
  }

  return data || [];
}

export async function createTopic(
  name: string,
  description?: string,
  parentTopicId?: string
): Promise<Topic> {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  const { data, error } = await supabase
    .from('topics')
    .insert({
      name,
      slug,
      description,
      parent_topic_id: parentTopicId,
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Kon topic niet aanmaken: ${error.message}`);
  }

  return data;
}

export async function linkConceptToTopic(
  conceptId: string,
  topicId: string,
  relevanceScore: number = 1.0
): Promise<void> {
  const { error } = await supabase.from('concept_topics').insert({
    concept_id: conceptId,
    topic_id: topicId,
    relevance_score: relevanceScore,
  });

  if (error && !error.message.includes('duplicate')) {
    throw new Error(`Kon concept niet koppelen aan topic: ${error.message}`);
  }
}

export async function linkQuizQuestionToTopic(
  questionId: string,
  topicId: string,
  relevanceScore: number = 1.0
): Promise<void> {
  const { error } = await supabase.from('quiz_question_topics').insert({
    question_id: questionId,
    topic_id: topicId,
    relevance_score: relevanceScore,
  });

  if (error && !error.message.includes('duplicate')) {
    throw new Error(`Kon quiz vraag niet koppelen aan topic: ${error.message}`);
  }
}

export async function linkDocumentToTopic(
  documentId: string,
  topicId: string,
  coverageScore: number = 1.0,
  automatic: boolean = false
): Promise<void> {
  const { error } = await supabase.from('document_topics').insert({
    document_id: documentId,
    topic_id: topicId,
    coverage_score: coverageScore,
    extracted_automatically: automatic,
  });

  if (error && !error.message.includes('duplicate')) {
    throw new Error(`Kon document niet koppelen aan topic: ${error.message}`);
  }
}

export async function getTopicsForConcept(conceptId: string): Promise<Topic[]> {
  const { data, error } = await supabase
    .from('concept_topics')
    .select('topic:topics(*)')
    .eq('concept_id', conceptId);

  if (error) {
    throw new Error(`Kon topics niet ophalen: ${error.message}`);
  }

  return (data || []).map((item: any) => item.topic);
}

export async function getTopicsForQuizQuestion(questionId: string): Promise<Topic[]> {
  const { data, error } = await supabase
    .from('quiz_question_topics')
    .select('topic:topics(*)')
    .eq('question_id', questionId);

  if (error) {
    throw new Error(`Kon topics niet ophalen: ${error.message}`);
  }

  return (data || []).map((item: any) => item.topic);
}

export async function getTopicsForDocument(documentId: string): Promise<Topic[]> {
  const { data, error } = await supabase
    .from('document_topics')
    .select('topic:topics(*)')
    .eq('document_id', documentId);

  if (error) {
    throw new Error(`Kon topics niet ophalen: ${error.message}`);
  }

  return (data || []).map((item: any) => item.topic);
}

export async function getConceptsForTopic(topicId: string): Promise<any[]> {
  const { data, error } = await supabase
    .from('concept_topics')
    .select('concept:concepts(*)')
    .eq('topic_id', topicId);

  if (error) {
    throw new Error(`Kon concepts niet ophalen: ${error.message}`);
  }

  return (data || []).map((item: any) => item.concept);
}

export async function getQuestionsWithoutTopics(): Promise<any[]> {
  const { data: allQuestions, error: qError } = await supabase
    .from('quiz_questions')
    .select('id, question_text, topic');

  if (qError) {
    throw new Error(`Kon vragen niet ophalen: ${qError.message}`);
  }

  const { data: linkedQuestions, error: lError } = await supabase
    .from('quiz_question_topics')
    .select('question_id');

  if (lError) {
    throw new Error(`Kon gekoppelde vragen niet ophalen: ${lError.message}`);
  }

  const linkedIds = new Set((linkedQuestions || []).map((q: any) => q.question_id));

  return (allQuestions || []).filter(q => !linkedIds.has(q.id));
}

export async function getConceptsWithoutTopics(): Promise<any[]> {
  const { data: allConcepts, error: cError } = await supabase
    .from('concepts')
    .select('id, name, category');

  if (cError) {
    throw new Error(`Kon concepts niet ophalen: ${cError.message}`);
  }

  const { data: linkedConcepts, error: lError } = await supabase
    .from('concept_topics')
    .select('concept_id');

  if (lError) {
    throw new Error(`Kon gekoppelde concepts niet ophalen: ${lError.message}`);
  }

  const linkedIds = new Set((linkedConcepts || []).map((c: any) => c.concept_id));

  return (allConcepts || []).filter(c => !linkedIds.has(c.id));
}

