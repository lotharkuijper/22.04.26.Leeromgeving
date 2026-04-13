import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useActiveCourse } from '../contexts/ActiveCourseContext';
import { supabase } from '../lib/supabase';
import { generateQuiz, type QuizQuestion } from '../services/llm.service';
import { searchRelevantChunks, formatContextFromChunks } from '../services/rag.service';
import { SourceList, type SourceItem } from '../components/SourceList';
import {
  BookOpen,
  Play,
  CheckCircle,
  XCircle,
  RotateCcw,
  TrendingUp,
  Clock,
  Award
} from 'lucide-react';

type QuizState = 'setup' | 'active' | 'completed';

interface QuizAttempt {
  id: string;
  topic: string;
  difficulty: string;
  score: number;
  total_questions: number;
  created_at: string;
}

export function QuizPage() {
  const { profile } = useAuth();
  const { activeCourseId: activeCourse } = useActiveCourse();
  const [state, setState] = useState<QuizState>('setup');
  const [topic, setTopic] = useState('');
  const [difficulty, setDifficulty] = useState<'easy' | 'medium' | 'hard'>('medium');
  const [numQuestions, setNumQuestions] = useState(5);
  const [questions, setQuestions] = useState<QuizQuestion[]>([]);
  const [currentQuestion, setCurrentQuestion] = useState(0);
  const [selectedAnswers, setSelectedAnswers] = useState<number[]>([]);
  const [showExplanation, setShowExplanation] = useState(false);
  const [loading, setLoading] = useState(false);
  const [attempts, setAttempts] = useState<QuizAttempt[]>([]);
  const [ragSources, setRagSources] = useState<SourceItem[]>([]);

  useEffect(() => {
    loadAttempts();
  }, []);

  const loadAttempts = async () => {
    if (!profile) return;

    const { data } = await supabase
      .from('quiz_attempts')
      .select('*')
      .eq('student_id', profile.id)
      .order('created_at', { ascending: false })
      .limit(5);

    if (data) {
      setAttempts(data);
    }
  };

  const handleStartQuiz = async () => {
    if (!topic.trim()) {
      alert('Voer een onderwerp in');
      return;
    }

    setLoading(true);
    setRagSources([]);
    try {
      let ragContext: string | undefined;
      if (activeCourse !== null) {
        try {
          const chunks = await searchRelevantChunks(
            topic,
            0.65,
            5,
            'quiz',
            profile?.role || 'student',
            activeCourse
          );
          if (chunks.length > 0) {
            ragContext = formatContextFromChunks(chunks);
            setRagSources(chunks.map(c => ({ title: c.documentTitle, similarity: c.similarity })));
            console.log(`[QUIZ] Using RAG context: ${chunks.length} chunks from active course`);
          }
        } catch (ragErr) {
          console.warn('[QUIZ] RAG search failed, generating without context:', ragErr);
        }
      }

      const generatedQuestions = await generateQuiz(topic, difficulty, numQuestions, ragContext);
      setQuestions(generatedQuestions);
      setSelectedAnswers(new Array(generatedQuestions.length).fill(-1));
      setCurrentQuestion(0);
      setState('active');
      setShowExplanation(false);
    } catch (error) {
      console.error('Error generating quiz:', error);
      alert('Er is een fout opgetreden bij het genereren van de quiz');
    } finally {
      setLoading(false);
    }
  };

  const handleSelectAnswer = (answerIndex: number) => {
    const newAnswers = [...selectedAnswers];
    newAnswers[currentQuestion] = answerIndex;
    setSelectedAnswers(newAnswers);
    setShowExplanation(true);
  };

  const handleNextQuestion = () => {
    if (currentQuestion < questions.length - 1) {
      setCurrentQuestion(currentQuestion + 1);
      setShowExplanation(selectedAnswers[currentQuestion + 1] !== -1);
    } else {
      handleFinishQuiz();
    }
  };

  const handlePreviousQuestion = () => {
    if (currentQuestion > 0) {
      setCurrentQuestion(currentQuestion - 1);
      setShowExplanation(selectedAnswers[currentQuestion - 1] !== -1);
    }
  };

  const handleFinishQuiz = async () => {
    const score = selectedAnswers.filter(
      (answer, index) => answer === questions[index].correctAnswer
    ).length;

    if (profile) {
      await supabase.from('quiz_attempts').insert({
        student_id: profile.id,
        topic,
        difficulty,
        score,
        total_questions: questions.length,
        questions_data: questions,
        answers: selectedAnswers
      });
    }

    setState('completed');
    loadAttempts();
  };

  const handleRestart = () => {
    setState('setup');
    setTopic('');
    setCurrentQuestion(0);
    setSelectedAnswers([]);
    setQuestions([]);
    setShowExplanation(false);
    setRagSources([]);
  };

  const currentQ = questions[currentQuestion];
  const isAnswered = selectedAnswers[currentQuestion] !== -1;
  const isCorrect = selectedAnswers[currentQuestion] === currentQ?.correctAnswer;

  if (state === 'setup') {
    return (
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Quiz Module</h1>
          <p className="text-gray-600">
            Test je kennis met een AI-gegenereerde quiz over epidemiologie en biostatistiek
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 bg-white rounded-2xl border border-gray-200 p-6 space-y-6">
            <div>
              <h2 className="text-xl font-bold text-gray-900 mb-4">Nieuwe Quiz Starten</h2>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-2">
                    Onderwerp
                  </label>
                  <input
                    type="text"
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    placeholder="bijv. 'Cohort studies', 'P-waarden', 'Confounding'"
                    className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-cyan-500 focus:border-transparent transition-all outline-none"
                  />
                </div>

                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-2">
                    Moeilijkheidsgraad
                  </label>
                  <div className="grid grid-cols-3 gap-3">
                    {(['easy', 'medium', 'hard'] as const).map((level) => (
                      <button
                        key={level}
                        onClick={() => setDifficulty(level)}
                        className={`px-4 py-3 rounded-lg font-medium transition-all ${
                          difficulty === level
                            ? 'bg-gradient-to-r from-cyan-500 to-cyan-600 text-white shadow-lg'
                            : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                        }`}
                      >
                        {level === 'easy' ? 'Makkelijk' : level === 'medium' ? 'Gemiddeld' : 'Moeilijk'}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-2">
                    Aantal vragen: {numQuestions}
                  </label>
                  <input
                    type="range"
                    min="3"
                    max="10"
                    value={numQuestions}
                    onChange={(e) => setNumQuestions(parseInt(e.target.value))}
                    className="w-full"
                  />
                  <div className="flex justify-between text-xs text-gray-500 mt-1">
                    <span>3</span>
                    <span>10</span>
                  </div>
                </div>

                <button
                  onClick={handleStartQuiz}
                  disabled={loading || !topic.trim()}
                  className="w-full px-6 py-3 bg-gradient-to-r from-cyan-500 to-cyan-600 text-white font-semibold rounded-xl hover:from-cyan-600 hover:to-cyan-700 transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {loading ? (
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <>
                      <Play className="w-5 h-5" />
                      Quiz Genereren en Starten
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <h3 className="text-lg font-bold text-gray-900 mb-4 flex items-center gap-2">
                <Clock className="w-5 h-5 text-cyan-600" />
                Recente Pogingen
              </h3>
              {attempts.length === 0 ? (
                <p className="text-sm text-gray-500">Nog geen pogingen</p>
              ) : (
                <div className="space-y-3">
                  {attempts.map((attempt) => (
                    <div key={attempt.id} className="p-3 bg-gray-50 rounded-lg">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-medium text-gray-900 line-clamp-1">
                          {attempt.topic}
                        </span>
                        <span className="text-xs px-2 py-1 rounded-full bg-cyan-100 text-cyan-700 font-semibold">
                          {attempt.difficulty}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-gray-600">
                          Score: {attempt.score}/{attempt.total_questions}
                        </span>
                        <span className={`font-semibold ${
                          (attempt.score / attempt.total_questions) >= 0.7
                            ? 'text-green-600'
                            : 'text-orange-600'
                        }`}>
                          {Math.round((attempt.score / attempt.total_questions) * 100)}%
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (state === 'active' && currentQ) {
    return (
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{topic}</h1>
            <p className="text-gray-600 text-sm">
              {difficulty === 'easy' ? 'Makkelijk' : difficulty === 'medium' ? 'Gemiddeld' : 'Moeilijk'} niveau
            </p>
            {ragSources.length > 0 && (
              <p className="text-xs text-purple-700 mt-1 flex items-center gap-1">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-purple-500" />
                Gebaseerd op {ragSources.length} bron{ragSources.length !== 1 ? 'nen' : ''} uit cursusmateriaal
              </p>
            )}
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold text-gray-900">
              {currentQuestion + 1} / {questions.length}
            </div>
            <div className="text-sm text-gray-600">
              {selectedAnswers.filter(a => a !== -1).length} beantwoord
            </div>
          </div>
        </div>

        <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-cyan-500 to-cyan-600 transition-all duration-300"
            style={{ width: `${((currentQuestion + 1) / questions.length) * 100}%` }}
          />
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 p-8 space-y-6">
          <div>
            <div className="flex items-start gap-3 mb-6">
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-cyan-500 to-cyan-600 flex items-center justify-center text-white font-bold flex-shrink-0">
                {currentQuestion + 1}
              </div>
              <div className="flex-1">
                <h2 className="text-xl font-semibold text-gray-900">{currentQ.question}</h2>
              </div>
            </div>

            <div className="space-y-3">
              {currentQ.options.map((option, index) => {
                const isSelected = selectedAnswers[currentQuestion] === index;
                const isCorrectAnswer = index === currentQ.correctAnswer;
                const showCorrect = isAnswered && isCorrectAnswer;
                const showWrong = isAnswered && isSelected && !isCorrectAnswer;

                return (
                  <button
                    key={index}
                    onClick={() => !isAnswered && handleSelectAnswer(index)}
                    disabled={isAnswered}
                    className={`w-full text-left p-4 rounded-xl border-2 transition-all ${
                      showCorrect
                        ? 'border-green-500 bg-green-50'
                        : showWrong
                        ? 'border-red-500 bg-red-50'
                        : isSelected
                        ? 'border-cyan-500 bg-cyan-50'
                        : 'border-gray-200 hover:border-cyan-300 hover:bg-gray-50'
                    } ${isAnswered ? 'cursor-default' : 'cursor-pointer'}`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center font-semibold ${
                          showCorrect
                            ? 'bg-green-600 text-white'
                            : showWrong
                            ? 'bg-red-600 text-white'
                            : isSelected
                            ? 'bg-cyan-600 text-white'
                            : 'bg-gray-200 text-gray-700'
                        }`}>
                          {String.fromCharCode(65 + index)}
                        </div>
                        <span className="text-gray-900">{option}</span>
                      </div>
                      {showCorrect && <CheckCircle className="w-5 h-5 text-green-600" />}
                      {showWrong && <XCircle className="w-5 h-5 text-red-600" />}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {showExplanation && (
            <div className={`p-4 rounded-xl border-2 ${
              isCorrect ? 'border-green-200 bg-green-50' : 'border-orange-200 bg-orange-50'
            }`}>
              <div className="flex items-start gap-3">
                {isCorrect ? (
                  <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                ) : (
                  <XCircle className="w-5 h-5 text-orange-600 flex-shrink-0 mt-0.5" />
                )}
                <div>
                  <p className={`font-semibold mb-1 ${
                    isCorrect ? 'text-green-900' : 'text-orange-900'
                  }`}>
                    {isCorrect ? 'Correct!' : 'Helaas, dat is niet juist'}
                  </p>
                  <p className={`text-sm ${
                    isCorrect ? 'text-green-800' : 'text-orange-800'
                  }`}>
                    {currentQ.explanation}
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between">
          <button
            onClick={handlePreviousQuestion}
            disabled={currentQuestion === 0}
            className="px-6 py-3 bg-gray-200 text-gray-700 font-semibold rounded-xl hover:bg-gray-300 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Vorige
          </button>
          <button
            onClick={handleNextQuestion}
            disabled={!isAnswered}
            className="px-6 py-3 bg-gradient-to-r from-cyan-500 to-cyan-600 text-white font-semibold rounded-xl hover:from-cyan-600 hover:to-cyan-700 transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {currentQuestion === questions.length - 1 ? 'Afronden' : 'Volgende'}
          </button>
        </div>
      </div>
    );
  }

  if (state === 'completed') {
    const score = selectedAnswers.filter(
      (answer, index) => answer === questions[index].correctAnswer
    ).length;
    const percentage = Math.round((score / questions.length) * 100);
    const passed = percentage >= 70;

    return (
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center space-y-6">
          <div className={`w-24 h-24 mx-auto rounded-full flex items-center justify-center ${
            passed
              ? 'bg-gradient-to-br from-green-500 to-emerald-600'
              : 'bg-gradient-to-br from-orange-500 to-orange-600'
          }`}>
            <Award className="w-12 h-12 text-white" />
          </div>

          <div>
            <h1 className="text-3xl font-bold text-gray-900 mb-2">Quiz Voltooid!</h1>
            <p className="text-gray-600">Je hebt de quiz over "{topic}" afgerond</p>
          </div>

          <div className="inline-block px-8 py-6 bg-gray-50 rounded-2xl">
            <div className="text-6xl font-bold text-gray-900 mb-2">{percentage}%</div>
            <div className="text-gray-600">
              {score} van {questions.length} correct
            </div>
          </div>

          <div className={`p-4 rounded-xl ${
            passed ? 'bg-green-50 border border-green-200' : 'bg-orange-50 border border-orange-200'
          }`}>
            <p className={`font-semibold ${
              passed ? 'text-green-900' : 'text-orange-900'
            }`}>
              {passed
                ? 'Goed gedaan! Je hebt de quiz succesvol afgerond.'
                : 'Blijf oefenen! Je hebt minimaal 70% nodig om te slagen.'}
            </p>
          </div>

          <div className="flex gap-4 justify-center">
            <button
              onClick={handleRestart}
              className="px-6 py-3 bg-gradient-to-r from-cyan-500 to-cyan-600 text-white font-semibold rounded-xl hover:from-cyan-600 hover:to-cyan-700 transition-all shadow-lg flex items-center gap-2"
            >
              <RotateCcw className="w-5 h-5" />
              Nieuwe Quiz
            </button>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <h2 className="text-xl font-bold text-gray-900 mb-4 flex items-center gap-2">
            <TrendingUp className="w-6 h-6 text-cyan-600" />
            Antwoorden Overzicht
          </h2>
          <div className="space-y-4">
            {questions.map((q, index) => {
              const userAnswer = selectedAnswers[index];
              const isCorrect = userAnswer === q.correctAnswer;

              return (
                <div key={index} className={`p-4 rounded-xl border-2 ${
                  isCorrect ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'
                }`}>
                  <div className="flex items-start gap-3">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold flex-shrink-0 ${
                      isCorrect ? 'bg-green-600 text-white' : 'bg-red-600 text-white'
                    }`}>
                      {index + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-gray-900 mb-2">{q.question}</p>
                      <div className="space-y-1 text-sm">
                        <p className={isCorrect ? 'text-green-700' : 'text-red-700'}>
                          <strong>Jouw antwoord:</strong> {q.options[userAnswer]}
                        </p>
                        {!isCorrect && (
                          <p className="text-green-700">
                            <strong>Correct antwoord:</strong> {q.options[q.correctAnswer]}
                          </p>
                        )}
                        <p className="text-gray-700 mt-2">
                          <strong>Uitleg:</strong> {q.explanation}
                        </p>
                      </div>
                    </div>
                    {isCorrect ? (
                      <CheckCircle className="w-6 h-6 text-green-600 flex-shrink-0" />
                    ) : (
                      <XCircle className="w-6 h-6 text-red-600 flex-shrink-0" />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {ragSources.length > 0 && (
            <div className="mt-2">
              <SourceList sources={ragSources} label="Quiz gebaseerd op cursusmateriaal" />
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}
