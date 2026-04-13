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
  const { user } = useAuth();
  const [courses, setCourses] = useState<Course[]>([]);
  const [loadingCourses, setLoadingCourses] = useState(true);

  useEffect(() => {
    // Auth is still loading → don't reset yet
    if (user === undefined) return;

    // No user → no courses
    if (!user) {
      setCourses([]);
      setLoadingCourses(false);
      return;
    }

    const loadCourses = async () => {
      setLoadingCourses(true);

      const { data, error } = await supabase
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

      if (error) {
        console.error("[COURSES] Error loading courses:", error);
        setCourses([]);
      } else {
        const mapped: Course[] =
          data?.map((row: any) => ({
            role: row.role,
            id: row.courses.id,
            name: row.courses.name,
            folder_name: row.courses.folder_name,
          })) ?? [];

        setCourses(mapped);
      }

      setLoadingCourses(false);
    };

    loadCourses();
  }, [user?.id]); // only reload when user changes

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
