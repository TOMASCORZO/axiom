-- ============================================================
-- Axiom Engine — Supabase Setup Script
-- Single source of truth for the schema. Safe to re-run at any time:
-- every statement is idempotent (IF NOT EXISTS / CREATE OR REPLACE /
-- DROP+CREATE for constraints and policies).
-- Apply in Supabase SQL Editor (supabase.com → SQL Editor).
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
DROP POLICY IF EXISTS "Users can read own profile" ON public.profiles;
CREATE POLICY "Users can read own profile" ON public.profiles FOR SELECT USING (auth.uid() = id);
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
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
DROP POLICY IF EXISTS "Users can CRUD own projects" ON public.projects;
CREATE POLICY "Users can CRUD own projects" ON public.projects FOR ALL USING (auth.uid() = owner_id);
DROP POLICY IF EXISTS "Public projects are readable" ON public.projects;
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
DROP POLICY IF EXISTS "Users can CRUD own project files" ON public.project_files;
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
    thumbnail_key TEXT,
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

-- DBs provisioned via an earlier setup.sql may be missing thumbnail_key.
ALTER TABLE public.assets ADD COLUMN IF NOT EXISTS thumbnail_key TEXT;

ALTER TABLE public.assets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can CRUD own assets" ON public.assets;
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
DROP POLICY IF EXISTS "Users can read own agent logs" ON public.agent_logs;
CREATE POLICY "Users can read own agent logs" ON public.agent_logs FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can insert own agent logs" ON public.agent_logs;
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
DROP POLICY IF EXISTS "Users can CRUD own builds" ON public.builds;
CREATE POLICY "Users can CRUD own builds" ON public.builds FOR ALL
    USING (project_id IN (SELECT id FROM public.projects WHERE owner_id = auth.uid()));

-- ── 7. Map Jobs ────────────────────────────────────────────────
-- Async queue for long-running map generation. /start inserts a row,
-- /run fills in result + flips status, client polls /status.
CREATE TABLE IF NOT EXISTS public.map_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','running','done','failed')),
    params JSONB NOT NULL,
    result JSONB,
    error TEXT,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_map_jobs_project ON public.map_jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_map_jobs_user_status ON public.map_jobs(user_id, status);

ALTER TABLE public.map_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Project owner access" ON public.map_jobs;
CREATE POLICY "Project owner access" ON public.map_jobs FOR ALL
    USING (project_id IN (SELECT id FROM public.projects WHERE owner_id = auth.uid()));

-- ── 8. RPC: Decrement Credits ──────────────────────────────────
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

-- ── 9. Storage Bucket ──────────────────────────────────────────
-- Run this separately if not auto-created:
-- Go to Supabase Dashboard → Storage → Create bucket "assets" (public: false)

-- ── 10. Realtime ───────────────────────────────────────────────
-- Enable realtime for live collaboration (optional). Guarded so re-runs
-- don't fail when the tables are already in the publication.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'project_files'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.project_files;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'agent_logs'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_logs;
    END IF;
END $$;

-- ── 11. Database Studio: Schema-per-Game ───────────────────────
-- Each project gets a dedicated Postgres schema (game_<project_id>) where
-- the user — via the agent or the SQL Console — defines their game's tables.
-- All execution is funnelled through SECURITY DEFINER RPCs so the API never
-- runs raw SQL with the service role: each RPC pins search_path to the project
-- schema, sets a 5s statement timeout, and writes an audit row.
--
-- Portability: no Supabase-specific features; replays cleanly on vanilla PG.

-- Source of truth for migrations applied to each game schema. Replaying these
-- rows on a fresh Postgres reconstructs the user's database exactly.
CREATE TABLE IF NOT EXISTS public.game_schemas (
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    version INT NOT NULL,
    sql_up TEXT NOT NULL,
    description TEXT,
    applied_by UUID,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, version)
);

-- Audit log: every statement executed against a game schema (UI, agent, rows
-- endpoint). Single chokepoint for debugging + abuse detection.
CREATE TABLE IF NOT EXISTS public.database_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    user_id UUID,
    tool_name TEXT,
    statement TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('query','exec','ddl','error')),
    success BOOLEAN NOT NULL,
    row_count INT,
    duration_ms INT,
    error TEXT,
    executed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_database_audit_project
    ON public.database_audit(project_id, executed_at DESC);

ALTER TABLE public.game_schemas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.database_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Project owner access" ON public.game_schemas;
CREATE POLICY "Project owner access" ON public.game_schemas FOR ALL
    USING (project_id IN (SELECT id FROM public.projects WHERE owner_id = auth.uid()));

DROP POLICY IF EXISTS "Project owner access" ON public.database_audit;
CREATE POLICY "Project owner access" ON public.database_audit FOR ALL
    USING (project_id IN (SELECT id FROM public.projects WHERE owner_id = auth.uid()));

-- Deterministic schema name. Postgres identifiers can't contain hyphens
-- unquoted, so we strip them. Result is always 'game_<32 hex chars>'.
CREATE OR REPLACE FUNCTION public.axiom_game_schema(p_project_id UUID)
RETURNS TEXT
LANGUAGE SQL IMMUTABLE
AS $func$
    SELECT 'game_' || replace(p_project_id::text, '-', '_')
$func$;

-- Lazily provision the project schema. Every executor calls this so the agent
-- never needs a separate "init" step before its first CREATE TABLE.
CREATE OR REPLACE FUNCTION public.axiom_ensure_game_schema(p_project_id UUID)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
    v_schema TEXT := public.axiom_game_schema(p_project_id);
BEGIN
    EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I', v_schema);
    RETURN v_schema;
END;
$func$;

-- ── 12. Database Studio: Executors ─────────────────────────────
-- Two RPCs because Postgres can't know in advance whether arbitrary text is a
-- SELECT (returns rows) vs DDL/DML (returns row count). The API parses the
-- SQL with pgsql-ast-parser and routes to the correct one.
--
-- Both functions:
--   * Pin search_path to the project schema (no leakage to public/auth/etc.)
--   * Apply a 5s statement timeout
--   * Write an audit row in every code path (success and error)
--   * Are SECURITY DEFINER so they run elevated. The validator at
--     src/lib/game-db/validator.ts is what keeps this safe.

-- Run a SELECT (or any rows-returning statement) and return rows as JSONB.
-- FOR-RECORD-IN-EXECUTE is the only pattern that's robust against PL/pgSQL's
-- plan-cache quirks for dynamic SQL inside SECURITY DEFINER + dynamic
-- search_path. No temp tables, no EXECUTE … INTO scalar.
CREATE OR REPLACE FUNCTION public.axiom_query_in_game(
    p_project_id UUID,
    p_user_id UUID,
    p_tool_name TEXT,
    p_sql TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
    v_schema   TEXT := public.axiom_game_schema(p_project_id);
    v_start    TIMESTAMPTZ := clock_timestamp();
    v_arr      JSONB := '[]'::jsonb;
    v_row      RECORD;
    v_count    INT := 0;
    v_duration INT;
BEGIN
    PERFORM public.axiom_ensure_game_schema(p_project_id);

    EXECUTE 'SET LOCAL statement_timeout = ''5s''';
    EXECUTE format('SET LOCAL search_path = %I, public, pg_temp', v_schema);

    FOR v_row IN EXECUTE p_sql LOOP
        v_arr := v_arr || jsonb_build_array(to_jsonb(v_row));
        v_count := v_count + 1;
    END LOOP;

    v_duration := extract(milliseconds FROM clock_timestamp() - v_start)::int;

    INSERT INTO public.database_audit
        (project_id, user_id, tool_name, statement, kind, success, row_count, duration_ms)
    VALUES
        (p_project_id, p_user_id, p_tool_name, p_sql, 'query', true, v_count, v_duration);

    RETURN jsonb_build_object(
        'kind', 'query',
        'rows', v_arr,
        'row_count', v_count,
        'duration_ms', v_duration
    );
EXCEPTION WHEN OTHERS THEN
    v_duration := extract(milliseconds FROM clock_timestamp() - v_start)::int;
    INSERT INTO public.database_audit
        (project_id, user_id, tool_name, statement, kind, success, duration_ms, error)
    VALUES
        (p_project_id, p_user_id, p_tool_name, p_sql, 'error', false, v_duration, SQLERRM);
    RAISE;
END;
$func$;

-- Run a non-rows statement (CREATE TABLE, INSERT/UPDATE/DELETE without
-- RETURNING, etc.) and return the affected row count.
CREATE OR REPLACE FUNCTION public.axiom_exec_in_game(
    p_project_id UUID,
    p_user_id UUID,
    p_tool_name TEXT,
    p_sql TEXT,
    p_kind TEXT DEFAULT 'exec'
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
    v_schema   TEXT := public.axiom_game_schema(p_project_id);
    v_start    TIMESTAMPTZ := clock_timestamp();
    v_count    INT;
    v_duration INT;
BEGIN
    PERFORM public.axiom_ensure_game_schema(p_project_id);

    EXECUTE 'SET LOCAL statement_timeout = ''5s''';
    EXECUTE format('SET LOCAL search_path = %I, public, pg_temp', v_schema);

    EXECUTE p_sql;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_duration := extract(milliseconds FROM clock_timestamp() - v_start)::int;

    INSERT INTO public.database_audit
        (project_id, user_id, tool_name, statement, kind, success, row_count, duration_ms)
    VALUES
        (p_project_id, p_user_id, p_tool_name, p_sql, p_kind, true, v_count, v_duration);

    RETURN jsonb_build_object(
        'kind', p_kind,
        'row_count', v_count,
        'duration_ms', v_duration
    );
EXCEPTION WHEN OTHERS THEN
    v_duration := extract(milliseconds FROM clock_timestamp() - v_start)::int;
    INSERT INTO public.database_audit
        (project_id, user_id, tool_name, statement, kind, success, duration_ms, error)
    VALUES
        (p_project_id, p_user_id, p_tool_name, p_sql, 'error', false, v_duration, SQLERRM);
    RAISE;
END;
$func$;

-- ── 13. Database Studio: Introspection + Grants ────────────────

-- List tables in the game schema with row counts. Saves the UI from rolling
-- its own information_schema joins on every load.
-- Uses RETURN (subquery) — no SELECT INTO, which has shown plan-cache issues
-- under SECURITY DEFINER + dynamic search_path on this PG instance.
CREATE OR REPLACE FUNCTION public.axiom_list_game_tables(p_project_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
    v_schema TEXT := public.axiom_game_schema(p_project_id);
BEGIN
    PERFORM public.axiom_ensure_game_schema(p_project_id);
    RETURN (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
            'name', t.table_name,
            'row_count', (
                SELECT n_live_tup FROM pg_stat_user_tables
                WHERE schemaname = v_schema AND relname = t.table_name
            )
        )), '[]'::jsonb)
        FROM information_schema.tables t
        WHERE t.table_schema = v_schema AND t.table_type = 'BASE TABLE'
    );
END;
$func$;

-- Describe a single table: columns, types, nullability, defaults, primary key.
CREATE OR REPLACE FUNCTION public.axiom_describe_game_table(
    p_project_id UUID,
    p_table_name TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
    v_schema TEXT := public.axiom_game_schema(p_project_id);
BEGIN
    PERFORM public.axiom_ensure_game_schema(p_project_id);
    RETURN jsonb_build_object(
        'columns', (
            SELECT coalesce(jsonb_agg(jsonb_build_object(
                'name', column_name,
                'type', data_type,
                'nullable', is_nullable = 'YES',
                'default', column_default
            ) ORDER BY ordinal_position), '[]'::jsonb)
            FROM information_schema.columns
            WHERE table_schema = v_schema AND table_name = p_table_name
        ),
        'primary_key', (
            SELECT coalesce(jsonb_agg(kcu.column_name), '[]'::jsonb)
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
                ON tc.constraint_name = kcu.constraint_name
               AND tc.table_schema = kcu.table_schema
            WHERE tc.table_schema = v_schema
              AND tc.table_name = p_table_name
              AND tc.constraint_type = 'PRIMARY KEY'
        )
    );
END;
$func$;

-- Drop the entire game schema and recreate it empty. Wipes every table, row,
-- index, and migration row in one transaction. Used by the Studio "Reset
-- database" button and by destructive agent flows. Audited as a 'ddl' op.
CREATE OR REPLACE FUNCTION public.axiom_drop_game_schema(
    p_project_id UUID,
    p_user_id UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
    v_schema TEXT := public.axiom_game_schema(p_project_id);
    v_start  TIMESTAMPTZ := clock_timestamp();
BEGIN
    EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', v_schema);
    EXECUTE format('CREATE SCHEMA %I', v_schema);

    -- Wipe migration history too — the schema is genuinely empty now, so
    -- pretending the old migrations still apply would lie to the version log.
    DELETE FROM public.game_schemas WHERE project_id = p_project_id;

    INSERT INTO public.database_audit
        (project_id, user_id, tool_name, statement, kind, success, row_count, duration_ms)
    VALUES
        (p_project_id, p_user_id, 'reset_schema',
         format('DROP SCHEMA %I CASCADE; CREATE SCHEMA %I;', v_schema, v_schema),
         'ddl', true, 0,
         extract(milliseconds FROM clock_timestamp() - v_start)::int);

    RETURN jsonb_build_object('schema', v_schema, 'reset', true);
END;
$func$;

-- Append a new migration row. version auto-increments per project starting at
-- 1. The Studio calls this from the SQL Console after a successful DDL run so
-- the user has a replayable history. Returns the new version number.
CREATE OR REPLACE FUNCTION public.axiom_record_migration(
    p_project_id UUID,
    p_user_id    UUID,
    p_sql        TEXT,
    p_description TEXT DEFAULT NULL
) RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
    v_next INT;
BEGIN
    SELECT coalesce(max(version), 0) + 1 INTO v_next
    FROM public.game_schemas
    WHERE project_id = p_project_id;

    INSERT INTO public.game_schemas (project_id, version, sql_up, description, applied_by)
    VALUES (p_project_id, v_next, p_sql, p_description, p_user_id);

    RETURN v_next;
END;
$func$;

-- Only the service role (used by the Axiom API) can call these RPCs. Anonymous
-- and authenticated PostgREST roles must NOT touch them — players talk to
-- Axiom's HTTP layer, never directly to PostgREST against game schemas.
REVOKE ALL ON FUNCTION public.axiom_ensure_game_schema(UUID)              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.axiom_query_in_game(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.axiom_exec_in_game(UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.axiom_list_game_tables(UUID)                FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.axiom_describe_game_table(UUID, TEXT)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.axiom_drop_game_schema(UUID, UUID)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.axiom_record_migration(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.axiom_ensure_game_schema(UUID)              TO service_role;
GRANT EXECUTE ON FUNCTION public.axiom_query_in_game(UUID, UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.axiom_exec_in_game(UUID, UUID, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.axiom_list_game_tables(UUID)                TO service_role;
GRANT EXECUTE ON FUNCTION public.axiom_describe_game_table(UUID, TEXT)       TO service_role;
GRANT EXECUTE ON FUNCTION public.axiom_drop_game_schema(UUID, UUID)          TO service_role;
GRANT EXECUTE ON FUNCTION public.axiom_record_migration(UUID, UUID, TEXT, TEXT) TO service_role;

-- ── 14. Runtime: Game Players (Phase 2) ────────────────────────
-- One row per (game, player). The same OAuth identity gets a *different*
-- player_id in each game so player data stays scoped per project — devs
-- can't trivially correlate users across games. Anonymous players have
-- provider='anonymous' and provider_user_id = player_id::text.
CREATE TABLE IF NOT EXISTS public.game_players (
    player_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    game_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('anonymous', 'google', 'discord', 'github')),
    provider_user_id TEXT NOT NULL,
    email TEXT,
    display_name TEXT,
    avatar_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (game_id, provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS idx_game_players_game ON public.game_players(game_id);
CREATE INDEX IF NOT EXISTS idx_game_players_lookup ON public.game_players(game_id, provider, provider_user_id);

ALTER TABLE public.game_players ENABLE ROW LEVEL SECURITY;

-- Project owner can see all players in their game (for moderation / analytics).
DROP POLICY IF EXISTS "Project owner reads players" ON public.game_players;
CREATE POLICY "Project owner reads players" ON public.game_players FOR SELECT
    USING (game_id IN (SELECT id FROM public.projects WHERE owner_id = auth.uid()));

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
