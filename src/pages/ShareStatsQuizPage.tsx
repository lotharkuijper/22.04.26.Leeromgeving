// src/pages/ShareStatsQuizPage.tsx

import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  fetchShareStatsFiles,
  fetchShareStatsFileContent,
  ShareStatsFile,
} from "../services/sharestats";
import { LoadingSpinner } from "../components/LoadingSpinner";

export default function ShareStatsQuizPage() {
  const { topic } = useParams<{ topic: string }>();

  const [files, setFiles] = useState<ShareStatsFile[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [currentContent, setCurrentContent] = useState<string>("");
  const [loadingFiles, setLoadingFiles] = useState(true);
  const [loadingContent, setLoadingContent] = useState(true);

  // 1. Haal alle bestanden binnen het onderwerp op
  useEffect(() => {
    const loadFiles = async () => {
      if (!topic) return;

      setLoadingFiles(true);
      const data = await fetchShareStatsFiles(topic);
      setFiles(data);
      setLoadingFiles(false);
    };

    loadFiles();
  }, [topic]);

  // 2. Haal de inhoud van het huidige vraagbestand op
  useEffect(() => {
    const loadContent = async () => {
      if (files.length === 0) return;

      setLoadingContent(true);
      const file = files[currentIndex];
      const text = await fetchShareStatsFileContent(file.download_url);
      setCurrentContent(text);
      setLoadingContent(false);
    };

    loadContent();
  }, [files, currentIndex]);

  if (loadingFiles) {
    return (
      <div className="flex justify-center mt-10">
        <LoadingSpinner />
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="p-4">
        <h1 className="text-xl font-bold mb-4">Geen vragen gevonden</h1>
        <p className="text-gray-600">
          Dit onderwerp bevat geen vraagbestanden in de ShareStats‑repository.
        </p>
      </div>
    );
  }

  const file = files[currentIndex];

  return (
    <div className="max-w-3xl mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">
        ShareStats – {topic}
      </h1>

      <p className="text-gray-600 mb-4">
        Vraag {currentIndex + 1} van {files.length}
      </p>

      <div className="bg-white border rounded-lg shadow-sm p-4 whitespace-pre-wrap">
        {loadingContent ? (
          <div className="flex justify-center">
            <LoadingSpinner />
          </div>
        ) : (
          <pre className="text-sm overflow-x-auto">{currentContent}</pre>
        )}
      </div>

      <div className="flex justify-between mt-6">
        <button
          disabled={currentIndex === 0}
          onClick={() => setCurrentIndex((i) => i - 1)}
          className="px-4 py-2 bg-gray-200 rounded disabled:opacity-50"
        >
          Vorige
        </button>

        <button
          disabled={currentIndex === files.length - 1}
          onClick={() => setCurrentIndex((i) => i + 1)}
          className="px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50"
        >
          Volgende
        </button>
      </div>
    </div>
  );
}
