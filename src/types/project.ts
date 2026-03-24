export interface Profile {
  id: string;
  display_name: string;
  avatar_url: string | null;
  plan: 'free' | 'pro' | 'team' | 'enterprise';
  ai_credits_remaining: number;
  storage_used_bytes: number;
  storage_limit_bytes: number;
  created_at: string;
  updated_at: string;
}

export interface Project {
  id: string;
  owner_id: string;
  name: string;
  slug: string;
  description: string;
  engine_version: string;
  is_public: boolean;
  forked_from: string | null;
  thumbnail_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectFile {
  id: string;
  project_id: string;
  path: string;
  content_type: 'text' | 'binary';
  text_content: string | null;
  storage_key: string | null;
  size_bytes: number;
  checksum: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectVersion {
  id: string;
  project_id: string;
  version_number: number;
  label: string;
  snapshot_url: string;
  file_manifest: FileManifestEntry[];
  created_by: string | null;
  created_at: string;
}

export interface FileManifestEntry {
  path: string;
  checksum: string;
  size_bytes: number;
}

export interface Collaborator {
  project_id: string;
  user_id: string;
  role: 'viewer' | 'editor' | 'admin';
  created_at: string;
}

export interface EngineConfig {
  project_id: string;
  render_backend: string;
  physics_engine: string;
  target_fps: number;
  window_width: number;
  window_height: number;
  custom_settings: Record<string, unknown>;
  updated_at: string;
}

export interface FileNode {
  path: string;
  name: string;
  type: 'file' | 'directory';
  fileType?: 'scene' | 'script' | 'asset' | 'config' | 'resource';
  size: number;
  children?: FileNode[];
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  template?: string;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  is_public?: boolean;
}
