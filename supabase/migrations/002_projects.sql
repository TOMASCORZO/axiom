-- Axiom Platform: Projects, Files, Versions, Collaborators, Engine Config

CREATE TABLE public.projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT DEFAULT '',
  engine_version TEXT NOT NULL DEFAULT '1.0.0',
  is_public BOOLEAN NOT NULL DEFAULT false,
  forked_from UUID REFERENCES public.projects(id) ON DELETE SET NULL,
  thumbnail_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(owner_id, slug)
);

CREATE TABLE public.project_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('text', 'binary')),
  text_content TEXT,
  storage_key TEXT,
  size_bytes INT NOT NULL DEFAULT 0,
  checksum TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_id, path)
);

CREATE INDEX idx_project_files_project ON public.project_files(project_id);
CREATE INDEX idx_project_files_path ON public.project_files(project_id, path);

CREATE TABLE public.project_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  version_number INT NOT NULL,
  label TEXT DEFAULT '',
  snapshot_url TEXT NOT NULL,
  file_manifest JSONB NOT NULL,
  created_by UUID REFERENCES public.profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_id, version_number)
);

CREATE TABLE public.collaborators (
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('viewer','editor','admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE public.engine_config (
  project_id UUID PRIMARY KEY REFERENCES public.projects(id) ON DELETE CASCADE,
  render_backend TEXT NOT NULL DEFAULT 'gl_compatibility',
  physics_engine TEXT NOT NULL DEFAULT 'axiom_physics_2d',
  target_fps INT NOT NULL DEFAULT 60,
  window_width INT NOT NULL DEFAULT 1280,
  window_height INT NOT NULL DEFAULT 720,
  custom_settings JSONB DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS Policies
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Owner full access" ON public.projects
  FOR ALL USING (auth.uid() = owner_id);
CREATE POLICY "Collaborator read" ON public.projects
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.collaborators WHERE project_id = id AND user_id = auth.uid())
  );
CREATE POLICY "Public read" ON public.projects
  FOR SELECT USING (is_public = true);

ALTER TABLE public.project_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Project member access" ON public.project_files
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      LEFT JOIN public.collaborators c ON c.project_id = p.id
      WHERE p.id = project_id
        AND (p.owner_id = auth.uid() OR c.user_id = auth.uid())
    )
  );

ALTER TABLE public.project_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Project member access" ON public.project_versions
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      LEFT JOIN public.collaborators c ON c.project_id = p.id
      WHERE p.id = project_id
        AND (p.owner_id = auth.uid() OR c.user_id = auth.uid())
    )
  );

ALTER TABLE public.collaborators ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Project owner manages collaborators" ON public.collaborators
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.projects WHERE id = project_id AND owner_id = auth.uid())
  );

ALTER TABLE public.engine_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Project member access" ON public.engine_config
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      LEFT JOIN public.collaborators c ON c.project_id = p.id
      WHERE p.id = project_id
        AND (p.owner_id = auth.uid() OR c.user_id = auth.uid())
    )
  );
