import { useActiveCourse } from "../contexts/ActiveCourseContext";
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

export default function ActiveCourseBadge() {
  const { activeCourseId } = useActiveCourse();
  const [courseName, setCourseName] = useState<string | null>(null);

  useEffect(() => {
    if (!activeCourseId) {
      setCourseName(null);
      return;
    }

    const loadCourse = async () => {
      const { data, error } = await supabase
        .from("courses")
        .select("name")
        .eq("id", activeCourseId)
        .single();

      if (error) {
        console.error("[ACTIVE COURSE BADGE] Error loading course:", error);
        setCourseName(null);
        return;
      }

      setCourseName(data.name);
    };

    loadCourse();
  }, [activeCourseId]);

  if (!courseName) {
    return (
      <div style={{ opacity: 0.6, fontSize: "0.9rem" }}>
        Geen actieve cursus
      </div>
    );
  }

  return (
    <div
      style={{
        background: "#eef",
        padding: "0.4rem 0.8rem",
        borderRadius: "6px",
        fontSize: "0.9rem",
        fontWeight: 600,
        color: "#334",
      }}
    >
      Actieve cursus: {courseName}
    </div>
  );
}
