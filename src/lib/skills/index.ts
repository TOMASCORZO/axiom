/**
 * Skills System — Markdown-based instruction injection for Axiom.
 *
 * OpenCode pattern: Scan project and user directories for Markdown files
 * that teach the agent how to behave in specific contexts. Skills are
 * automatically detected and injected into the system prompt.
 *
 * Scan directories (in order):
 * 1. Project-local: .axiom/skills/
 * 2. User-global:   ~/.axiom/skills/
 * 3. Agents dir:    .agents/  or  _agents/
 *
 * Each skill file is a Markdown file with optional YAML frontmatter:
 * ---
 * name: React 19 Patterns
 * description: Always use React 19 conventions
 * globs: ["*.tsx", "*.jsx"]          # Only activate for matching files
 * alwaysApply: false                 # If true, always inject
 * ---
 * [Markdown instruction content]
 *
 * Usage:
 *   import { SkillsManager } from '@/lib/skills';
 *
 *   const mgr = new SkillsManager('/path/to/project');
 *   const skills = mgr.getActiveSkills();
 *   const injection = mgr.buildPromptInjection();
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join, extname, basename } from 'path';
import { homedir } from 'os';

// ── Types ───────────────────────────────────────────────────────────

export interface Skill {
    /** Unique identifier (derived from filename) */
    id: string;
    /** Display name */
    name: string;
    /** Short description */
    description: string;
    /** File patterns that activate this skill (glob-like) */
    globs: string[];
    /** If true, always include in system prompt */
    alwaysApply: boolean;
    /** The Markdown content (instructions for the agent) */
    content: string;
    /** Source file path */
    source: string;
}

// ── Configuration ───────────────────────────────────────────────────

const SKILL_DIRS = [
    '.axiom/skills',
    '.agents/skills',
    '.agents',
    '_agents',
];

const GLOBAL_SKILLS_DIR = join(homedir(), '.axiom', 'skills');

// ── Skills Manager ──────────────────────────────────────────────────

export class SkillsManager {
    private skills: Skill[] = [];
    private projectRoot: string;
    private loaded = false;

    constructor(projectRoot: string) {
        this.projectRoot = projectRoot;
    }

    /**
     * Scan all directories and load skills.
     */
    load(): Skill[] {
        this.skills = [];

        // Scan project-local directories
        for (const dir of SKILL_DIRS) {
            const fullPath = join(this.projectRoot, dir);
            this.scanDirectory(fullPath);
        }

        // Scan global user directory
        this.scanDirectory(GLOBAL_SKILLS_DIR);

        this.loaded = true;
        return this.skills;
    }

    /**
     * Get all loaded skills.
     */
    getAll(): Skill[] {
        if (!this.loaded) this.load();
        return this.skills;
    }

    /**
     * Get skills that should be active for the given file context.
     * Returns alwaysApply skills + skills whose globs match.
     */
    getActiveSkills(activeFiles?: string[]): Skill[] {
        if (!this.loaded) this.load();

        return this.skills.filter(skill => {
            if (skill.alwaysApply) return true;
            if (!activeFiles || activeFiles.length === 0) return skill.globs.length === 0;
            return skill.globs.some(glob => activeFiles.some(f => matchGlob(f, glob)));
        });
    }

    /**
     * Build the prompt injection string from active skills.
     * This gets appended to the system prompt.
     */
    buildPromptInjection(activeFiles?: string[]): string {
        const active = this.getActiveSkills(activeFiles);

        if (active.length === 0) return '';

        const sections = active.map(skill => {
            return `### Skill: ${skill.name}\n${skill.content}`;
        });

        return `\n## Active Skills\nThe following skills provide additional context and instructions:\n\n${sections.join('\n\n---\n\n')}`;
    }

    // ── Internal ────────────────────────────────────────────────────

    private scanDirectory(dir: string): void {
        if (!existsSync(dir) || !statSync(dir).isDirectory()) return;

        try {
            const files = readdirSync(dir)
                .filter(f => extname(f) === '.md')
                .filter(f => !f.startsWith('_') && !f.startsWith('.'));

            for (const file of files) {
                const filePath = join(dir, file);
                const skill = this.parseSkillFile(filePath);
                if (skill) {
                    // Deduplicate by ID
                    const existing = this.skills.findIndex(s => s.id === skill.id);
                    if (existing >= 0) {
                        this.skills[existing] = skill; // Later sources override
                    } else {
                        this.skills.push(skill);
                    }
                }
            }
        } catch {
            // Directory read failed
        }
    }

    private parseSkillFile(filePath: string): Skill | null {
        try {
            const raw = readFileSync(filePath, 'utf-8');
            const id = basename(filePath, '.md').toLowerCase().replace(/\s+/g, '-');

            // Parse optional YAML frontmatter
            const frontmatterMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

            if (frontmatterMatch) {
                const meta = parseFrontmatter(frontmatterMatch[1]);
                const content = frontmatterMatch[2].trim();

                return {
                    id,
                    name: meta.name ?? id,
                    description: meta.description ?? '',
                    globs: meta.globs ?? [],
                    alwaysApply: meta.alwaysApply === true || meta.alwaysApply === 'true',
                    content,
                    source: filePath,
                };
            }

            // No frontmatter — use entire file as content
            return {
                id,
                name: id,
                description: '',
                globs: [],
                alwaysApply: false,
                content: raw.trim(),
                source: filePath,
            };
        } catch {
            return null;
        }
    }
}

// ── Utilities ───────────────────────────────────────────────────────

/**
 * Simple YAML-like frontmatter parser (no external dependency).
 */
function parseFrontmatter(yaml: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const line of yaml.split('\n')) {
        const match = line.match(/^(\w+):\s*(.*)$/);
        if (!match) continue;

        const [, key, rawValue] = match;
        let value: unknown = rawValue;

        // Parse arrays: ["a", "b"]
        if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
            try {
                value = JSON.parse(rawValue);
            } catch {
                value = rawValue;
            }
        }
        // Parse booleans
        else if (rawValue === 'true') value = true;
        else if (rawValue === 'false') value = false;
        // Parse numbers
        else if (!isNaN(Number(rawValue)) && rawValue !== '') value = Number(rawValue);

        result[key] = value;
    }

    return result;
}

/**
 * Simple glob matcher (supports * and **).
 */
function matchGlob(path: string, glob: string): boolean {
    // Convert glob to regex
    const regex = glob
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '{{DOUBLESTAR}}')
        .replace(/\*/g, '[^/]*')
        .replace(/\{\{DOUBLESTAR\}\}/g, '.*');

    return new RegExp(`(^|/)${regex}$`).test(path);
}
