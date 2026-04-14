-- ============================================================
-- Axiom Engine — Supabase Setup Script
-- Run this ONCE in Supabase SQL Editor (supabase.com → SQL Editor)
-- ============================================================

-- ── 1. Profiles ────────────────────────────────────────────────
-- Extended user profile linked to auth.users
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    display_name TEXT,
    avatar_url TEXT,
    plan TEXT DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'team', 'enterprise')),
    ai_credits_remaining INTEGER DEFAULT 100,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own profile" ON public.profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE USING (auth.uid() = id);

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, display_name, avatar_url)
    VALUES (
        NEW.id,
        COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
        NEW.raw_user_meta_data->>'avatar_url'
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ── 2. Projects ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    game_type TEXT DEFAULT '2d' CHECK (game_type IN ('2d', '3d')),
    engine_version TEXT DEFAULT '1.0.0',
    thumbnail_url TEXT,
    is_public BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can CRUD own projects" ON public.projects FOR ALL USING (auth.uid() = owner_id);
CREATE POLICY "Public projects are readable" ON public.projects FOR SELECT USING (is_public = true);

-- ── 3. Project Files ───────────────────────────────────────────
-- Text-based game files (scenes, scripts, configs)
CREATE TABLE IF NOT EXISTS public.project_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    content_type TEXT DEFAULT 'text/plain',
    text_content TEXT DEFAULT '',
    size_bytes INTEGER DEFAULT 0,
    storage_key TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(project_id, path)
);

ALTER TABLE public.project_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can CRUD own project files" ON public.project_files FOR ALL
    USING (project_id IN (SELECT id FROM public.projects WHERE owner_id = auth.uid()));

CREATE INDEX IF NOT EXISTS idx_project_files_project ON public.project_files(project_id);
CREATE INDEX IF NOT EXISTS idx_project_files_path ON public.project_files(project_id, path);

-- ── 4. Assets ──────────────────────────────────────────────────
-- AI-generated assets metadata
CREATE TABLE IF NOT EXISTS public.assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    asset_type TEXT NOT NULL CHECK (asset_type IN (
        'sprite','sprite_sheet','texture','texture_atlas',
        'model_3d','material','animation','audio','ui_element','font','particle','map'
    )),
    storage_key TEXT,
    file_format TEXT,
    width INTEGER,
    height INTEGER,
    generation_prompt TEXT,
    generation_model TEXT,
    size_bytes INTEGER DEFAULT 0,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Re-apply the asset_type CHECK constraint so DBs created by an older
-- setup.sql (which omitted 'map', 'texture_atlas', 'font', 'particle')
-- are repaired in place. Safe to run repeatedly.
ALTER TABLE public.assets DROP CONSTRAINT IF EXISTS assets_asset_type_check;
ALTER TABLE public.assets ADD CONSTRAINT assets_asset_type_check CHECK (asset_type IN (
    'sprite','sprite_sheet','texture','texture_atlas',
    'model_3d','material','animation','audio','ui_element','font','particle','map'
));

ALTER TABLE public.assets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can CRUD own assets" ON public.assets FOR ALL
    USING (project_id IN (SELECT id FROM public.projects WHERE owner_id = auth.uid()));

-- ── 5. Agent Logs ──────────────────────────────────────────────
-- Chat history + tool call logs
CREATE TABLE IF NOT EXISTS public.agent_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool_call', 'system')),
    content TEXT DEFAULT '',
    tool_name TEXT,
    tool_input JSONB,
    tool_output JSONB,
    tokens_used INTEGER DEFAULT 0,
    duration_ms INTEGER,
    created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.agent_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own agent logs" ON public.agent_logs FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own agent logs" ON public.agent_logs FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_agent_logs_conversation ON public.agent_logs(conversation_id);
CREATE INDEX IF NOT EXISTS idx_agent_logs_project ON public.agent_logs(project_id);

-- ── 6. Builds ──────────────────────────────────────────────────
-- Build queue for export pipeline
CREATE TABLE IF NOT EXISTS public.builds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    platform TEXT NOT NULL CHECK (platform IN ('web', 'windows', 'linux', 'macos', 'android', 'ios')),
    status TEXT DEFAULT 'queued' CHECK (status IN ('queued', 'building', 'completed', 'failed')),
    log TEXT DEFAULT '',
    artifact_url TEXT,
    size_bytes INTEGER,
    created_at TIMESTAMPTZ DEFAULT now(),
    completed_at TIMESTAMPTZ
);

ALTER TABLE public.builds ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can CRUD own builds" ON public.builds FOR ALL
    USING (project_id IN (SELECT id FROM public.projects WHERE owner_id = auth.uid()));

-- ── 7. RPC: Decrement Credits ──────────────────────────────────
-- Called by the agent API after each interaction
CREATE OR REPLACE FUNCTION public.decrement_credits(uid UUID, amount INTEGER)
RETURNS void AS $$
BEGIN
    UPDATE public.profiles
    SET ai_credits_remaining = GREATEST(0, ai_credits_remaining - amount),
        updated_at = now()
    WHERE id = uid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── 8. Storage Bucket ──────────────────────────────────────────
-- Run this separately if not auto-created:
-- Go to Supabase Dashboard → Storage → Create bucket "assets" (public: false)

-- ── 9. Realtime ────────────────────────────────────────────────
-- Enable realtime for live collaboration (optional)
ALTER PUBLICATION supabase_realtime ADD TABLE public.project_files;
ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_logs;

-- ============================================================
-- DONE! Your Axiom database is ready.
-- 
-- Next steps:
-- 1. Set env vars in .env.local:
--    NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
--    NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
--    ANTHROPIC_API_KEY=sk-ant-...
--    OPENAI_API_KEY=sk-... (optional, for sprite generation)
--    MESHY_API_KEY=... (optional, for 3D model generation)
--
-- 2. Run: npm run dev
-- 3. Register a user, create a project, start chatting!
-- ============================================================
