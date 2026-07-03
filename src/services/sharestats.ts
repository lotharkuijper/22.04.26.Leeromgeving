// src/services/sharestats.ts
import { getItembankRepo, githubProxyFetch } from './github-parser.service';

export interface ShareStatsTopic {
  name: string;
  path: string;
  type: "dir";
}

export interface ShareStatsFile {
  name: string;
  path: string;
  download_url: string;
  type: "file";
}

// Bouw het GitHub-API-pad op uit de runtime-configureerbare repo zodat
// alternatieve forks zonder code-aanpassing kunnen worden gebruikt.
function repoBase(): string {
  const { owner, repo } = getItembankRepo();
  return `repos/${owner}/${repo}/contents`;
}

async function githubFetch(path: string): Promise<any> {
  const res = await githubProxyFetch(path);
  if (!res.ok) {
    throw new Error(`GitHub API error: ${res.status}`);
  }
  return res.json();
}

// -----------------------------
// TOPICS
// -----------------------------
export async function fetchShareStatsTopics(): Promise<ShareStatsTopic[]> {
  try {
    const data = await githubFetch(repoBase());
    return data.filter((item: any) => item.type === "dir");
  } catch (error) {
    console.error("[SHARESTATS] Failed to fetch topics:", error);
    return [];
  }
}

// -----------------------------
// RECURSIVE DIRECTORY FETCH
// -----------------------------
async function fetchDirectoryRecursive(
  apiPath: string,
  depth = 0
): Promise<ShareStatsFile[]> {
  if (depth > 5) return [];

  try {
    const items = await githubFetch(apiPath);
    let files: ShareStatsFile[] = [];

    for (const item of items) {
      if (item.type === "file") {
        files.push(item);
      }

      if (item.type === "dir") {
        const subPath = item.url.replace('https://api.github.com/', '');
        const deeper = await fetchDirectoryRecursive(subPath, depth + 1);
        files = [...files, ...deeper];
      }
    }

    return files;
  } catch (error) {
    console.error("[SHARESTATS] Recursive fetch failed:", error);
    return [];
  }
}

// -----------------------------
// FILES WITHIN TOPIC
// -----------------------------
export async function fetchShareStatsFiles(
  topicPath: string
): Promise<ShareStatsFile[]> {
  try {
    return await fetchDirectoryRecursive(`${repoBase()}/${topicPath}`, 0);
  } catch (error) {
    console.error("[SHARESTATS] Failed to fetch files:", error);
    return [];
  }
}

// -----------------------------
// FILE CONTENT
// -----------------------------
export async function fetchShareStatsFileContent(
  downloadUrl: string
): Promise<string> {
  try {
    const res = await fetch(downloadUrl);
    if (!res.ok) {
      console.error("[SHARESTATS] File fetch error:", res.status);
      return "";
    }
    return await res.text();
  } catch (error) {
    console.error("[SHARESTATS] Failed to fetch file content:", error);
    return "";
  }
}
