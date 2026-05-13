import { useLanguage } from '../i18n';

export function CoursesAdminPage() {
  const { lang } = useLanguage();
  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 24, fontWeight: "bold" }}>
        {lang === 'en' ? 'Course management (Admin)' : 'Cursusbeheer (Admin)'}
      </h1>

      <p style={{ marginTop: 12 }}>
        {lang === 'en'
          ? 'This is the start of the Admin environment. We will extend this step by step.'
          : 'Dit is het begin van de Admin‑omgeving. We gaan dit stap voor stap uitbreiden.'}
      </p>
    </div>
  );
}
