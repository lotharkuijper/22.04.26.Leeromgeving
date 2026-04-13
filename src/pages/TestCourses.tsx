import { useCourses } from "../hooks/useCourses";

export default function TestCourses() {
  const { courses, loading, error } = useCourses();

  console.log("Courses:", courses);
  console.log("Loading:", loading);
  console.log("Error:", error);

  if (loading) return <p>Loading…</p>;
  if (error) return <p>Error: {error.message}</p>;

  return (
    <pre>{JSON.stringify(courses, null, 2)}</pre>
  );
}
