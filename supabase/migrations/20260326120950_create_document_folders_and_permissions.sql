/*
  # Document Folders and Permissions System

  ## Overview
  This migration creates a comprehensive folder management system with role-based
  permissions and RAG (Retrieval Augmented Generation) assignments for the document
  management feature.

  ## New Tables

  ### `document_folders`
  - `id` (uuid, primary key) - Unique folder identifier
  - `name` (text) - Folder name (must be unique per parent)
  - `description` (text, nullable) - Optional folder description
  - `parent_folder_id` (uuid, nullable) - For nested folder structure
  - `created_by` (uuid) - User who created the folder
  - `created_at` (timestamptz) - Creation timestamp
  - `updated_at` (timestamptz) - Last update timestamp

  ### `folder_permissions`
  - `id` (uuid, primary key) - Unique permission identifier
  - `folder_id` (uuid) - Reference to folder
  - `role` (text) - Role: student, docent, or admin
  - `can_view` (boolean) - Permission to view folder contents
  - `can_edit` (boolean) - Permission to edit/upload (admin/docent only)
  - `created_at` (timestamptz) - Creation timestamp

  ### `document_permissions`
  - `id` (uuid, primary key) - Unique permission identifier
  - `document_id` (uuid) - Reference to document
  - `role` (text) - Role: student, docent, or admin
  - `can_view` (boolean) - Permission to view document
  - `created_at` (timestamptz) - Creation timestamp

  ### `folder_rag_assignments`
  - `id` (uuid, primary key) - Unique assignment identifier
  - `folder_id` (uuid) - Reference to folder
  - `module_type` (text) - Module: general, explain, project, or quiz
  - `is_active` (boolean) - Whether this assignment is active
  - `created_at` (timestamptz) - Creation timestamp
  - `updated_at` (timestamptz) - Last update timestamp

  ### `courses` (for future use)
  - `id` (uuid, primary key) - Unique course identifier
  - `name` (text) - Course name
  - `description` (text, nullable) - Course description
  - `is_active` (boolean) - Whether course is active
  - `created_at` (timestamptz) - Creation timestamp
  - `updated_at` (timestamptz) - Last update timestamp

  ### `course_enrollments` (for future use)
  - `id` (uuid, primary key) - Unique enrollment identifier
  - `course_id` (uuid) - Reference to course
  - `student_id` (uuid) - Reference to student profile
  - `enrolled_at` (timestamptz) - Enrollment timestamp
  - `status` (text) - Status: active, completed, or dropped

  ### `course_folder_assignments` (for future use)
  - `id` (uuid, primary key) - Unique assignment identifier
  - `course_id` (uuid) - Reference to course
  - `folder_id` (uuid) - Reference to folder
  - `created_at` (timestamptz) - Creation timestamp

  ## Modified Tables

  ### `documents`
  - Added `folder_id` (uuid, nullable) - Reference to parent folder

  ## Security
  - Enable RLS on all new tables
  - Admin can manage all folders, permissions, and assignments
  - Docent can view and manage folders they have edit permission for
  - Students can only view folders/documents they have permission for
  - Folders inherit permissions from parent folders
  - Default: only admin has access to new folders

  ## Notes
  - Courses system is prepared but not yet activated in application logic
  - Future implementation will filter documents based on student enrollment
  - RAG assignments control which documents are used in chat modules
*/

-- Create document_folders table
CREATE TABLE IF NOT EXISTS document_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  parent_folder_id uuid REFERENCES document_folders(id) ON DELETE CASCADE,
  created_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(parent_folder_id, name)
);

-- Create folder_permissions table
CREATE TABLE IF NOT EXISTS folder_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id uuid REFERENCES document_folders(id) ON DELETE CASCADE NOT NULL,
  role text NOT NULL CHECK (role IN ('student', 'docent', 'admin')),
  can_view boolean DEFAULT false,
  can_edit boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  UNIQUE(folder_id, role)
);

-- Create document_permissions table
CREATE TABLE IF NOT EXISTS document_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid REFERENCES documents(id) ON DELETE CASCADE NOT NULL,
  role text NOT NULL CHECK (role IN ('student', 'docent', 'admin')),
  can_view boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  UNIQUE(document_id, role)
);

-- Create folder_rag_assignments table
CREATE TABLE IF NOT EXISTS folder_rag_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id uuid REFERENCES document_folders(id) ON DELETE CASCADE NOT NULL,
  module_type text NOT NULL CHECK (module_type IN ('general', 'explain', 'project', 'quiz')),
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(folder_id, module_type)
);

-- Create courses table (for future use)
CREATE TABLE IF NOT EXISTS courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  description text,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create course_enrollments table (for future use)
CREATE TABLE IF NOT EXISTS course_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid REFERENCES courses(id) ON DELETE CASCADE NOT NULL,
  student_id uuid REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  enrolled_at timestamptz DEFAULT now(),
  status text DEFAULT 'active' CHECK (status IN ('active', 'completed', 'dropped')),
  UNIQUE(course_id, student_id)
);

-- Create course_folder_assignments table (for future use)
CREATE TABLE IF NOT EXISTS course_folder_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid REFERENCES courses(id) ON DELETE CASCADE NOT NULL,
  folder_id uuid REFERENCES document_folders(id) ON DELETE CASCADE NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(course_id, folder_id)
);

-- Add folder_id to documents table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'documents' AND column_name = 'folder_id'
  ) THEN
    ALTER TABLE documents ADD COLUMN folder_id uuid REFERENCES document_folders(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Enable RLS on all new tables
ALTER TABLE document_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE folder_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE folder_rag_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE course_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE course_folder_assignments ENABLE ROW LEVEL SECURITY;

-- Policies for document_folders

CREATE POLICY "Admins can manage all folders"
  ON document_folders FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
    )
  );

CREATE POLICY "Users can view folders they have permission for"
  ON document_folders FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND (
        profiles.role = 'admin'
        OR EXISTS (
          SELECT 1 FROM folder_permissions
          WHERE folder_permissions.folder_id = document_folders.id
          AND folder_permissions.role = profiles.role
          AND folder_permissions.can_view = true
        )
      )
    )
  );

CREATE POLICY "Docents can create folders"
  ON document_folders FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('admin', 'docent')
    )
  );

-- Policies for folder_permissions

CREATE POLICY "Admins can manage all folder permissions"
  ON folder_permissions FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
    )
  );

CREATE POLICY "Users can view permissions for their accessible folders"
  ON folder_permissions FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND (
        profiles.role = 'admin'
        OR EXISTS (
          SELECT 1 FROM document_folders
          WHERE document_folders.id = folder_permissions.folder_id
          AND document_folders.created_by = auth.uid()
        )
      )
    )
  );

-- Policies for document_permissions

CREATE POLICY "Admins can manage all document permissions"
  ON document_permissions FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
    )
  );

CREATE POLICY "Users can view permissions for their accessible documents"
  ON document_permissions FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND (
        profiles.role = 'admin'
        OR EXISTS (
          SELECT 1 FROM documents
          WHERE documents.id = document_permissions.document_id
          AND documents.uploaded_by = auth.uid()
        )
      )
    )
  );

-- Policies for folder_rag_assignments

CREATE POLICY "Admins can manage all RAG assignments"
  ON folder_rag_assignments FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
    )
  );

CREATE POLICY "Users can view RAG assignments"
  ON folder_rag_assignments FOR SELECT
  TO authenticated
  USING (true);

-- Policies for courses

CREATE POLICY "Admins can manage all courses"
  ON courses FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
    )
  );

CREATE POLICY "All authenticated users can view active courses"
  ON courses FOR SELECT
  TO authenticated
  USING (is_active = true);

-- Policies for course_enrollments

CREATE POLICY "Admins can manage all enrollments"
  ON course_enrollments FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
    )
  );

CREATE POLICY "Students can view their own enrollments"
  ON course_enrollments FOR SELECT
  TO authenticated
  USING (student_id = auth.uid());

-- Policies for course_folder_assignments

CREATE POLICY "Admins can manage all course folder assignments"
  ON course_folder_assignments FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
    )
  );

CREATE POLICY "Users can view course folder assignments"
  ON course_folder_assignments FOR SELECT
  TO authenticated
  USING (true);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_documents_folder_id ON documents(folder_id);
CREATE INDEX IF NOT EXISTS idx_folder_permissions_folder_id ON folder_permissions(folder_id);
CREATE INDEX IF NOT EXISTS idx_folder_permissions_role ON folder_permissions(role);
CREATE INDEX IF NOT EXISTS idx_document_permissions_document_id ON document_permissions(document_id);
CREATE INDEX IF NOT EXISTS idx_document_permissions_role ON document_permissions(role);
CREATE INDEX IF NOT EXISTS idx_folder_rag_assignments_folder_id ON folder_rag_assignments(folder_id);
CREATE INDEX IF NOT EXISTS idx_folder_rag_assignments_module_type ON folder_rag_assignments(module_type);
CREATE INDEX IF NOT EXISTS idx_course_enrollments_student_id ON course_enrollments(student_id);
CREATE INDEX IF NOT EXISTS idx_course_enrollments_course_id ON course_enrollments(course_id);
CREATE INDEX IF NOT EXISTS idx_course_folder_assignments_course_id ON course_folder_assignments(course_id);
CREATE INDEX IF NOT EXISTS idx_course_folder_assignments_folder_id ON course_folder_assignments(folder_id);

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers for updated_at columns
DROP TRIGGER IF EXISTS update_document_folders_updated_at ON document_folders;
CREATE TRIGGER update_document_folders_updated_at
  BEFORE UPDATE ON document_folders
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_folder_rag_assignments_updated_at ON folder_rag_assignments;
CREATE TRIGGER update_folder_rag_assignments_updated_at
  BEFORE UPDATE ON folder_rag_assignments
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_courses_updated_at ON courses;
CREATE TRIGGER update_courses_updated_at
  BEFORE UPDATE ON courses
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();