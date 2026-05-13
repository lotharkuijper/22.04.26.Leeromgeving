import { useState, useEffect } from "react";
import { supabase } from "../lib/supabase";
import { useLanguage } from "../i18n";

import { 
  getRootFolders, 
  getCoursesFromDatabase, 
  compareStorageAndDatabase,
  syncMissingCourses,
  syncMissingStorageCourses
} from "../services/courseSync";



type StorageItem = {
  name: string;
  id: string;
  updated_at: string;
  created_at?: string;
  last_accessed_at?: string;
  metadata: any | null; // null = folder, object = file
};

function DeleteModal({
  itemName,
  onConfirm,
  onCancel,
  lang,
}: {
  itemName: string;
  onConfirm: () => void;
  onCancel: () => void;
  lang: string;
}) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white p-5 rounded-lg shadow-lg w-80">
        <p className="mb-4">
          {lang === 'en'
            ? <><strong>{itemName}</strong> will be deleted.</>
            : <>Map of bestand <strong>{itemName}</strong> wordt verwijderd.</>
          }
        </p>

        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
          >
            {lang === 'en' ? 'Cancel' : 'Annuleer'}
          </button>

          <button
            onClick={onConfirm}
            className="px-3 py-1 rounded bg-red-600 text-white hover:bg-red-700"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

export default function FileManager() {
  const { lang } = useLanguage();
  const [currentPath, setCurrentPath] = useState("");
  const [items, setItems] = useState<StorageItem[]>([]);
  const [loading, setLoading] = useState(false);

  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");

  const [openMenuFor, setOpenMenuFor] = useState<string | null>(null);
  const [menuDirection, setMenuDirection] = useState<"up" | "down">("down");

  const [message, setMessage] = useState<string | null>(null);

  const [itemToDelete, setItemToDelete] = useState<string | null>(null);

  // Verplaatsen: bron + browse‑pad in modaal
  const [moveSource, setMoveSource] = useState<string | null>(null);
  const [movePath, setMovePath] = useState<string>(""); // pad waar je in het modaal “staat”
  const [moveItems, setMoveItems] = useState<StorageItem[]>([]);
  const [moveLoading, setMoveLoading] = useState(false);

useEffect(() => {
  loadItems(currentPath);

  if (currentPath === "") {
    compareStorageAndDatabase();
    syncMissingCourses();
    syncMissingStorageCourses();
  }
}, [currentPath]);

const loadItems = async (path: string) => {
  setLoading(true);

  const { data, error } = await supabase.storage
    .from("resources")
    .list(path, {
      limit: 100,
      offset: 0,
      sortBy: { column: "name", order: "asc" },
    });

  if (error) {
    console.error("Error loading items:", error);
    setItems([]);
  } else {
    setItems((data as StorageItem[]) || []);

    // 🔍 Debug: toon alle root-mappen (cursussen) in de console
    if (path === "") {
      const folders = (data as StorageItem[]).filter(
        (item) => item.metadata === null
      );
      console.log(
        "[COURSE SYNC DEBUG] Root-mappen gevonden:",
        folders.map((f) => f.name)
      );
    }
  }

  setLoading(false);
};


  const loadMoveItems = async (path: string) => {
    setMoveLoading(true);

    const { data, error } = await supabase.storage
      .from("resources")
      .list(path, {
        limit: 100,
        offset: 0,
        sortBy: { column: "name", order: "asc" },
      });

    if (error) {
      console.error("Error loading move items:", error);
      setMoveItems([]);
    } else {
      setMoveItems((data as StorageItem[]) || []);
    }

    setMoveLoading(false);
  };

  const uploadFiles = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files?.length) return;

    for (const file of Array.from(files)) {
      const filePath = `${currentPath}${file.name}`;
      const { error } = await supabase.storage
        .from("resources")
        .upload(filePath, file);

      if (error) {
        alert((lang === 'en' ? 'Upload failed: ' : 'Upload mislukt: ') + error.message);
      }
    }

    loadItems(currentPath);
  };

  const goBack = () => {
    if (!currentPath) return;

    const parts = currentPath.split("/").filter(Boolean);
    parts.pop();

    const newPath = parts.length ? parts.join("/") + "/" : "";
    setCurrentPath(newPath);
  };

  const handleDelete = (name: string) => {
    setItemToDelete(name);
  };

  const handleRename = async (name: string) => {
    try {
      const newName = prompt("Nieuwe naam:", name);
      if (!newName || newName === name) return;

      const item = items.find((i) => i.name === name);
      const isFolder = item?.metadata === null;

      if (isFolder) {
        const oldPath = `${currentPath}${name}/`;
        const newPath = `${currentPath}${newName}/`;

        const { data: files, error: listError } = await supabase.storage
          .from("resources")
          .list(oldPath);

        if (listError) throw listError;

        for (const file of files || []) {
          const copyRes = await supabase.storage
            .from("resources")
            .copy(`${oldPath}${file.name}`, `${newPath}${file.name}`);

          if (copyRes.error) throw copyRes.error;
        }

        const paths = files.map((f) => `${oldPath}${f.name}`);
        if (paths.length > 0) {
          const { error: removeError } = await supabase.storage
            .from("resources")
            .remove(paths);

          if (removeError) throw removeError;
        }

        await supabase.storage
          .from("resources")
          .remove([`${oldPath}.keep`]);

        await supabase.storage
          .from("resources")
          .upload(`${newPath}.keep`, new Blob([]));

        alert(`Map hernoemd naar "${newName}".`);
      } else {
        const oldPath = `${currentPath}${name}`;
        const newPath = `${currentPath}${newName}`;

        const { error: copyError } = await supabase.storage
          .from("resources")
          .copy(oldPath, newPath);

        if (copyError) throw copyError;

        const { error: removeError } = await supabase.storage
          .from("resources")
          .remove([oldPath]);

        if (removeError) throw removeError;

        alert(`Bestand hernoemd naar "${newName}".`);
      }

      loadItems(currentPath);
    } catch (err: any) {
      console.error("Fout bij hernoemen:", err);
      alert("Kon niet hernoemen: " + err.message);
    }
  };

  const handleDuplicate = async (name: string) => {
    try {
      const item = items.find((i) => i.name === name);
      const isFolder = item?.metadata === null;

      if (isFolder) {
        const oldPath = `${currentPath}${name}/`;

        const { data: files, error: listError } = await supabase.storage
          .from("resources")
          .list(oldPath);

        if (listError) throw listError;

        let baseName = `${name} kopie`;
        let newName = baseName;
        let counter = 2;

        const existingNames = items.map((i) => i.name);

        while (existingNames.includes(newName)) {
          newName = `${baseName} ${counter}`;
          counter++;
        }

        const newPath = `${currentPath}${newName}/`;

        const { error: createError } = await supabase.storage
          .from("resources")
          .upload(`${newPath}.keep`, new Blob([]));

        if (createError) throw createError;

        for (const file of files ?? []) {
          if (file.name === ".keep") continue;

          const fromPath = `${oldPath}${file.name}`;
          const toPath = `${newPath}${file.name}`;

          const { error: copyError } = await supabase.storage
            .from("resources")
            .copy(fromPath, toPath);

          if (copyError) throw copyError;
        }

        setMessage(`Map gedupliceerd als "${newName}".`);
      } else {
        let baseName = `${name} kopie`;
        let newName = baseName;
        let counter = 2;

        const existingNames = items.map((i) => i.name);

        while (existingNames.includes(newName)) {
          newName = `${baseName} ${counter}`;
          counter++;
        }

        const oldPath = `${currentPath}${name}`;
        const newPath = `${currentPath}${newName}`;

        const { error: copyError } = await supabase.storage
          .from("resources")
          .copy(oldPath, newPath);

        if (copyError) throw copyError;

        setMessage(`Bestand gedupliceerd als "${newName}".`);
      }

      setTimeout(() => setMessage(null), 3000);
      loadItems(currentPath);
    } catch (err: any) {
      console.error("Fout bij dupliceren:", err);
      alert("Kon niet dupliceren: " + err.message);
    }
  };
// ------------------------------------------------------------
// Recursieve helpers voor mapstructuren
// ------------------------------------------------------------

// Haal ALLE bestanden en submappen op binnen een map
const listRecursive = async (path: string): Promise<string[]> => {
  const { data, error } = await supabase.storage
    .from("resources")
    .list(path);

  if (error) {
    console.error("Fout bij listRecursive:", error);
    return [];
  }

  let allPaths: string[] = [];

  for (const item of data ?? []) {
    const fullPath = `${path}${item.name}`;

    if (item.metadata === null) {
      // map
      allPaths.push(`${fullPath}/.keep`);
      const subPaths = await listRecursive(`${fullPath}/`);
      allPaths = [...allPaths, ...subPaths];
    } else {
      // bestand
      allPaths.push(fullPath);
    }
  }

  return allPaths;
};

// Kopieer volledige boom van source → dest
const copyRecursive = async (source: string, dest: string) => {
  const allPaths = await listRecursive(source);

  // Zorg dat de doelmap bestaat
  await supabase.storage
    .from("resources")
    .upload(`${dest}.keep`, new Blob([]))
    .catch(() => {});

  for (const fullSourcePath of allPaths) {
    const relative = fullSourcePath.replace(source, "");
    const fullDestPath = `${dest}${relative}`;

    if (fullSourcePath.endsWith("/.keep")) {
      // mapstructuur
      await supabase.storage
        .from("resources")
        .upload(fullDestPath, new Blob([]))
        .catch(() => {});
    } else {
      // bestand
      const { error: copyError } = await supabase.storage
        .from("resources")
        .copy(fullSourcePath, fullDestPath);

      if (copyError) throw copyError;
    }
  }
};

// Verwijder volledige boom
const deleteRecursive = async (path: string) => {
  const allPaths = await listRecursive(path);

  if (allPaths.length > 0) {
    const { error } = await supabase.storage
      .from("resources")
      .remove(allPaths);

    if (error) throw error;
  }
};
  
const moveItem = async (name: string, targetPath: string) => {
  const item = items.find((i) => i.name === name);
  const isFolder = item?.metadata === null;

  const sourcePath = isFolder
    ? `${currentPath}${name}/`
    : `${currentPath}${name}`;

  const destPath = isFolder
    ? `${targetPath}${name}/`
    : `${targetPath}${name}`;

  // Prevent: map naar zichzelf verplaatsen
  if (sourcePath === destPath) {
    alert("Je kunt een map niet naar zichzelf verplaatsen.");
    return;
  }

  // Prevent: map naar eigen submap verplaatsen
  if (isFolder && destPath.startsWith(sourcePath)) {
    alert("Je kunt een map niet naar een submap van zichzelf verplaatsen.");
    return;
  }

  try {
    if (isFolder) {
      // 1. Kopieer volledige boom
      await copyRecursive(sourcePath, destPath);

      // 2. Verwijder oude boom
      await deleteRecursive(sourcePath);
    } else {
      // Bestand: copy + remove
      const { error: copyError } = await supabase.storage
        .from("resources")
        .copy(sourcePath, destPath);

      if (copyError) throw copyError;

      const { error: removeError } = await supabase.storage
        .from("resources")
        .remove([sourcePath]);

      if (removeError) throw removeError;
    }

    setMessage(`Verplaatst naar "${targetPath || "/"}".`);
    setTimeout(() => setMessage(null), 3000);
    loadItems(currentPath);
  } catch (err: any) {
    console.error("Fout bij recursief verplaatsen:", err);
    alert("Kon niet verplaatsen: " + err.message);
  }
};

  
  const handleMove = (name: string) => {
    setMoveSource(name);
    setMovePath(""); // start in root
    loadMoveItems("");
  };

  const moveGoBack = () => {
    if (!movePath) return;

    const parts = movePath.split("/").filter(Boolean);
    parts.pop();

    const newPath = parts.length ? parts.join("/") + "/" : "";
    setMovePath(newPath);
    loadMoveItems(newPath);
  };

  const currentMovePathLabel = movePath === "" ? "/" : `/${movePath}`;

  return (
    <>
      {moveSource && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
          <div className="bg-white p-6 rounded-lg shadow-lg w-[480px] space-y-4">
            <h2 className="text-xl font-bold">
              Verplaatsen: {moveSource}
            </h2>

            <p className="text-gray-600">
              Kies de doelmap (je bent nu in:{" "}
              <span className="font-mono">{currentMovePathLabel}</span>).
            </p>

            <div className="flex justify-between items-center">
              <button
                onClick={moveGoBack}
                disabled={!movePath}
                className={`px-3 py-1 rounded text-sm ${
                  movePath
                    ? "bg-gray-200 hover:bg-gray-300"
                    : "bg-gray-100 text-gray-400 cursor-not-allowed"
                }`}
              >
                Naar bovenliggende map
              </button>
            </div>

            <div className="max-h-60 overflow-y-auto border rounded p-2 space-y-1">
              {moveLoading ? (
                <p className="text-sm text-gray-500">{lang === 'en' ? 'Loading...' : 'Laden...'}</p>
              ) : (
                <>
                  {moveItems
                    .filter(
                      (i) =>
                        i.metadata === null && i.name !== moveSource
                    )
                    .map((folder) => (
                      <button
                        key={folder.name}
                        onClick={() => {
                          const newPath = `${movePath}${folder.name}/`;
                          setMovePath(newPath);
                          loadMoveItems(newPath);
                        }}
                        className="block w-full text-left px-3 py-2 hover:bg-gray-100 rounded"
                      >
                        📁 {folder.name}
                      </button>
                    ))}

                  {moveItems.filter(
                    (i) =>
                      i.metadata === null && i.name !== moveSource
                  ).length === 0 && (
                    <p className="text-sm text-gray-500">
                      Geen submappen in deze map.
                    </p>
                  )}
                </>
              )}
            </div>

            <div className="flex justify-end space-x-2 pt-2">
              <button
                onClick={() => {
                  setMoveSource(null);
                  setMovePath("");
                  setMoveItems([]);
                }}
                className="px-4 py-2 bg-gray-200 rounded hover:bg-gray-300"
              >
                Annuleren
              </button>

<button
  onClick={async () => {
    if (!moveSource) return;
    await moveItem(moveSource, movePath);
    setMoveSource(null);
    setMovePath("");
    setMoveItems([]);
  }}
  className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
>
  Verplaatsen naar deze map
</button>

            </div>
          </div>
        </div>
      )}

      <div className="p-6 w-full space-y-6">
        <h1 className="text-3xl font-bold">Bestandsbeheer</h1>

        <div className="flex gap-3">
          <button
            onClick={() => setCreatingFolder(true)}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg"
          >
            Nieuwe map
          </button>

          <label className="px-4 py-2 bg-green-600 text-white rounded-lg cursor-pointer">
            Upload bestanden
            <input
              type="file"
              multiple
              className="hidden"
              onChange={uploadFiles}
            />
          </label>

          {currentPath && (
            <button
              onClick={goBack}
              className="px-4 py-2 bg-gray-300 rounded-lg"
            >
              Terug
            </button>
          )}
        </div>

        <p className="text-gray-600">Pad: /{currentPath}</p>

        {message && (
          <p className="text-sm text-green-700 bg-green-50 border border-green-200 px-3 py-2 rounded">
            {message}
          </p>
        )}

        {loading ? (
          <p>{lang === 'en' ? 'Loading...' : 'Laden...'}</p>
        ) : (
          <div className="space-y-2">
            {creatingFolder && (
              <div className="p-3 border rounded-lg flex items-center gap-3 bg-blue-50">
                <span>📁</span>

                <input
                  autoFocus
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={async (e) => {
                    if (e.key === "Enter" && newFolderName.trim()) {
                      const folderPath = `${currentPath}${newFolderName}/.keep`;

                      const { error } = await supabase.storage
                        .from("resources")
                        .upload(folderPath, new Blob([]));

                      if (error) {
                        alert("Kon map niet maken: " + error.message);
                      }

                      setNewFolderName("");
                      setCreatingFolder(false);
                      loadItems(currentPath);
                    }

                    if (e.key === "Escape") {
                      setNewFolderName("");
                      setCreatingFolder(false);
                    }
                  }}
                  className="flex-1 px-2 py-1 border rounded"
                  placeholder="Naam van nieuwe map…"
                />

                <button
                  onClick={() => {
                    setNewFolderName("");
                    setCreatingFolder(false);
                  }}
                  className="text-sm text-gray-600 hover:text-gray-900"
                >
                  Annuleren
                </button>
              </div>
            )}

            {items.map((item) => (
              <div
                key={item.name}
                className="p-3 border rounded-lg flex justify-between items-center hover:bg-gray-50"
              >
                <div
                  className="flex-1 cursor-pointer"
                  onClick={() => {
                    if (item.metadata === null) {
                      setCurrentPath(currentPath + item.name + "/");
                    }
                  }}
                >
                  {item.metadata === null ? "📁" : "📄"} {item.name}
                </div>

                <div className="relative">
                  <button
                    onClick={(e) => {
                      const rect = (
                        e.currentTarget as HTMLElement
                      ).getBoundingClientRect();
                      const spaceBelow =
                        window.innerHeight - rect.bottom;

                      setMenuDirection(
                        spaceBelow < 150 ? "up" : "down"
                      );
                      setOpenMenuFor(
                        openMenuFor === item.name ? null : item.name
                      );
                    }}
                    className="px-2 py-1 hover:bg-gray-200 rounded"
                  >
                    ⋯
                  </button>

                  {openMenuFor === item.name && (
                    <div
                      className={`absolute right-0 w-40 bg-white border rounded shadow-lg z-10 ${
                        menuDirection === "down"
                          ? "top-full mt-2"
                          : "bottom-full mb-2"
                      }`}
                    >
                      <button
                        onClick={() => {
                          setOpenMenuFor(null);
                          handleRename(item.name);
                        }}
                        className="block w-full text-left px-3 py-2 hover:bg-gray-100"
                      >
                        Hernoemen
                      </button>

                      <button
                        onClick={() => {
                          setOpenMenuFor(null);
                          handleDuplicate(item.name);
                        }}
                        className="block w-full text-left px-3 py-2 hover:bg-gray-100"
                      >
                        Dupliceren
                      </button>

                      <button
                        onClick={() => {
                          setOpenMenuFor(null);
                          handleMove(item.name);
                        }}
                        className="block w-full text-left px-3 py-2 hover:bg-gray-100"
                      >
                        Verplaatsen
                      </button>

                      <button
                        onClick={() => {
                          setOpenMenuFor(null);
                          handleDelete(item.name);
                        }}
                        className="block w-full text-left px-3 py-2 text-red-600 hover:bg-red-50"
                      >
                        {lang === 'en' ? 'Delete' : 'Verwijderen'}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {itemToDelete && (
              <DeleteModal
                itemName={itemToDelete}
                lang={lang}
                onCancel={() => setItemToDelete(null)}
                onConfirm={async () => {
                  const name = itemToDelete;
                  const item = items.find((i) => i.name === name);
                  const isFolder = item?.metadata === null;

                  try {
                    if (isFolder) {
                      const folderPath = `${currentPath}${name}/`;

                      const { data: files, error: listError } =
                        await supabase.storage
                          .from("resources")
                          .list(folderPath);

                      if (listError) throw listError;

                      if (files && files.length > 0) {
                        const paths = files.map(
                          (f) => `${folderPath}${f.name}`
                        );

                        const { error: removeError } =
                          await supabase.storage
                            .from("resources")
                            .remove(paths);

                        if (removeError) throw removeError;
                      }

                      await supabase.storage
                        .from("resources")
                        .remove([`${folderPath}.keep`]);
                    } else {
                      const filePath = `${currentPath}${name}`;
                      const { error: removeError } =
                        await supabase.storage
                          .from("resources")
                          .remove([filePath]);

                      if (removeError) throw removeError;
                    }

                    loadItems(currentPath);
                  } catch (err: any) {
                    console.error("Fout bij verwijderen:", err);
                    alert("Kon niet verwijderen: " + err.message);
                  }

                  setItemToDelete(null);
                }}
              />
            )}
          </div>
        )}
      </div>
    </>
  );
}
