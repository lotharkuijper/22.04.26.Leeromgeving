import { supabase } from '../lib/supabase';
import { getShareStatsRepository, getRmdFileInFolder } from './github-parser.service';
import { parseShareStatsItem } from './rmd-parser.service';
import { validateQuizQuestion } from './quiz-validation.service';

export interface ShareStatsQuestion {
  id: string;
  questionText: string;
  answerOptions: { [key: string]: string };
  correctAnswer: string;
  explanation?: string;
  topic?: string;
  difficulty?: 'beginner' | 'intermediate' | 'advanced';
  source: string;
}

export interface ImportProgress {
  stage: 'fetching' | 'parsing' | 'validating' | 'saving' | 'completed' | 'error';
  progress: number;
  message: string;
  questionsProcessed?: number;
  totalQuestions?: number;
}

export type ImportProgressCallback = (progress: ImportProgress) => void;

export async function importQuestionsFromShareStats(
  repositoryUrl: string,
  topics: string[],
  onProgress?: ImportProgressCallback
): Promise<{ imported: number; skipped: number; errors: number }> {
  let imported = 0;
  let skipped = 0;
  let errors = 0;

  try {
    onProgress?.({
      stage: 'fetching',
      progress: 0,
      message: 'Repository structuur ophalen...',
    });

    const repoStructure = await getShareStatsRepository(topics.length > 0 ? topics : undefined);

    let totalItems = 0;
    for (const items of repoStructure.itemsByTopic.values()) {
      totalItems += items.length;
    }

    onProgress?.({
      stage: 'fetching',
      progress: 10,
      message: `${totalItems} items gevonden in ${repoStructure.topics.length} topics`,
      totalQuestions: totalItems,
    });

    let processedItems = 0;

    for (const [topic, items] of repoStructure.itemsByTopic.entries()) {
      for (const item of items) {
        try {
          const folderName = item.name;
          const folderPath = item.path;

          const languageSegment = folderName.split('-')[3];
          if (languageSegment !== 'nl') {
            skipped++;
            processedItems++;
            continue;
          }

          onProgress?.({
            stage: 'parsing',
            progress: 10 + (processedItems / totalItems) * 40,
            message: `Verwerken: ${folderName}`,
            questionsProcessed: processedItems,
            totalQuestions: totalItems,
          });

          const rmdContent = await getRmdFileInFolder(folderPath);
          if (!rmdContent) {
            console.warn(`Geen Rmd bestand gevonden in ${folderPath}`);
            errors++;
            processedItems++;
            continue;
          }

          const parsedItem = parseShareStatsItem(folderName, rmdContent);
          if (!parsedItem) {
            console.warn(`Kon item niet parsen: ${folderName}`);
            errors++;
            processedItems++;
            continue;
          }

          const { data: existingQuestion } = await supabase
            .from('quiz_questions')
            .select('id')
            .eq('sharestats_id', folderName)
            .maybeSingle();

          if (existingQuestion) {
            skipped++;
            processedItems++;
            continue;
          }

          const answerOptions: { [key: string]: string } = {};
          let correctAnswer = '';

          parsedItem.question.answerOptions.forEach((option, index) => {
            const key = String.fromCharCode(65 + index);
            answerOptions[key] = option.text;
            if (option.correct && !correctAnswer) {
              correctAnswer = key;
            }
          });

          onProgress?.({
            stage: 'validating',
            progress: 50 + (processedItems / totalItems) * 30,
            message: `Valideren: ${folderName}`,
            questionsProcessed: processedItems,
            totalQuestions: totalItems,
          });

          const validation = await validateQuizQuestion(
            parsedItem.question.question,
            parsedItem.question.solution
          );

          const { error: insertError } = await supabase.from('quiz_questions').insert({
            question_text: parsedItem.question.question,
            answer_options: answerOptions,
            correct_answer: correctAnswer,
            explanation: parsedItem.question.solution,
            source: 'sharestats',
            sharestats_id: folderName,
            topic: topic,
            subtopic: parsedItem.subtopic,
            language: parsedItem.language,
            institution: parsedItem.institution,
            metadata: parsedItem.question.metaInformation,
            difficulty: 'intermediate',
            validation_status: validation.isValid ? 'validated' : 'not_validated',
            validation_score: validation.similarityScore,
          });

          if (insertError) {
            console.error(`Fout bij opslaan vraag ${folderName}:`, insertError);
            errors++;
          } else {
            imported++;
          }

          processedItems++;
        } catch (itemError) {
          console.error(`Fout bij verwerken item ${item.name}:`, itemError);
          errors++;
          processedItems++;
        }
      }
    }

    onProgress?.({
      stage: 'completed',
      progress: 100,
      message: `Import voltooid: ${imported} geïmporteerd, ${skipped} overgeslagen, ${errors} fouten`,
      questionsProcessed: totalItems,
      totalQuestions: totalItems,
    });

    return { imported, skipped, errors };
  } catch (error) {
    console.error('Fout bij importeren ShareStats vragen:', error);
    onProgress?.({
      stage: 'error',
      progress: 0,
      message: error instanceof Error ? error.message : 'Onbekende fout',
    });
    throw error;
  }
}

export async function syncShareStatsQuestions(
  onProgress?: ImportProgressCallback
): Promise<{ newQuestions: number; updatedQuestions: number }> {
  const result = await importQuestionsFromShareStats(
    'https://github.com/ShareStats/itembank',
    [],
    onProgress
  );

  return {
    newQuestions: result.imported,
    updatedQuestions: 0,
  };
}

export async function getShareStatsConfig(): Promise<{
  repositoryUrl?: string;
  lastSyncedAt?: string;
  autoSync: boolean;
}> {
  return {
    repositoryUrl: 'https://github.com/ShareStats/itembank',
    lastSyncedAt: undefined,
    autoSync: false,
  };
}

export async function saveShareStatsConfig(config: {
  repositoryUrl: string;
  autoSync: boolean;
}): Promise<void> {
  console.log('ShareStats config:', config);
}

export async function validateQuestionAgainstCourseware(
  questionId: string
): Promise<{
  isValid: boolean;
  similarityScore: number;
  matchedDocuments: string[];
  notes: string;
}> {
  return {
    isValid: false,
    similarityScore: 0,
    matchedDocuments: [],
    notes: 'Validatie functie is beschikbaar via quiz-validation.service.ts',
  };
}
