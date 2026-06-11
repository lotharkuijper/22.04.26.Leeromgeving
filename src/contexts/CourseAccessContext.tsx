import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "./AuthContext";

type Course = {
  id: string;
  name: string;
  folder_name: string;
  role: string;
};

interface CourseAccessContextType {
  courses: Course[];
  loadingCourses: boolean;
  refreshCourses: () => Promise<void>;
}

const CourseAccessContext = createContext<CourseAccessContextType>({
  courses: [],
  loadingCourses: true,
  refreshCourses: async () => {},
});

export function CourseAccessProvider({ children }: { children: ReactNode }) {
  const { user, profile, loading: authLoading } = useAuth();
  const [courses, setCourses] = useState<Course[]>([]);
  const [loadingCourses, setLoadingCourses] = useState(true);
  const [reloadTrigger, setReloadTrigger] = useState(0);

  useEffect(() => {
    if (user === undefined || authLoading) return;

    if (!user) {
      setCourses([]);
      setLoadingCourses(false);
      return;
    }

    const loadCourses = async () => {
      setLoadingCourses(true);

      const { data: memberData, error: memberError } = await supabase
        .from("course_members")
        .select(`
          role,
          courses (
            id,
            name,
            folder_name
          )
        `)
        .eq("user_id", user.id);

      if (memberError) {
        console.error("[COURSES] Error loading course_members:", memberError);
        setCourses([]);
        setLoadingCourses(false);
        return;
      }

      if (memberData && memberData.length > 0) {
        // Task #270: een niet-beschikbare cursus (student_visible=false) wordt
        // door de RLS-policy weggefilterd uit de embedded `courses`-join, óók
        // voor een student die er nog lid van is. Dan is `row.courses` null.
        // Filter die rijen weg: zo verdwijnt de verborgen cursus uit de lijst
        // en voorkomen we een crash op `row.courses.id`. Docenten van de cursus
        // houden de join (RLS-uitzondering) en blijven hem dus wél zien.
        const visibleMembers = memberData.filter((row: any) => row.courses != null);
        if (visibleMembers.length > 0) {
          const mapped: Course[] = visibleMembers.map((row: any) => ({
            role: row.role,
            id: row.courses.id,
            name: row.courses.name,
            folder_name: row.courses.folder_name,
          }));
          setCourses(mapped);
          setLoadingCourses(false);
          return;
        }
        // Alle lidmaatschappen wijzen naar verborgen cursussen → val door naar
        // de student-fallback (toont overige beschikbare cursussen).
      }

      const isStudent = !profile || profile.role === "student";
      if (isStudent) {
        const { data: allCourses, error: allError } = await supabase
          .from("courses")
          .select("id, name, folder_name")
          .eq("is_active", true)
          .order("name", { ascending: true });

        if (allError) {
          console.error("[COURSES] Error loading all courses (student fallback):", allError);
          setCourses([]);
        } else {
          const mapped: Course[] = (allCourses ?? []).map((c: any) => ({
            role: "student",
            id: c.id,
            name: c.name,
            folder_name: c.folder_name ?? "",
          }));
          setCourses(mapped);
        }
      } else {
        setCourses([]);
      }

      setLoadingCourses(false);
    };

    loadCourses();
  }, [user?.id, profile?.role, authLoading, reloadTrigger]);

  const refreshCourses = async () => {
    setReloadTrigger((n) => n + 1);
  };

  return (
    <CourseAccessContext.Provider value={{ courses, loadingCourses, refreshCourses }}>
      {children}
    </CourseAccessContext.Provider>
  );
}

export function useCourseAccess() {
  const context = useContext(CourseAccessContext);
  if (!context) {
    throw new Error("useCourseAccess must be used within a CourseAccessProvider");
  }
  return context;
}
