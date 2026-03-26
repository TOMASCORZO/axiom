/**
 * Advanced Search Tools — ripgrep-style grep and glob.
 *
 * OpenCode tools: grep.ts, glob.ts, codesearch.ts
 * Fast file search using regex patterns and glob matching.
 */

import { registerTool, type ToolContext, type ToolInput } from './registry';
import { getAdminClient as getAdmin } from '@/lib/supabase/admin';

// ── grep: Search file contents with regex ───────────────────────────

registerTool({
    name: 'grep',
    description: 'Search for a pattern across all project files. Returns matching lines with file paths and line numbers. Similar to ripgrep.',
    parameters: {
        pattern: { type: 'string', description: 'Regex pattern to search for', required: true },
        path: { type: 'string', description: 'Optional path prefix to limit search scope' },
        caseSensitive: { type: 'boolean', description: 'Case-sensitive search (default: false)' },
        maxResults: { type: 'number', description: 'Maximum number of results (default: 50)' },
    },
    access: ['build', 'plan', 'explore'],
    async execute(ctx: ToolContext, input: ToolInput) {
        const pattern = input.pattern as string;
        const pathPrefix = input.path as string | undefined;
        const caseSensitive = input.caseSensitive as boolean || false;
        const maxResults = input.maxResults as number || 50;

        const query = getAdmin()
            .from('project_files')
            .select('path, text_content')
            .eq('project_id', ctx.projectId)
            .eq('content_type', 'text');

        if (pathPrefix) {
            query.like('path', `${pathPrefix}%`);
        }

        const { data: files } = await query;

        const flags = caseSensitive ? 'g' : 'gi';
        let regex: RegExp;
        try {
            regex = new RegExp(pattern, flags);
        } catch {
            return { success: false, output: null, error: `Invalid regex: ${pattern}`, duration_ms: 0 };
        }

        const matches: Array<{ file: string; line: number; content: string }> = [];

        for (const file of files ?? []) {
            if (!file.text_content) continue;
            const lines = file.text_content.split('\n');
            for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
                if (regex.test(lines[i])) {
                    matches.push({ file: file.path, line: i + 1, content: lines[i].trim().slice(0, 200) });
                }
                regex.lastIndex = 0; // Reset for global regex
            }
            if (matches.length >= maxResults) break;
        }

        return {
            success: true,
            output: { matches, totalMatches: matches.length, pattern },
            duration_ms: 0,
        };
    },
});

// ── glob: Find files by glob pattern ────────────────────────────────

registerTool({
    name: 'glob',
    description: 'Find files matching a glob pattern (e.g. "**/*.ts", "src/**/*.test.*"). Returns file paths.',
    parameters: {
        pattern: { type: 'string', description: 'Glob pattern to match', required: true },
    },
    access: ['build', 'plan', 'explore'],
    async execute(ctx: ToolContext, input: ToolInput) {
        const pattern = input.pattern as string;

        const { data: files } = await getAdmin()
            .from('project_files')
            .select('path, content_type, size_bytes')
            .eq('project_id', ctx.projectId)
            .order('path');

        // Convert glob to regex
        const regex = globToRegex(pattern);
        const matched = (files ?? []).filter(f => regex.test(f.path));

        return {
            success: true,
            output: {
                files: matched.map(f => ({ path: f.path, type: f.content_type, size: f.size_bytes })),
                count: matched.length,
                pattern,
            },
            duration_ms: 0,
        };
    },
});

// ── codesearch: Semantic code search ────────────────────────────────

registerTool({
    name: 'codesearch',
    description: 'Search for code patterns across the project. Searches function names, class names, imports, and comments. More semantic than raw grep.',
    parameters: {
        query: { type: 'string', description: 'Search query (function name, class, keyword)', required: true },
        fileType: { type: 'string', description: 'File extension filter (e.g. "ts", "gd", "tscn")' },
    },
    access: ['build', 'plan', 'explore'],
    async execute(ctx: ToolContext, input: ToolInput) {
        const query = (input.query as string).toLowerCase();
        const fileType = input.fileType as string | undefined;

        let dbQuery = getAdmin()
            .from('project_files')
            .select('path, text_content, size_bytes')
            .eq('project_id', ctx.projectId)
            .eq('content_type', 'text');

        if (fileType) {
            dbQuery = dbQuery.like('path', `%.${fileType}`);
        }

        const { data: files } = await dbQuery;

        const results: Array<{
            file: string;
            matches: Array<{ line: number; type: string; content: string }>;
            score: number;
        }> = [];

        for (const file of files ?? []) {
            if (!file.text_content) continue;
            const lines = file.text_content.split('\n');
            const fileMatches: Array<{ line: number; type: string; content: string }> = [];

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const lower = line.toLowerCase();
                if (!lower.includes(query)) continue;

                // Classify match type
                let type = 'code';
                if (/^\s*(function|func|def|fn)\s/.test(line)) type = 'function';
                else if (/^\s*(class|struct|enum|interface|type)\s/.test(line)) type = 'class';
                else if (/^\s*(import|from|require|use)\s/.test(line)) type = 'import';
                else if (/^\s*(#|\/\/|\/\*|\*)/.test(line)) type = 'comment';
                else if (/^\s*(export)\s/.test(line)) type = 'export';

                fileMatches.push({ line: i + 1, type, content: line.trim().slice(0, 200) });
            }

            if (fileMatches.length > 0) {
                results.push({
                    file: file.path,
                    matches: fileMatches.slice(0, 10), // Max 10 per file
                    score: fileMatches.length,
                });
            }
        }

        results.sort((a, b) => b.score - a.score);

        return {
            success: true,
            output: { results: results.slice(0, 20), totalFiles: results.length, query },
            duration_ms: 0,
        };
    },
});

// ── Utility ─────────────────────────────────────────────────────────

function globToRegex(glob: string): RegExp {
    const regex = glob
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '{{DOUBLESTAR}}')
        .replace(/\*/g, '[^/]*')
        .replace(/\{\{DOUBLESTAR\}\}/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp(`(^|/)${regex}$`);
}
