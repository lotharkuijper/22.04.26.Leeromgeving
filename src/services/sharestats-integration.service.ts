import { supabase } from '../lib/supabase';
import { getShareStatsRepository, getRmdFileInFolder, setItembankRepo } from './github-parser.service';
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

const DEFAULT_REPO_URL = 'https://github.com/ShareStats/itembank';

// Parseert een GitHub-repo-URL naar owner/repo. Geeft `null` bij ongeldige URL.
export function parseRepoUrl(url: string): { owner: string; repo: string } | null {
  if (!url) return null;
  const match = url.match(/github\.com[/:]([^/]+)\/([^/.\s]+)/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/i, '') };
}

// Parseert "Descriptive statistics/Summary Statistics/Measures of Location/Mean"
// naar een array van segmenten zonder lege strings, getrimd.
export function parseExsectionPath(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split('/').map(s => s.trim()).filter(s => s.length > 0);
}

export async function importQuestionsFromShareStats(
  repositoryUrl: string,
  topics: string[],
  onProgress?: ImportProgressCallback
): Promise<{ imported: number; skipped: number; skippedReasons: Record<string, number>; errors: number }> {
  let imported = 0;
  let skipped = 0;
  let errors = 0;
  const skippedReasons: Record<string, number> = {
    not_dutch: 0,
    not_mchoice: 0,
    already_imported: 0,
    no_rmd: 0,
    parse_failed: 0,
  };

  try {
    // Configureer parser zodat de juiste repo gefetcht wordt.
    const parsedRepo = parseRepoUrl(repositoryUrl);
    if (!parsedRepo) {
      throw new Error(`Ongeldige GitHub-repo-URL: ${repositoryUrl}`);
    }
    setItembankRepo(parsedRepo.owner, parsedRepo.repo);

    onProgress?.({ stage: 'fetching', progress: 0, message: 'Repository structuur ophalen...' });

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

          // Filter 1: alleen Nederlandse items (-nl)
          const languageSegment = folderName.split('-')[3];
          if (languageSegment !== 'nl') {
            skipped++;
            skippedReasons.not_dutch++;
            processedItems++;
            continue;
          }

          onProgress?.({
            stage: 'parsing',
            progress: 10 + (processedItems / Math.max(totalItems, 1)) * 40,
            message: `Verwerken: ${folderName}`,
            questionsProcessed: processedItems,
            totalQuestions: totalItems,
          });

          const rmdContent = await getRmdFileInFolder(folderPath);
          if (!rmdContent) {
            skipped++;
            skippedReasons.no_rmd++;
            processedItems++;
            continue;
          }

          const parsedItem = parseShareStatsItem(folderName, rmdContent);
          if (!parsedItem) {
            skipped++;
            skippedReasons.parse_failed++;
            processedItems++;
            continue;
          }

          // Filter 2: alleen meerkeuze-items (extype: mchoice)
          const extype = (parsedItem.question.metaInformation?.extype || '').toLowerCase().trim();
          if (extype !== 'mchoice') {
            skipped++;
            skippedReasons.not_mchoice++;
            processedItems++;
            continue;
          }

          // Bestaande items overslaan op basis van sharestats_id (folderName).
          const { data: existingQuestion } = await supabase
            .from('quiz_questions')
            .select('id')
            .eq('sharestats_id', folderName)
            .maybeSingle();

          if (existingQuestion) {
            skipped++;
            skippedReasons.already_imported++;
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

          // Geen juist antwoord gevonden? Sla over (corrupte item).
          if (!correctAnswer) {
            skipped++;
            skippedReasons.parse_failed++;
            processedItems++;
            continue;
          }

          onProgress?.({
            stage: 'validating',
            progress: 50 + (processedItems / Math.max(totalItems, 1)) * 30,
            message: `Valideren: ${folderName}`,
            questionsProcessed: processedItems,
            totalQuestions: totalItems,
          });

          const validation = await validateQuizQuestion(
            parsedItem.question.question,
            parsedItem.question.solution
          );

          // Exsection-pad: hiërarchie waarmee mapping op cursus-begrippen werkt.
          const exsectionPath = parseExsectionPath(parsedItem.question.metaInformation?.exsection);

          const insertPayload: Record<string, any> = {
            question_text: parsedItem.question.question,
            answer_options: answerOptions,
            correct_answer: correctAnswer,
            explanation: parsedItem.question.solution,
            source: 'sharestats',
            sharestats_id: folderName,
            topic,
            subtopic: parsedItem.subtopic,
            language: parsedItem.language,
            institution: parsedItem.institution,
            metadata: parsedItem.question.metaInformation,
            difficulty: 'intermediate',
            validation_status: validation.isValid ? 'validated' : 'not_validated',
            validation_score: validation.similarityScore,
            exsection_path: exsectionPath.length > 0 ? exsectionPath : null,
            source_repo: repositoryUrl,
          };

          const { error: insertError } = await supabase
            .from('quiz_questions')
            .insert(insertPayload);

          if (insertError) {
            // Defensief: als de migratie nog niet is toegepast, mist
            // exsection_path/source_repo. Probeer nog een keer zonder die kolommen.
            const isMissingCol = /column .* does not exist|schema cache/i.test(insertError.message || '');
            if (isMissingCol) {
              delete insertPayload.exsection_path;
              delete insertPayload.source_repo;
              delete insertPayload.source_commit_sha;
              const { error: retryError } = await supabase
                .from('quiz_questions')
                .insert(insertPayload);
              if (retryError) {
                console.error(`Insert mislukte na retry voor ${folderName}:`, retryError);
                errors++;
              } else {
                imported++;
              }
            } else {
              console.error(`Fout bij opslaan vraag ${folderName}:`, insertError);
              errors++;
            }
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

    return { imported, skipped, skippedReasons, errors };
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
  repositoryUrl?: string,
  onProgress?: ImportProgressCallback
): Promise<{ imported: number; skipped: number; skippedReasons: Record<string, number>; errors: number }> {
  const url = repositoryUrl || (await getShareStatsConfig()).repositoryUrl || DEFAULT_REPO_URL;
  const result = await importQuestionsFromShareStats(url, [], onProgress);

  // Update last_synced_at in config.
  try {
    await saveShareStatsConfig({ repositoryUrl: url, lastSyncedAt: new Date().toISOString() });
  } catch (err) {
    console.warn('Kon last_synced_at niet opslaan:', err);
  }

  return result;
}

const CONFIG_KEY = '__quiz_itembank_config__';

export async function getShareStatsConfig(): Promise<{
  repositoryUrl: string;
  lastSyncedAt?: string;
}> {
  try {
    const { data } = await supabase
      .from('chatbot_prompts')
      .select('content')
      .eq('name', CONFIG_KEY)
      .maybeSingle();

    if (data?.content) {
      try {
        const parsed = JSON.parse(data.content);
        return {
          repositoryUrl: parsed.repositoryUrl || DEFAULT_REPO_URL,
          lastSyncedAt: parsed.lastSyncedAt,
        };
      } catch {
        // val terug op default
      }
    }
  } catch (err) {
    console.warn('getShareStatsConfig: kon config niet ophalen:', err);
  }
  return { repositoryUrl: DEFAULT_REPO_URL };
}

export async function saveShareStatsConfig(config: {
  repositoryUrl: string;
  lastSyncedAt?: string;
}): Promise<void> {
  const payload = {
    name: CONFIG_KEY,
    content: JSON.stringify({
      repositoryUrl: config.repositoryUrl,
      lastSyncedAt: config.lastSyncedAt,
    }),
    is_active: true,
  };

  // Upsert via select+insert/update. (chatbot_prompts heeft een unique op name.)
  const { data: existing } = await supabase
    .from('chatbot_prompts')
    .select('id')
    .eq('name', CONFIG_KEY)
    .maybeSingle();

  if (existing) {
    await supabase
      .from('chatbot_prompts')
      .update({ content: payload.content, is_active: true })
      .eq('id', existing.id);
  } else {
    await supabase.from('chatbot_prompts').insert(payload);
  }
}

export async function validateQuestionAgainstCourseware(
  _questionId: string
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
