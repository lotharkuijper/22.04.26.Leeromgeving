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
  refreshActiveCourse: () => Promise<void>;
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
      const courseRes = await supabase
        .from("courses")
        .select("id, name, description")
        .eq("id", courseId)
        .single();

      if (courseRes.data) {
        setActiveCourseData({
          id: courseRes.data.id,
          name: courseRes.data.name,
          description: courseRes.data.description,
        });
      }

      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (token) {
        try {
          const response = await fetch(
            `/api/course-rag-folder-ids?courseId=${encodeURIComponent(courseId)}`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (response.ok) {
            const json = await response.json();
            setActiveCourseRagFolderIds(json.ragFolderIds ?? []);
          } else {
            console.error("[ACTIVE COURSE] course-rag-folder-ids error:", response.status);
            setActiveCourseRagFolderIds([]);
          }
        } catch (fetchErr) {
          console.error("[ACTIVE COURSE] course-rag-folder-ids fetch failed:", fetchErr);
          setActiveCourseRagFolderIds([]);
        }
      } else {
        setActiveCourseRagFolderIds([]);
      }
    } catch (err) {
      console.error("[ACTIVE COURSE] Failed to load course data:", err);
    } finally {
      setLoading(false);
    }
  };

  const refreshActiveCourse = async () => {
    if (activeCourseId) {
      await loadCourseData(activeCourseId);
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
    await loadCourseData(courseId);
  };

  return (
    <ActiveCourseContext.Provider
      value={{
        activeCourseId,
        activeCourse,
        activeCourseRagFolderIds,
        setActiveCourse,
        refreshActiveCourse,
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
