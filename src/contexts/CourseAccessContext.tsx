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
}

const CourseAccessContext = createContext<CourseAccessContextType>({
  courses: [],
  loadingCourses: true,
});

export function CourseAccessProvider({ children }: { children: ReactNode }) {
  const { user, profile, loading: authLoading } = useAuth();
  const [courses, setCourses] = useState<Course[]>([]);
  const [loadingCourses, setLoadingCourses] = useState(true);

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
        const mapped: Course[] = memberData.map((row: any) => ({
          role: row.role,
          id: row.courses.id,
          name: row.courses.name,
          folder_name: row.courses.folder_name,
        }));
        setCourses(mapped);
        setLoadingCourses(false);
        return;
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
  }, [user?.id, profile?.role, authLoading]);

  return (
    <CourseAccessContext.Provider value={{ courses, loadingCourses }}>
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
