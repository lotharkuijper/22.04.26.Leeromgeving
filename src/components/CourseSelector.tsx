import { useCourseAccess } from "../contexts/CourseAccessContext";
import { useActiveCourse } from "../contexts/ActiveCourseContext";

export default function CourseSelector() {
  const { courses } = useCourseAccess();
  const { activeCourse, chooseCourse } = useActiveCourse();

  // Als er maar 0 of 1 cursus is, geen selector tonen
  if (!courses || courses.length <= 1) return null;

  return (
    <div className="p-4 border-r bg-gray-50 h-full">
      <h3 className="font-semibold mb-3">Kies een cursus</h3>

      {courses.map((course) => (
        <button
          key={course.id}
          onClick={() => chooseCourse(course)}
          className={`block w-full text-left px-3 py-2 rounded mb-2 transition ${
            activeCourse?.id === course.id
              ? "bg-blue-600 text-white"
              : "bg-white hover:bg-gray-100"
          }`}
        >
          {course.name}
        </button>
      ))}
    </div>
  );
}
