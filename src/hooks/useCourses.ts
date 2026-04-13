import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";  // ✔ correcte import

export function useCourses() {
  const [courses, setCourses] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);

  useEffect(() => {
    async function load() {
      const { data, error } = await supabase
        .from("courses")
        .select("*");

      if (error) setError(error);
      else setCourses(data ?? []);

      setLoading(false);
    }

    load();
  }, []);

  return { courses, loading, error };
}
