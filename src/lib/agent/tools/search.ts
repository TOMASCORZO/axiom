/**
 * Advanced Search Tools — GrepTool and GlobTool.
 * Searches project files stored in Supabase.
 */

import { registerTool, type ToolContext, type ToolInput } from './registry';
import { getAdminClient as getAdmin } from '@/lib/supabase/admin';

// ── GlobTool ────────────────────────────────────────────────────────

registerTool({
    name: 'GlobTool',
    isReadOnly: true,
    isConcurrencySafe: true,
    description: "Fast file pattern matching. Supports glob patterns like **/*.js or src/**/*.ts. Returns matching file paths sorted by path.",
    parameters: {
        type: 'object',
        properties: {
            pattern: { type: 'string', description: 'The glob pattern to match files against' },
            path: { type: 'string', description: 'The directory to search in. Optional.' },
        },
        required: ['pattern'],
    },
    access: ['build', 'plan', 'explore'],
    async execute(ctx: ToolContext, input: ToolInput) {
        const pattern = input.pattern as string;
        const pathPrefix = input.path as string | undefined;

        const { data: files } = await getAdmin()
            .from('project_files')
            .select('path, content_type, size_bytes')
            .eq('project_id', ctx.projectId)
            .order('path');

        let matched = files ?? [];
        if (pathPrefix) {
            matched = matched.filter(f => f.path.startsWith(pathPrefix));
        }

        // Convert glob to regex: ** matches any depth, * matches within a segment
        const regexStr = pattern
            .replace(/\./g, '\\.')
            .replace(/\*\*/g, '{{GLOBSTAR}}')
            .replace(/\*/g, '[^/]*')
            .replace(/\?/g, '.')
            .replace(/\{\{GLOBSTAR\}\}/g, '.*');
        const regex = new RegExp('(^|/)' + regexStr + '$');
        matched = matched.filter(f => regex.test(f.path));

        const filenames = matched.map(f => f.path);

        return {
            success: true,
            output: {
                durationMs: 0,
                numFiles: filenames.length,
                filenames,
                truncated: false,
            },
            duration_ms: 0,
        };
    },
});

// ── GrepTool ────────────────────────────────────────────────────────

registerTool({
    name: 'GrepTool',
    isReadOnly: true,
    isConcurrencySafe: true,
    description: "Search file contents with regex. Supports full regex syntax. Filter by file type or glob pattern. Returns matching lines with file paths and line numbers.",
    parameters: {
        type: 'object',
        properties: {
            pattern: { type: 'string', description: 'Regex pattern to search for' },
            include: { type: 'string', description: 'Glob pattern to filter files by (optional)' },
            type: { type: 'string', description: 'File extension filter (e.g. "ts", optional)' },
            path: { type: 'string', description: 'Path prefix to limit search scope (optional)' },
            multiline: { type: 'boolean', description: 'Enable multiline matching (default: false)' },
        },
        required: ['pattern'],
    },
    access: ['build', 'plan', 'explore'],
    async execute(ctx: ToolContext, input: ToolInput) {
        const pattern = input.pattern as string;
        const pathPrefix = input.path as string | undefined;
        const include = input.include as string | undefined;
        const fileType = input.type as string | undefined;
        const multiline = input.multiline as boolean || false;

        let query = getAdmin()
            .from('project_files')
            .select('path, text_content')
            .eq('project_id', ctx.projectId)
            .eq('content_type', 'text');

        if (pathPrefix) {
            query = query.like('path', pathPrefix + '%');
        }
        if (fileType) {
            query = query.like('path', '%.' + fileType);
        }

        const { data: files } = await query;

        let regex: RegExp;
        try {
            regex = new RegExp(pattern, multiline ? 'gm' : 'g');
        } catch {
            return { success: false, output: null, error: 'Invalid regex: ' + pattern, duration_ms: 0 };
        }

        const matches: Array<{ file: string; line: number; content: string }> = [];

        for (const file of files ?? []) {
            if (!file.text_content) continue;

            // Basic glob matching on path for include filter
            if (include) {
                const includeBase = include.replace(/\*/g, '');
                if (includeBase && !file.path.includes(includeBase)) continue;
            }

            if (multiline) {
                const matchArr = [...file.text_content.matchAll(regex)];
                for (const m of matchArr.slice(0, 10)) {
                    matches.push({ file: file.path, line: -1, content: m[0].slice(0, 200) });
                }
            } else {
                const lines = file.text_content.split('\n');
                for (let i = 0; i < lines.length && matches.length < 50; i++) {
                    if (regex.test(lines[i])) {
                        matches.push({ file: file.path, line: i + 1, content: lines[i].trim().slice(0, 200) });
                    }
                    regex.lastIndex = 0;
                }
            }
        }

        return {
            success: true,
            output: { matches, totalMatches: matches.length, pattern },
            duration_ms: 0,
        };
    },
});
