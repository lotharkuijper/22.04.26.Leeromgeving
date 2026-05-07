export interface GitHubFileInfo {
  name: string;
  path: string;
  type: 'file' | 'dir';
  download_url: string | null;
}

export interface ShareStatsRepositoryStructure {
  topics: string[];
  itemsByTopic: Map<string, GitHubFileInfo[]>;
}

let REPO_OWNER = 'ShareStats';
let REPO_NAME = 'itembank';

// Maakt de doel-repository configureerbaar op runtime, zodat docenten een
// alternatieve itembank-fork kunnen gebruiken zonder code-aanpassing.
export function setItembankRepo(owner: string, repo: string): void {
  if (owner) REPO_OWNER = owner;
  if (repo) REPO_NAME = repo;
}

export function getItembankRepo(): { owner: string; repo: string } {
  return { owner: REPO_OWNER, repo: REPO_NAME };
}

export async function fetchGitHubDirectory(path: string = ''): Promise<GitHubFileInfo[]> {
  const apiPath = `repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`;

  try {
    const response = await fetch(`/api/github/${apiPath}`);

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    if (!Array.isArray(data)) {
      return [];
    }

    return data.map((item: any) => ({
      name: item.name,
      path: item.path,
      type: item.type === 'dir' ? 'dir' : 'file',
      download_url: item.download_url,
    }));
  } catch (error) {
    console.error(`Error fetching GitHub directory ${path}:`, error);
    throw error;
  }
}

export async function fetchFileContent(downloadUrl: string): Promise<string> {
  try {
    const response = await fetch(downloadUrl);

    if (!response.ok) {
      throw new Error(`Failed to fetch file: ${response.status} ${response.statusText}`);
    }

    return await response.text();
  } catch (error) {
    console.error('Error fetching file content:', error);
    throw error;
  }
}

export async function getRepositoryTopics(): Promise<string[]> {
  try {
    const rootContents = await fetchGitHubDirectory('');

    const topics = rootContents
      .filter((item) => item.type === 'dir')
      .map((item) => item.name)
      .filter((name) => !name.startsWith('.'));

    return topics;
  } catch (error) {
    console.error('Error fetching repository topics:', error);
    throw error;
  }
}

export async function getItemsForTopic(topic: string): Promise<GitHubFileInfo[]> {
  try {
    const topicContents = await fetchGitHubDirectory(topic);

    const itemFolders = topicContents.filter((item) => item.type === 'dir');

    return itemFolders;
  } catch (error) {
    console.error(`Error fetching items for topic ${topic}:`, error);
    throw error;
  }
}

export async function getRmdFileInFolder(folderPath: string): Promise<string | null> {
  try {
    const folderContents = await fetchGitHubDirectory(folderPath);

    const rmdFile = folderContents.find(
      (item) => item.type === 'file' && item.name.toLowerCase().endsWith('.rmd')
    );

    if (!rmdFile || !rmdFile.download_url) {
      return null;
    }

    const content = await fetchFileContent(rmdFile.download_url);
    return content;
  } catch (error) {
    console.error(`Error fetching Rmd file in folder ${folderPath}:`, error);
    return null;
  }
}

export async function getShareStatsRepository(
  selectedTopics?: string[]
): Promise<ShareStatsRepositoryStructure> {
  const allTopics = await getRepositoryTopics();

  const topicsToFetch = selectedTopics && selectedTopics.length > 0
    ? allTopics.filter((topic) => selectedTopics.includes(topic))
    : allTopics;

  const itemsByTopic = new Map<string, GitHubFileInfo[]>();

  for (const topic of topicsToFetch) {
    const items = await getItemsForTopic(topic);
    itemsByTopic.set(topic, items);
  }

  return {
    topics: topicsToFetch,
    itemsByTopic,
  };
}

// Beschrijft één gevonden .Rmd-bestand: in welk topic het zit,
// in welke (deepste) map het staat (gebruikt als sharestats_id /
// NL-detectie), en waar de inhoud opgehaald kan worden.
export interface RmdFileLocation {
  topic: string;
  folderName: string;
  folderPath: string;
  filePath: string;
  downloadUrl: string;
}

interface GitHubRepoMetadata {
  defaultBranch: string;
}

async function fetchRepoMetadata(): Promise<GitHubRepoMetadata> {
  const response = await fetch(`/api/github/repos/${REPO_OWNER}/${REPO_NAME}`);
  if (!response.ok) {
    throw new Error(`Kon repo-metadata niet ophalen: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  return { defaultBranch: data.default_branch || 'main' };
}

interface GitTreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
}

async function fetchRecursiveTree(branch: string): Promise<{ entries: GitTreeEntry[]; truncated: boolean }> {
  const url = `/api/github/repos/${REPO_OWNER}/${REPO_NAME}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Kon repo-tree niet ophalen: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  return {
    entries: Array.isArray(data.tree) ? data.tree : [],
    truncated: !!data.truncated,
  };
}

// Recursieve fallback: loop de directory-structuur af tot maxDepth.
// Wordt alleen gebruikt als de Trees-API faalt of truncated is.
const HIDDEN_DIR_PREFIXES = ['.', '_'];
async function walkDirectoryForRmd(
  dirPath: string,
  topic: string,
  results: RmdFileLocation[],
  depth: number,
  maxDepth: number
): Promise<void> {
  if (depth > maxDepth) return;
  let entries: GitHubFileInfo[];
  try {
    entries = await fetchGitHubDirectory(dirPath);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.type === 'file' && entry.name.toLowerCase().endsWith('.rmd') && entry.download_url) {
      const slash = entry.path.lastIndexOf('/');
      const folderPath = slash >= 0 ? entry.path.slice(0, slash) : '';
      const folderName = folderPath.split('/').filter(Boolean).pop() || topic;
      results.push({
        topic,
        folderName,
        folderPath,
        filePath: entry.path,
        downloadUrl: entry.download_url,
      });
    } else if (entry.type === 'dir' && !HIDDEN_DIR_PREFIXES.some((p) => entry.name.startsWith(p))) {
      await walkDirectoryForRmd(entry.path, topic, results, depth + 1, maxDepth);
    }
  }
}

// Verzamelt álle .Rmd-bestanden onder de geselecteerde topics, ongeacht hoe
// diep ze zitten. Gebruikt de GitHub Trees-API (één request voor de hele repo)
// als snelle route, met een recursieve directory-walk als fallback.
export async function getAllRmdFiles(selectedTopics?: string[]): Promise<RmdFileLocation[]> {
  const allTopics = await getRepositoryTopics();
  const topicsToFetch = selectedTopics && selectedTopics.length > 0
    ? allTopics.filter((topic) => selectedTopics.includes(topic))
    : allTopics;

  if (topicsToFetch.length === 0) return [];

  // Snelle route: één recursive tree-call voor de hele repo.
  try {
    const meta = await fetchRepoMetadata();
    const { entries, truncated } = await fetchRecursiveTree(meta.defaultBranch);

    if (!truncated && entries.length > 0) {
      const topicSet = new Set(topicsToFetch);
      const results: RmdFileLocation[] = [];
      // Branch kan slashes bevatten (bv. `feature/x`); per segment encoderen
      // zodat de raw.githubusercontent.com-URL geldig blijft.
      const encodedBranch = meta.defaultBranch
        .split('/')
        .map((s) => encodeURIComponent(s))
        .join('/');
      for (const entry of entries) {
        if (entry.type !== 'blob') continue;
        if (!entry.path.toLowerCase().endsWith('.rmd')) continue;
        const segments = entry.path.split('/');
        const topic = segments[0];
        if (!topicSet.has(topic)) continue;
        // Sla bestanden in verborgen mappen over. Alleen directory-segmenten
        // controleren — een bestandsnaam als `_vraag.Rmd` in een gewone map
        // moet wel meegenomen worden.
        const dirSegments = segments.slice(0, -1);
        if (dirSegments.some((seg) => HIDDEN_DIR_PREFIXES.some((p) => seg.startsWith(p)))) continue;
        const folderPath = dirSegments.join('/');
        const folderName = dirSegments[dirSegments.length - 1] || topic;
        const downloadUrl = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${encodedBranch}/${entry.path
          .split('/')
          .map((s) => encodeURIComponent(s))
          .join('/')}`;
        results.push({
          topic,
          folderName,
          folderPath,
          filePath: entry.path,
          downloadUrl,
        });
      }
      return results;
    }
    // truncated of geen entries → val terug op directory-walk per topic.
  } catch (err) {
    console.warn('Trees-API faalde, val terug op directory-walk:', err);
  }

  // Fallback: recursieve directory-walk per topic met ruime dieptelimiet.
  // 20 niveaus is meer dan voldoende voor reële itembanken en voorkomt
  // tegelijk een runaway-recursie bij circulaire of corrupte structuren.
  const results: RmdFileLocation[] = [];
  for (const topic of topicsToFetch) {
    await walkDirectoryForRmd(topic, topic, results, 0, 20);
  }
  return results;
}
