// src/lib/getCourseFiles.ts

export async function getFilesInFolder(folderPath: string) {
  const response = await fetch(`/files/${folderPath}`);

  if (!response.ok) {
    console.warn("Kon bestanden niet ophalen uit map:", folderPath);
    return [];
  }

  const files = await response.json();

  return files.map((file: any) => ({
    name: file.name,
    url: `/files/${folderPath}/${file.name}`
  }));
}
