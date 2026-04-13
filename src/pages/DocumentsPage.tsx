import { useEffect, useState } from "react";
import {
  getRootFolder,
  getFolderById,
  getFolderTree,
  createFolder,
} from "../services/folder.service";
import {
  getDocumentsInFolder,
  uploadDocument,
} from "../services/folder.service";

export default function DocumentsPage() {
  const [root, setRoot] = useState<any>(null);
  const [currentFolder, setCurrentFolder] = useState<any>(null);
  const [folderTree, setFolderTree] = useState<any[]>([]);
  const [documents, setDocuments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Initial load
  useEffect(() => {
    loadRoot();
  }, []);

  async function loadRoot() {
    setLoading(true);
    const rootFolder = await getRootFolder();
    setRoot(rootFolder);
    await loadFolder(rootFolder.id);
    setLoading(false);
  }

  async function loadFolder(folderId: string) {
    setLoading(true);

    const folder = await getFolderById(folderId);
    const tree = await getFolderTree();
    const docs = await getDocumentsInFolder(folderId);

    setCurrentFolder(folder);
    setFolderTree(tree);
    setDocuments(docs);

    setLoading(false);
  }

  async function handleCreateFolder() {
    const name = prompt("Naam van nieuwe map:");
    if (!name) return;

    await createFolder({
      name,
      parent_folder_id: currentFolder.id,
    });

    await loadFolder(currentFolder.id);
  }

  async function handleUpload(e: any) {
    const files = e.target.files;
    if (!files?.length) return;

    for (const file of files) {
      await uploadDocument(currentFolder.id, file);
    }

    await loadFolder(currentFolder.id);
  }

  function renderTree(nodes: any[]) {
    return (
      <ul className="ml-4 space-y-1">
        {nodes.map((node) => (
          <li key={node.id}>
            <button
              onClick={() => loadFolder(node.id)}
              className={`text-left ${
                currentFolder?.id === node.id
                  ? "font-bold text-blue-600"
                  : "text-gray-700"
              }`}
            >
              📁 {node.name}
            </button>

            {node.children?.length > 0 && renderTree(node.children)}
          </li>
        ))}
      </ul>
    );
  }

  if (loading || !currentFolder) {
    return (
      <div className="p-6">
        <p>Laden...</p>
      </div>
    );
  }

  return (
    <div className="p-6 grid grid-cols-4 gap-6">
      {/* Sidebar: folder tree */}
      <div className="col-span-1 border-r pr-4">
        <h2 className="text-xl font-bold mb-3">Mappen</h2>
        {renderTree(folderTree)}
      </div>

      {/* Main content */}
      <div className="col-span-3 space-y-6">
        <div className="flex justify-between items-center">
          <h1 className="text-2xl font-bold">{currentFolder.name}</h1>

          <div className="flex gap-3">
            <button
              onClick={handleCreateFolder}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg"
            >
              Nieuwe map
            </button>

            <label className="px-4 py-2 bg-green-600 text-white rounded-lg cursor-pointer">
              Upload document
              <input
                type="file"
                className="hidden"
                onChange={handleUpload}
              />
            </label>
          </div>
        </div>

        <div className="space-y-2">
          <h2 className="text-lg font-semibold">Documenten</h2>

          {documents.length === 0 && (
            <p className="text-gray-500">Geen documenten in deze map.</p>
          )}

          {documents.map((doc) => (
            <div
              key={doc.id}
              className="p-3 border rounded-lg flex justify-between"
            >
              <span>📄 {doc.name}</span>
              <a
                href={doc.url}
                target="_blank"
                className="text-blue-600 underline"
              >
                Download
              </a>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
