import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useLanguage } from "../i18n";

type Course = {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  updated_at: string | null;
};

export default function CoursesAdminPage() {
  const { lang } = useLanguage();
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);

  async function fetchCourses() {
    setLoading(true);

    const { data, error } = await supabase
      .from("courses")
      .select("id, name, slug, active, updated_at")
      .order("name", { ascending: true });

    if (error) {
      console.error("Error fetching courses", error);
    } else {
      setCourses(data || []);
    }

    setLoading(false);
  }

  useEffect(() => {
    fetchCourses();
  }, []);

  async function toggleActive(course: Course) {
    const { error } = await supabase
      .from("courses")
      .update({
        active: !course.active,
        updated_at: new Date().toISOString(),
      })
      .eq("id", course.id);

    if (error) {
      console.error("Error updating course", error);
    } else {
      fetchCourses();
    }
  }

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 24, fontWeight: "bold", marginBottom: 16 }}>
        {lang === 'en' ? 'Course management' : 'Cursusbeheer'}
      </h1>

      {loading && <div>{lang === 'en' ? 'Loading…' : 'Bezig met laden…'}</div>}

      {!loading && courses.length === 0 && (
        <div>{lang === 'en' ? 'No courses found.' : 'Geen cursussen gevonden.'}</div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {courses.map((course) => (
          <div
            key={course.id}
            style={{
              border: "1px solid #ddd",
              borderRadius: 6,
              padding: 12,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <div>
              <div style={{ fontWeight: "bold" }}>{course.name}</div>
              <div style={{ fontSize: 12, color: "#666" }}>
                Slug: {course.slug}
              </div>
              <div style={{ fontSize: 12, color: "#aaa" }}>
                {lang === 'en' ? 'Last updated' : 'Laatst bijgewerkt'}: {course.updated_at ?? "—"}
              </div>
            </div>

            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={course.active}
                onChange={() => toggleActive(course)}
              />
              {lang === 'en' ? 'Active' : 'Actief'}
            </label>
          </div>
        ))}
      </div>
    </div>
  );
}
