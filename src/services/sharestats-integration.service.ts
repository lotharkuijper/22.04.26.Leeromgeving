import { supabase } from '../lib/supabase';
import { getAllRmdFiles, fetchFileContent, setItembankRepo } from './github-parser.service';
import { parseShareStatsItem } from './rmd-parser.service';

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
): Promise<{ imported: number; importedMcq: number; importedOpen: number; skipped: number; skippedReasons: Record<string, number>; errors: number; importedTopSegments: string[] }> {
  let imported = 0;
  let importedMcq = 0;
  let importedOpen = 0;
  let skipped = 0;
  let errors = 0;
  // Verzamelt het eerste segment van elk geïmporteerd `exsection_path`
  // (bijv. "Probability", "Variance"). De UI gebruikt deze om automatisch
  // begrippen aan de actieve cursus te koppelen, zodat studenten de
  // geïmporteerde vragen direct kunnen oefenen via de begrippenlijst.
  const importedTopSegmentSet = new Set<string>();
  const skippedReasons: Record<string, number> = {
    not_dutch: 0,
    unsupported_extype: 0,
    already_imported: 0,
    no_rmd: 0,
    parse_failed: 0,
  };

  // R/exams extypes:
  //  - mchoice / schoice → meerkeuze (single/multiple-choice)
  //  - num / string / cloze → open vraag (numeriek / tekst / invul)
  // Casus-typen worden nog niet ondersteund in onze quiz-generator.
  const MCQ_EXTYPES = new Set(['mchoice', 'schoice']);
  const OPEN_EXTYPES = new Set(['num', 'string', 'cloze']);

  try {
    // Configureer parser zodat de juiste repo gefetcht wordt.
    const parsedRepo = parseRepoUrl(repositoryUrl);
    if (!parsedRepo) {
      throw new Error(`Ongeldige GitHub-repo-URL: ${repositoryUrl}`);
    }
    setItembankRepo(parsedRepo.owner, parsedRepo.repo);

    onProgress?.({ stage: 'fetching', progress: 0, message: 'Repository-structuur doorzoeken op .Rmd-bestanden...' });

    const rmdFiles = await getAllRmdFiles(topics.length > 0 ? topics : undefined);
    const totalItems = rmdFiles.length;
    const topicsCovered = new Set(rmdFiles.map((f) => f.topic)).size;

    onProgress?.({
      stage: 'fetching',
      progress: 10,
      message: `${totalItems} .Rmd-bestand(en) gevonden in ${topicsCovered} topic(s)`,
      totalQuestions: totalItems,
    });

    let processedItems = 0;

    for (const rmdFile of rmdFiles) {
      const { topic, folderName, downloadUrl } = rmdFile;
      try {
        // Filter 1 (voorlopig): folderNaam-segmenten checken op 'nl'.
        // Echte beslissing valt pas na parsen, met fallback op
        // metadata.exlang — anders missen we items met taalcode in
        // metadata maar niet in foldernaam.
        const folderSegments = folderName.split('-');
        const folderHasNl = folderSegments.includes('nl');

        onProgress?.({
          stage: 'parsing',
          progress: 10 + (processedItems / Math.max(totalItems, 1)) * 40,
          message: `Verwerken: ${folderName}`,
          questionsProcessed: processedItems,
          totalQuestions: totalItems,
        });

        let rmdContent: string | null = null;
        try {
          rmdContent = await fetchFileContent(downloadUrl);
        } catch (fetchErr) {
          console.error(`Kon .Rmd-bestand niet ophalen: ${rmdFile.filePath}`, fetchErr);
          rmdContent = null;
        }
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

        // Filter 1b: NL-beslissing met OR-logica. Item is NL als
        // folderHasNl OF metadata.exlang met 'nl' begint. Als exlang
        // expliciet niet-nl is, overrulet die altijd de folder.
        const exlang = (parsedItem.question.metaInformation?.exlang || '').toLowerCase().trim();
        const exlangIsNl = exlang.startsWith('nl');
        const exlangIsNonNl = exlang.length > 0 && !exlangIsNl;
        const isDutch = exlangIsNl || (folderHasNl && !exlangIsNonNl);
        if (!isDutch) {
          skipped++;
          skippedReasons.not_dutch++;
          processedItems++;
          continue;
        }

        // Filter 2: vraagtype bepalen via extype.
        const extype = (parsedItem.question.metaInformation?.extype || '').toLowerCase().trim();
        let itemType: 'mcq' | 'open';
        if (MCQ_EXTYPES.has(extype)) {
          itemType = 'mcq';
        } else if (OPEN_EXTYPES.has(extype)) {
          itemType = 'open';
        } else {
          skipped++;
          skippedReasons.unsupported_extype++;
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

        if (itemType === 'mcq') {
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
        } else {
          // Open vraag: het modelantwoord komt uit de Solution-sectie.
          // Voor `num` staat het numerieke antwoord vaak in metadata.exsolution.
          const exsolution = parsedItem.question.metaInformation?.exsolution;
          if (exsolution) {
            correctAnswer = String(exsolution).trim();
          }
          // Als de vraag geen Solution én geen exsolution heeft, kunnen we
          // hem niet evalueren; sla over.
          if (!correctAnswer && !(parsedItem.question.solution || '').trim()) {
            skipped++;
            skippedReasons.parse_failed++;
            processedItems++;
            continue;
          }
        }

        onProgress?.({
          stage: 'validating',
          progress: 50 + (processedItems / Math.max(totalItems, 1)) * 30,
          message: `Valideren: ${folderName}`,
          questionsProcessed: processedItems,
          totalQuestions: totalItems,
        });

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
          exsection_path: exsectionPath.length > 0 ? exsectionPath : null,
          source_repo: repositoryUrl,
          item_type: itemType,
        };

        const { error: insertError } = await supabase
          .from('quiz_questions')
          .insert(insertPayload);

        if (insertError) {
          // Defensief: als de migratie nog niet is toegepast, kunnen
          // optionele kolommen ontbreken. We verwijderen alleen exact
          // de kolom die in de foutmelding voorkomt en proberen het
          // opnieuw, maximaal 4x. Zo behouden we item_type wanneer die
          // kolom wél bestaat (gangbare situatie na migratie T001).
          const optionalCols = ['exsection_path', 'source_repo', 'source_commit_sha', 'item_type'];
          const missingColRe = /column "?([a-z_]+)"? .*does not exist|schema cache.*?"([a-z_]+)"/i;
          let lastError: typeof insertError | null = insertError;
          for (let attempt = 0; attempt < optionalCols.length && lastError; attempt++) {
            const m = (lastError.message || '').match(missingColRe);
            const col = m?.[1] || m?.[2];
            if (!col || !optionalCols.includes(col)) break;
            delete insertPayload[col];
            const { error: retryError } = await supabase
              .from('quiz_questions')
              .insert(insertPayload);
            lastError = retryError ?? null;
          }
          if (lastError) {
            console.error(`Fout bij opslaan vraag ${folderName}:`, lastError);
            errors++;
          } else {
            imported++;
            if (itemType === 'mcq') importedMcq++; else importedOpen++;
          }
        } else {
          imported++;
          if (itemType === 'mcq') importedMcq++; else importedOpen++;
          if (exsectionPath.length > 0) importedTopSegmentSet.add(exsectionPath[0]);
        }

        processedItems++;
      } catch (itemError) {
        // Logge altijd een leesbare boodschap — `console.error(err)` toont
        // bij Error-objecten alleen `{}`, wat eerder een 489-item cascade
        // onzichtbaar maakte. Trace alleen voor de eerste paar items om
        // de console niet te verzuipen.
        const msg = itemError instanceof Error ? itemError.message : String(itemError);
        console.error(`Fout bij verwerken item ${folderName}: ${msg}`);
        errors++;
        processedItems++;
      }
    }

    onProgress?.({
      stage: 'completed',
      progress: 100,
      message: `Import voltooid: ${imported} geïmporteerd, ${skipped} overgeslagen, ${errors} fouten`,
      questionsProcessed: totalItems,
      totalQuestions: totalItems,
    });

    return {
      imported,
      importedMcq,
      importedOpen,
      skipped,
      skippedReasons,
      errors,
      importedTopSegments: [...importedTopSegmentSet].sort(),
    };
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
): Promise<{ imported: number; importedMcq: number; importedOpen: number; skipped: number; skippedReasons: Record<string, number>; errors: number; importedTopSegments: string[] }> {
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

// De ItemBank-bronconfiguratie loopt via de server (service-role), niet meer
// rechtstreeks naar de admin-only `chatbot_prompts`-tabel. Zo kan een docent een
// eigen bron per cursus instellen (Task #334, stap 5). Geef `courseId` mee voor
// een cursus-override; zonder courseId betreft het de globale (admin-only) bron.
async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Geen actieve sessie');
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session.access_token}`,
  };
}

export async function getShareStatsConfig(courseId?: string): Promise<{
  repositoryUrl: string;
  lastSyncedAt?: string;
  hasOverride?: boolean;
  globalRepositoryUrl?: string;
}> {
  try {
    const headers = await authHeaders();
    const qs = courseId ? `?courseId=${encodeURIComponent(courseId)}` : '';
    const res = await fetch(`/api/admin/itembank-config${qs}`, { headers });
    if (res.ok) {
      const data = await res.json();
      return {
        repositoryUrl: data.repositoryUrl || DEFAULT_REPO_URL,
        lastSyncedAt: data.lastSyncedAt,
        hasOverride: data.hasOverride,
        globalRepositoryUrl: data.globalRepositoryUrl || DEFAULT_REPO_URL,
      };
    }
  } catch (err) {
    console.warn('getShareStatsConfig: kon config niet ophalen:', err);
  }
  return { repositoryUrl: DEFAULT_REPO_URL };
}

export async function saveShareStatsConfig(config: {
  repositoryUrl: string;
  lastSyncedAt?: string;
}, courseId?: string): Promise<void> {
  const headers = await authHeaders();
  const res = await fetch('/api/admin/itembank-config', {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      courseId,
      repositoryUrl: config.repositoryUrl,
      lastSyncedAt: config.lastSyncedAt,
    }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j?.error || `HTTP ${res.status}`);
  }
}

export async function resetShareStatsConfig(courseId: string): Promise<void> {
  const headers = await authHeaders();
  const res = await fetch(`/api/admin/itembank-config/${encodeURIComponent(courseId)}`, {
    method: 'DELETE',
    headers,
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j?.error || `HTTP ${res.status}`);
  }
}
