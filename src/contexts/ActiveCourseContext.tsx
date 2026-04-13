import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "./AuthContext";

interface ActiveCourseInfo {
  id: string;
  name: string;
  description: string | null;
}

interface ActiveCourseContextType {
  activeCourseId: string | null;
  activeCourse: ActiveCourseInfo | null;
  activeCourseRagFolderIds: string[];
  setActiveCourse: (courseId: string) => Promise<void>;
  loading: boolean;
}

const ActiveCourseContext = createContext<ActiveCourseContextType | undefined>(undefined);

export function ActiveCourseProvider({ children }: { children: ReactNode }) {
  const { user, profile, refreshProfile, loading: authLoading } = useAuth();
  const [activeCourseId, setActiveCourseId] = useState<string | null>(null);
  const [activeCourse, setActiveCourseData] = useState<ActiveCourseInfo | null>(null);
  const [activeCourseRagFolderIds, setActiveCourseRagFolderIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading) return;
    if (profile?.last_active_course_id) {
      setActiveCourseId(profile.last_active_course_id);
    } else {
      setActiveCourseId(null);
      setActiveCourseData(null);
      setActiveCourseRagFolderIds([]);
      setLoading(false);
    }
  }, [authLoading, profile]);

  useEffect(() => {
    if (!activeCourseId) return;
    loadCourseData(activeCourseId);
  }, [activeCourseId]);

  const loadCourseData = async (courseId: string) => {
    try {
      const [courseRes, foldersRes] = await Promise.all([
        supabase
          .from("courses")
          .select("id, name, description")
          .eq("id", courseId)
          .single(),
        supabase
          .from("course_folder_assignments")
          .select("folder_id, document_folders(id, folder_type)")
          .eq("course_id", courseId),
      ]);

      if (courseRes.data) {
        setActiveCourseData({
          id: courseRes.data.id,
          name: courseRes.data.name,
          description: courseRes.data.description,
        });
      }

      if (foldersRes.data) {
        const ragFolderIds = foldersRes.data
          .filter((a: any) => a.document_folders?.folder_type === "rag_sources")
          .map((a: any) => a.folder_id);
        setActiveCourseRagFolderIds(ragFolderIds);
      }
    } catch (err) {
      console.error("[ACTIVE COURSE] Failed to load course data:", err);
    } finally {
      setLoading(false);
    }
  };

  const setActiveCourse = async (courseId: string) => {
    if (!user) return;

    setLoading(true);

    const { error } = await supabase
      .from("profiles")
      .update({ last_active_course_id: courseId })
      .eq("id", user.id);

    if (error) {
      console.error("[ACTIVE COURSE] Failed to update:", error);
      setLoading(false);
      return;
    }

    await refreshProfile();
    setActiveCourseId(courseId);
  };

  return (
    <ActiveCourseContext.Provider
      value={{
        activeCourseId,
        activeCourse,
        activeCourseRagFolderIds,
        setActiveCourse,
        loading,
      }}
    >
      {children}
    </ActiveCourseContext.Provider>
  );
}

export function useActiveCourse() {
  const ctx = useContext(ActiveCourseContext);
  if (!ctx) {
    throw new Error("useActiveCourse must be used within an ActiveCourseProvider");
  }
  return ctx;
}
