create table if not exists public.document_folders (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  parent_folder_id uuid references public.document_folders(id) on delete cascade,
  folder_type text,
  is_root boolean default false,
  created_by uuid,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);
