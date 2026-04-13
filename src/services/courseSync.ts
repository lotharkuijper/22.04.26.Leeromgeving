import { supabase } from "../lib/supabase";

export async function getRootFolders(): Promise<string[]> {
  const { data, error } = await supabase.storage
    .from("resources")
    .list("", {
      limit: 100,
      offset: 0,
      sortBy: { column: "name", order: "asc" },
    });

  if (error) {
    console.error("[COURSE SYNC] Fout bij ophalen root:", error);
    return [];
  }

  const folders = (data ?? []).filter((item) => item.metadata === null);
  const names = folders.map((f) => f.name);

  console.log("[COURSE SYNC] Root-mappen via service:", names);

  return names;
}

export async function getCoursesFromDatabase(): Promise<string[]> {
  const { data, error } = await supabase
    .from("courses")
    .select("folder_name");

  if (error) {
    console.error("[COURSE SYNC] Fout bij ophalen cursussen uit database:", error);
    return [];
  }

  const names = (data ?? []).map((c) => c.folder_name);

  console.log("[COURSE SYNC] Cursussen in database:", names);

  return names;
}

export async function compareStorageAndDatabase() {
  const rootFolders = await getRootFolders();
  const dbCourses = await getCoursesFromDatabase();

  const missingInDatabase = rootFolders.filter(
    (folder) => !dbCourses.includes(folder)
  );

  const missingInStorage = dbCourses.filter(
    (course) => !rootFolders.includes(course)
  );

  console.log("[COURSE SYNC] Ontbrekende cursussen in database:", missingInDatabase);
  console.log("[COURSE SYNC] Cursussen zonder map in storage:", missingInStorage);

  return { missingInDatabase, missingInStorage };
}

export async function syncMissingCourses() {
  const { missingInDatabase } = await compareStorageAndDatabase();

  if (missingInDatabase.length === 0) {
    console.log("[COURSE SYNC] Geen nieuwe cursussen om toe te voegen.");
    return;
  }

  console.log("[COURSE SYNC] Toevoegen ontbrekende cursussen:", missingInDatabase);

  for (const folderName of missingInDatabase) {
    const { error } = await supabase
      .from("courses")
      .insert([
        { 
          name: folderName,
          folder_name: folderName 
        }
      ]);

    if (error) {
      console.error("[COURSE SYNC] Fout bij toevoegen cursus:", folderName, error);
    } else {
      console.log("[COURSE SYNC] Cursus toegevoegd:", folderName);
    }
  }
}

export async function syncMissingStorageCourses() {
  const { missingInStorage } = await compareStorageAndDatabase();

  if (missingInStorage.length === 0) {
    console.log("[COURSE SYNC] Geen cursussen om te deactiveren.");
    return;
  }

  console.log("[COURSE SYNC] Deactiveren cursussen zonder map:", missingInStorage);

  for (const folderName of missingInStorage) {
    const { error } = await supabase
      .from("courses")
      .update({ is_active: false })
      .eq("folder_name", folderName);

    if (error) {
      console.error("[COURSE SYNC] Fout bij deactiveren cursus:", folderName, error);
    } else {
      console.log("[COURSE SYNC] Cursus gedeactiveerd:", folderName);
    }
  }
}
