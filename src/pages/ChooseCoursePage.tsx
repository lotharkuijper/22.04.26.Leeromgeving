import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { useActiveCourse } from "../contexts/ActiveCourseContext";
import { supabase } from "../lib/supabase";

export default function ChooseCoursePage() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { setActiveCourse, loading: activeLoading } = useActiveCourse();

  const [courses, setCourses] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user || authLoading) return;

    const loadCourses = async () => {
      setLoading(true);

      const { data, error } = await supabase
        .from("courses")
        .select("id, name, description")
        .eq("is_active", true)
        .order("name", { ascending: true });

      if (error) {
        console.error("[COURSE SELECT] Error loading courses:", error);
        setCourses([]);
        setLoading(false);
        return;
      }

      setCourses(data ?? []);
      setLoading(false);
    };

    loadCourses();
  }, [user, authLoading]);

  const handleSelect = async (courseId: string) => {
    console.log("[COURSE SELECT] Switching to:", courseId);
    await setActiveCourse(courseId);
    navigate("/dashboard");
  };

  if (authLoading || loading || activeLoading) {
    return <div style={{ padding: "2rem" }}>Bezig met laden…</div>;
  }

  if (courses.length === 0) {
    return (
      <div style={{ padding: "2rem" }}>
        Er zijn op dit moment geen actieve cursussen beschikbaar. Neem contact op met je docent.
      </div>
    );
  }

  return (
    <div style={{ padding: "2rem", maxWidth: "600px", margin: "0 auto" }}>
      <h1 style={{ marginBottom: "1rem" }}>Kies een cursus</h1>
      <p style={{ marginBottom: "2rem", opacity: 0.8 }}>
        Selecteer de cursus waarmee je wilt werken.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        {courses.map((course) => (
          <button
            key={course.id}
            data-testid={`btn-course-${course.id}`}
            onClick={() => handleSelect(course.id)}
            style={{
              padding: "1rem",
              borderRadius: "8px",
              border: "1px solid #ccc",
              background: "#f9f9f9",
              textAlign: "left",
              cursor: "pointer",
              transition: "0.2s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "#eee")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "#f9f9f9")}
          >
            <strong style={{ fontSize: "1.1rem" }}>{course.name}</strong>
            {course.description && (
              <div style={{ opacity: 0.7 }}>{course.description}</div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
