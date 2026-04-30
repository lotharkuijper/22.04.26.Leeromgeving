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
