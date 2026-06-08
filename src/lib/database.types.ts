export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      course_members: {
        Row: {
          id: string
          course_id: string
          user_id: string
          member_role: 'student' | 'teacher'
          joined_at: string
        }
        Insert: {
          id?: string
          course_id: string
          user_id: string
          member_role?: 'student' | 'teacher'
          joined_at?: string
        }
        Update: {
          id?: string
          course_id?: string
          user_id?: string
          member_role?: 'student' | 'teacher'
          joined_at?: string
        }
      }
      profiles: {
        Row: {
          id: string
          email: string
          full_name: string | null
          role: 'student' | 'docent' | 'admin'
          university: string | null
          study_year: number | null
          avatar_url: string | null
          preferred_lang: 'nl' | 'en' | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id: string
          email: string
          full_name?: string | null
          role?: 'student' | 'docent' | 'admin'
          university?: string | null
          study_year?: number | null
          avatar_url?: string | null
          preferred_lang?: 'nl' | 'en' | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          email?: string
          full_name?: string | null
          role?: 'student' | 'docent' | 'admin'
          university?: string | null
          study_year?: number | null
          avatar_url?: string | null
          preferred_lang?: 'nl' | 'en' | null
          created_at?: string
          updated_at?: string
        }
      }
      documents: {
        Row: {
          id: string
          title: string
          filename: string
          file_path: string
          file_type: string
          file_size: number
          description: string | null
          uploaded_by: string | null
          folder_id: string | null
          processing_status: 'pending' | 'processing' | 'completed' | 'failed'
          total_chunks: number
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          title: string
          filename: string
          file_path: string
          file_type: string
          file_size?: number
          description?: string | null
          uploaded_by?: string | null
          folder_id?: string | null
          processing_status?: 'pending' | 'processing' | 'completed' | 'failed'
          total_chunks?: number
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          title?: string
          filename?: string
          file_path?: string
          file_type?: string
          file_size?: number
          description?: string | null
          uploaded_by?: string | null
          folder_id?: string | null
          processing_status?: 'pending' | 'processing' | 'completed' | 'failed'
          total_chunks?: number
          created_at?: string
          updated_at?: string
        }
      }
      conversations: {
        Row: {
          id: string
          user_id: string
          title: string
          module_type: 'general' | 'explain' | 'project' | 'quiz'
          context_id: string | null
          course_id: string | null
          status: 'active' | 'archived'
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          user_id: string
          title?: string
          module_type?: 'general' | 'explain' | 'project' | 'quiz'
          context_id?: string | null
          course_id?: string | null
          status?: 'active' | 'archived'
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          title?: string
          module_type?: 'general' | 'explain' | 'project' | 'quiz'
          context_id?: string | null
          course_id?: string | null
          status?: 'active' | 'archived'
          created_at?: string
          updated_at?: string
        }
      }
      messages: {
        Row: {
          id: string
          conversation_id: string
          role: 'user' | 'assistant' | 'system'
          content: string
          retrieved_context: Json
          created_at: string
        }
        Insert: {
          id?: string
          conversation_id: string
          role: 'user' | 'assistant' | 'system'
          content: string
          retrieved_context?: Json
          created_at?: string
        }
        Update: {
          id?: string
          conversation_id?: string
          role?: 'user' | 'assistant' | 'system'
          content?: string
          retrieved_context?: Json
          created_at?: string
        }
      }
      concepts: {
        Row: {
          id: string
          name: string
          category: 'epidemiologie' | 'biostatistiek'
          definition: string | null
          key_points: string[]
          examples: string[]
          course_id: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          category: 'epidemiologie' | 'biostatistiek'
          definition?: string | null
          key_points?: string[]
          examples?: string[]
          course_id?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          name?: string
          category?: 'epidemiologie' | 'biostatistiek'
          definition?: string | null
          key_points?: string[]
          examples?: string[]
          course_id?: string | null
          created_at?: string
          updated_at?: string
        }
      }
      student_explanations: {
        Row: {
          id: string
          concept_id: string
          student_id: string
          explanation_text: string
          version: number
          feedback: Json
          score: Json
          created_at: string
        }
        Insert: {
          id?: string
          concept_id: string
          student_id: string
          explanation_text: string
          version?: number
          feedback?: Json
          score?: Json
          created_at?: string
        }
        Update: {
          id?: string
          concept_id?: string
          student_id?: string
          explanation_text?: string
          version?: number
          feedback?: Json
          score?: Json
          created_at?: string
        }
      }
      quiz_questions: {
        Row: {
          id: string
          question_text: string
          answer_options: Json
          correct_answer: string
          explanation: string | null
          source: 'sharestats' | 'custom'
          sharestats_id: string | null
          topic: string | null
          subtopic: string | null
          language: string | null
          institution: string | null
          metadata: Json
          difficulty: 'beginner' | 'intermediate' | 'advanced'
          validation_status: 'validated' | 'not_validated' | 'rejected'
          validation_score: number
          created_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          question_text: string
          answer_options: Json
          correct_answer: string
          explanation?: string | null
          source?: 'sharestats' | 'custom'
          sharestats_id?: string | null
          topic?: string | null
          subtopic?: string | null
          language?: string | null
          institution?: string | null
          metadata?: Json
          difficulty?: 'beginner' | 'intermediate' | 'advanced'
          validation_status?: 'validated' | 'not_validated' | 'rejected'
          validation_score?: number
          created_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          question_text?: string
          answer_options?: Json
          correct_answer?: string
          explanation?: string | null
          source?: 'sharestats' | 'custom'
          sharestats_id?: string | null
          topic?: string | null
          subtopic?: string | null
          language?: string | null
          institution?: string | null
          metadata?: Json
          difficulty?: 'beginner' | 'intermediate' | 'advanced'
          validation_status?: 'validated' | 'not_validated' | 'rejected'
          validation_score?: number
          created_by?: string | null
          created_at?: string
          updated_at?: string
        }
      }
      quiz_sets: {
        Row: {
          id: string
          name: string
          description: string | null
          difficulty: 'beginner' | 'intermediate' | 'advanced'
          is_public: boolean
          created_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          description?: string | null
          difficulty?: 'beginner' | 'intermediate' | 'advanced'
          is_public?: boolean
          created_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          name?: string
          description?: string | null
          difficulty?: 'beginner' | 'intermediate' | 'advanced'
          is_public?: boolean
          created_by?: string | null
          created_at?: string
          updated_at?: string
        }
      }
      quiz_attempts: {
        Row: {
          id: string
          quiz_set_id: string | null
          student_id: string
          course_id: string | null
          started_at: string
          completed_at: string | null
          score: number
          total_questions: number
          time_spent_seconds: number
          topics: string[] | null
          difficulty: string | null
          question_type: 'mcq' | 'open' | 'casus' | null
          questions_data: Json | null
          answers: Json | null
          score_percentage: number | null
          created_at: string
        }
        Insert: {
          id?: string
          quiz_set_id?: string | null
          student_id: string
          course_id?: string | null
          started_at?: string
          completed_at?: string | null
          score?: number
          total_questions?: number
          time_spent_seconds?: number
          topics?: string[] | null
          difficulty?: string | null
          question_type?: 'mcq' | 'open' | 'casus' | null
          questions_data?: Json | null
          answers?: Json | null
          score_percentage?: number | null
          created_at?: string
        }
        Update: {
          id?: string
          quiz_set_id?: string | null
          student_id?: string
          course_id?: string | null
          started_at?: string
          completed_at?: string | null
          score?: number
          total_questions?: number
          time_spent_seconds?: number
          topics?: string[] | null
          difficulty?: string | null
          question_type?: 'mcq' | 'open' | 'casus' | null
          questions_data?: Json | null
          answers?: Json | null
          score_percentage?: number | null
          created_at?: string
        }
      }
      datasets: {
        Row: {
          id: string
          name: string
          description: string | null
          file_path: string
          file_type: string | null
          file_size: number
          variables_info: Json
          row_count: number
          column_count: number
          uploaded_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          description?: string | null
          file_path: string
          file_type?: string | null
          file_size?: number
          variables_info?: Json
          row_count?: number
          column_count?: number
          uploaded_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          name?: string
          description?: string | null
          file_path?: string
          file_type?: string | null
          file_size?: number
          variables_info?: Json
          row_count?: number
          column_count?: number
          uploaded_by?: string | null
          created_at?: string
          updated_at?: string
        }
      }
      projects: {
        Row: {
          id: string
          title: string
          research_question: string
          dataset_id: string | null
          description: string | null
          difficulty: 'beginner' | 'intermediate' | 'advanced'
          is_public: boolean
          created_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          title: string
          research_question: string
          dataset_id?: string | null
          description?: string | null
          difficulty?: 'beginner' | 'intermediate' | 'advanced'
          is_public?: boolean
          created_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          title?: string
          research_question?: string
          dataset_id?: string | null
          description?: string | null
          difficulty?: 'beginner' | 'intermediate' | 'advanced'
          is_public?: boolean
          created_by?: string | null
          created_at?: string
          updated_at?: string
        }
      }
      student_project_sessions: {
        Row: {
          id: string
          project_id: string
          student_id: string
          current_phase: 'exploration' | 'hypothesis' | 'analysis' | 'interpretation'
          hypothesis: string | null
          analysis_notes: string | null
          conclusions: string | null
          started_at: string
          last_activity: string
          completed: boolean
        }
        Insert: {
          id?: string
          project_id: string
          student_id: string
          current_phase?: 'exploration' | 'hypothesis' | 'analysis' | 'interpretation'
          hypothesis?: string | null
          analysis_notes?: string | null
          conclusions?: string | null
          started_at?: string
          last_activity?: string
          completed?: boolean
        }
        Update: {
          id?: string
          project_id?: string
          student_id?: string
          current_phase?: 'exploration' | 'hypothesis' | 'analysis' | 'interpretation'
          hypothesis?: string | null
          analysis_notes?: string | null
          conclusions?: string | null
          started_at?: string
          last_activity?: string
          completed?: boolean
        }
      }
      collaboration_sessions: {
        Row: {
          id: string
          name: string
          session_type: 'quiz' | 'project'
          context_id: string | null
          status: 'active' | 'completed' | 'archived'
          created_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          session_type: 'quiz' | 'project'
          context_id?: string | null
          status?: 'active' | 'completed' | 'archived'
          created_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          name?: string
          session_type?: 'quiz' | 'project'
          context_id?: string | null
          status?: 'active' | 'completed' | 'archived'
          created_by?: string | null
          created_at?: string
          updated_at?: string
        }
      }
      collaboration_participants: {
        Row: {
          id: string
          session_id: string
          user_id: string
          role: 'owner' | 'member'
          joined_at: string
        }
        Insert: {
          id?: string
          session_id: string
          user_id: string
          role?: 'owner' | 'member'
          joined_at?: string
        }
        Update: {
          id?: string
          session_id?: string
          user_id?: string
          role?: 'owner' | 'member'
          joined_at?: string
        }
      }
      collaboration_messages: {
        Row: {
          id: string
          session_id: string
          user_id: string | null
          message: string
          message_type: 'user' | 'system' | 'bot'
          created_at: string
        }
        Insert: {
          id?: string
          session_id: string
          user_id?: string | null
          message: string
          message_type?: 'user' | 'system' | 'bot'
          created_at?: string
        }
        Update: {
          id?: string
          session_id?: string
          user_id?: string | null
          message?: string
          message_type?: 'user' | 'system' | 'bot'
          created_at?: string
        }
      }
      document_folders: {
        Row: {
          id: string
          name: string
          description: string | null
          parent_folder_id: string | null
          created_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          description?: string | null
          parent_folder_id?: string | null
          created_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          name?: string
          description?: string | null
          parent_folder_id?: string | null
          created_by?: string | null
          created_at?: string
          updated_at?: string
        }
      }
      folder_permissions: {
        Row: {
          id: string
          folder_id: string
          role: 'student' | 'docent' | 'admin'
          can_view: boolean
          can_edit: boolean
          created_at: string
        }
        Insert: {
          id?: string
          folder_id: string
          role: 'student' | 'docent' | 'admin'
          can_view?: boolean
          can_edit?: boolean
          created_at?: string
        }
        Update: {
          id?: string
          folder_id?: string
          role?: 'student' | 'docent' | 'admin'
          can_view?: boolean
          can_edit?: boolean
          created_at?: string
        }
      }
      document_permissions: {
        Row: {
          id: string
          document_id: string
          role: 'student' | 'docent' | 'admin'
          can_view: boolean
          created_at: string
        }
        Insert: {
          id?: string
          document_id: string
          role: 'student' | 'docent' | 'admin'
          can_view?: boolean
          created_at?: string
        }
        Update: {
          id?: string
          document_id?: string
          role?: 'student' | 'docent' | 'admin'
          can_view?: boolean
          created_at?: string
        }
      }
      folder_rag_assignments: {
        Row: {
          id: string
          folder_id: string
          module_type: 'general' | 'explain' | 'project' | 'quiz'
          is_active: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          folder_id: string
          module_type: 'general' | 'explain' | 'project' | 'quiz'
          is_active?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          folder_id?: string
          module_type?: 'general' | 'explain' | 'project' | 'quiz'
          is_active?: boolean
          created_at?: string
          updated_at?: string
        }
      }
      courses: {
        Row: {
          id: string
          name: string
          description: string | null
          is_active: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          description?: string | null
          is_active?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          name?: string
          description?: string | null
          is_active?: boolean
          created_at?: string
          updated_at?: string
        }
      }
      course_enrollments: {
        Row: {
          id: string
          course_id: string
          student_id: string
          enrolled_at: string
          status: 'active' | 'completed' | 'dropped'
        }
        Insert: {
          id?: string
          course_id: string
          student_id: string
          enrolled_at?: string
          status?: 'active' | 'completed' | 'dropped'
        }
        Update: {
          id?: string
          course_id?: string
          student_id?: string
          enrolled_at?: string
          status?: 'active' | 'completed' | 'dropped'
        }
      }
      course_folder_assignments: {
        Row: {
          id: string
          course_id: string
          folder_id: string
          created_at: string
        }
        Insert: {
          id?: string
          course_id: string
          folder_id: string
          created_at?: string
        }
        Update: {
          id?: string
          course_id?: string
          folder_id?: string
          created_at?: string
        }
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      match_document_chunks: {
        Args: {
          query_embedding: number[]
          match_threshold?: number
          match_count?: number
        }
        Returns: {
          id: string
          document_id: string
          content: string
          similarity: number
          document_title: string
          metadata: Json
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
  }
}
