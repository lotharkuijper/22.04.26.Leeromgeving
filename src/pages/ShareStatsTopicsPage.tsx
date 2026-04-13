// src/pages/ShareStatsTopicsPage.tsx

import { useEffect, useState } from "react";
import { fetchShareStatsTopics, ShareStatsTopic } from "../services/sharestats";
import { useNavigate } from "react-router-dom";
import { LoadingSpinner } from "../components/LoadingSpinner";

export default function ShareStatsTopicsPage() {
  const [topics, setTopics] = useState<ShareStatsTopic[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      const data = await fetchShareStatsTopics();
      setTopics(data);
      setLoading(false);
    };

    load();
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center mt-10">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">ShareStats – Oefenonderwerpen</h1>

      <p className="text-gray-700 mb-6">
        Kies een onderwerp uit de ShareStats‑itembank om mee te oefenen.
        <br />
        <span className="text-sm text-gray-500">
          Let op: deze vragen sluiten niet altijd perfect aan bij onze cursus,
          maar zijn wél heel goed voor extra oefening.
        </span>
      </p>

      <div className="space-y-3">
        {topics.map((topic) => (
          <button
            key={topic.path}
            onClick={() => navigate(`/sharestats/${topic.path}`)}
            className="w-full text-left p-4 bg-white border rounded-lg shadow-sm hover:bg-gray-50 transition"
          >
            <span className="font-medium">{topic.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
