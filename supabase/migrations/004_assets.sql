-- Axiom Platform: Assets & Builds

CREATE TABLE public.assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  asset_type TEXT NOT NULL CHECK (asset_type IN (
    'sprite','sprite_sheet','texture','texture_atlas',
    'model_3d','material','animation','audio','ui_element','font','particle','map'
  )),
  storage_key TEXT NOT NULL,
  thumbnail_key TEXT,
  file_format TEXT NOT NULL,
  width INT,
  height INT,
  metadata JSONB DEFAULT '{}',
  generation_prompt TEXT,
  generation_model TEXT,
  size_bytes INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_assets_project ON public.assets(project_id);
CREATE INDEX idx_assets_type ON public.assets(project_id, asset_type);

CREATE TABLE public.builds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('web','windows','linux','macos','android')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','building','completed','failed')),
  build_url TEXT,
  log TEXT DEFAULT '',
  version_id UUID REFERENCES public.project_versions(id),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.assets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Project member access" ON public.assets
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      LEFT JOIN public.collaborators c ON c.project_id = p.id
      WHERE p.id = project_id
        AND (p.owner_id = auth.uid() OR c.user_id = auth.uid())
    )
  );

ALTER TABLE public.builds ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Project member access" ON public.builds
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      LEFT JOIN public.collaborators c ON c.project_id = p.id
      WHERE p.id = project_id
        AND (p.owner_id = auth.uid() OR c.user_id = auth.uid())
    )
  );
