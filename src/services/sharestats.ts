// src/services/sharestats.ts

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

const BASE_URL =
  "https://api.github.com/repos/ShareStats/itembank/contents";

// -----------------------------
// AUTH HEADERS
// -----------------------------
const headers: Record<string, string> = {};

const token = import.meta.env.VITE_GITHUB_TOKEN;

// Fine-grained GitHub tokens vereisen: "token <TOKEN>"
if (token) {
  headers["Authorization"] = `token ${token}`;
  headers["Accept"] = "application/vnd.github+json";
}

// -----------------------------
// TOPICS
// -----------------------------
export async function fetchShareStatsTopics(): Promise<ShareStatsTopic[]> {
  try {
    const res = await fetch(BASE_URL, { headers });

    if (!res.ok) {
      console.error("[SHARESTATS] GitHub API error:", res.status);
      return [];
    }

    const data = await res.json();

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
  url: string,
  depth = 0
): Promise<ShareStatsFile[]> {
  if (depth > 5) return []; // veiligheid

  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return [];

    const items = await res.json();
    let files: ShareStatsFile[] = [];

    for (const item of items) {
      if (item.type === "file") {
        files.push(item);
      }

      if (item.type === "dir") {
        const deeper = await fetchDirectoryRecursive(item.url, depth + 1);
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
    const topicUrl = `${BASE_URL}/${topicPath}`;
    return await fetchDirectoryRecursive(topicUrl, 0);
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
    const res = await fetch(downloadUrl, { headers });
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
