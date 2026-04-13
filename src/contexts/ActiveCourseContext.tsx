import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "./AuthContext";

interface ActiveCourseContextType {
  activeCourseId: string | null;
  setActiveCourse: (courseId: string) => Promise<void>;
  loading: boolean;
}

const ActiveCourseContext = createContext<ActiveCourseContextType | undefined>(undefined);

export function ActiveCourseProvider({ children }: { children: ReactNode }) {
  const { user, profile, refreshProfile, loading: authLoading } = useAuth();
  const [activeCourseId, setActiveCourseId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Load active course from profile once auth is ready
  useEffect(() => {
    if (authLoading) return;

    if (profile?.last_active_course_id) {
      setActiveCourseId(profile.last_active_course_id);
    } else {
      setActiveCourseId(null);
    }

    setLoading(false);
  }, [authLoading, profile]);

  // Switch active course
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

    // Refresh profile so AuthContext stays in sync
    await refreshProfile();

    setActiveCourseId(courseId);
    setLoading(false);
  };

  return (
    <ActiveCourseContext.Provider
      value={{
        activeCourseId,
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
