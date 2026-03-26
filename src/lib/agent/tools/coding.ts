/**
 * Coding Tools — OpenCode-faithful file operations.
 *
 * Key OpenCode patterns ported:
 * - read_file with line numbers, offset/limit, truncation
 * - edit_file with fuzzy matching chain (9 replacers from OpenCode)
 * - write_file creates or overwrites
 * - list_files / search_files / delete_file
 * - read_project_state for full context
 */

import { getAdminClient as getAdmin } from '@/lib/supabase/admin';
import type { ToolResult } from '@/types/agent';
import { registerTool, type ToolContext, type ToolInput } from './registry';

// ── Helpers ─────────────────────────────────────────────────────────

async function getFileContent(projectId: string, path: string): Promise<string | null> {
    const { data } = await getAdmin()
        .from('project_files')
        .select('text_content')
        .eq('project_id', projectId)
        .eq('path', path)
        .single();
    return data?.text_content ?? null;
}

async function upsertFile(ctx: ToolContext, path: string, content: string): Promise<void> {
    const sizeBytes = new TextEncoder().encode(content).length;
    ctx.createdFiles.push({ path, content, size_bytes: sizeBytes, content_type: 'text' });
    try {
        const admin = getAdmin();
        admin.from('project_files').upsert({
            project_id: ctx.projectId,
            path,
            content_type: 'text',
            text_content: content,
            size_bytes: sizeBytes,
            updated_at: new Date().toISOString(),
        }, { onConflict: 'project_id,path' }).select('id').then(({ error }) => {
            if (error) console.error(`[axiom] File write failed for ${path}:`, error.message);
        });
    } catch { /* Supabase not configured */ }
}

// ── Edit Replacers (ported from OpenCode) ───────────────────────────
// OpenCode uses a chain of 9 replacers, each progressively more fuzzy.
// If one finds a unique match, it's used. Otherwise, the next is tried.

type Replacer = (content: string, find: string) => Generator<string, void, unknown>;

const SimpleReplacer: Replacer = function* (_content, find) {
    yield find;
};

const LineTrimmedReplacer: Replacer = function* (content, find) {
    const originalLines = content.split('\n');
    const searchLines = find.split('\n');
    if (searchLines[searchLines.length - 1] === '') searchLines.pop();

    for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
        let matches = true;
        for (let j = 0; j < searchLines.length; j++) {
            if (originalLines[i + j].trim() !== searchLines[j].trim()) { matches = false; break; }
        }
        if (matches) {
            let start = 0;
            for (let k = 0; k < i; k++) start += originalLines[k].length + 1;
            let end = start;
            for (let k = 0; k < searchLines.length; k++) {
                end += originalLines[i + k].length;
                if (k < searchLines.length - 1) end += 1;
            }
            yield content.substring(start, end);
        }
    }
};

function levenshtein(a: string, b: string): number {
    if (a === '' || b === '') return Math.max(a.length, b.length);
    const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
        Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
    );
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
        }
    }
    return matrix[a.length][b.length];
}

const BlockAnchorReplacer: Replacer = function* (content, find) {
    const originalLines = content.split('\n');
    const searchLines = find.split('\n');
    if (searchLines.length < 3) return;
    if (searchLines[searchLines.length - 1] === '') searchLines.pop();

    const firstLine = searchLines[0].trim();
    const lastLine = searchLines[searchLines.length - 1].trim();

    const candidates: Array<{ startLine: number; endLine: number }> = [];
    for (let i = 0; i < originalLines.length; i++) {
        if (originalLines[i].trim() !== firstLine) continue;
        for (let j = i + 2; j < originalLines.length; j++) {
            if (originalLines[j].trim() === lastLine) { candidates.push({ startLine: i, endLine: j }); break; }
        }
    }
    if (candidates.length === 0) return;

    let best: { startLine: number; endLine: number } | null = null;
    let maxSim = -1;

    for (const c of candidates) {
        const actual = c.endLine - c.startLine + 1;
        let sim = 0;
        const check = Math.min(searchLines.length - 2, actual - 2);
        if (check > 0) {
            for (let j = 1; j < searchLines.length - 1 && j < actual - 1; j++) {
                const a = originalLines[c.startLine + j].trim();
                const b = searchLines[j].trim();
                const max = Math.max(a.length, b.length);
                if (max === 0) continue;
                sim += (1 - levenshtein(a, b) / max) / check;
            }
        } else { sim = 1.0; }
        if (sim > maxSim) { maxSim = sim; best = c; }
    }

    const threshold = candidates.length === 1 ? 0.0 : 0.3;
    if (maxSim >= threshold && best) {
        let start = 0;
        for (let k = 0; k < best.startLine; k++) start += originalLines[k].length + 1;
        let end = start;
        for (let k = best.startLine; k <= best.endLine; k++) {
            end += originalLines[k].length;
            if (k < best.endLine) end += 1;
        }
        yield content.substring(start, end);
    }
};

const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
    const normalize = (t: string) => t.replace(/\s+/g, ' ').trim();
    const normalizedFind = normalize(find);
    const lines = content.split('\n');
    for (const line of lines) {
        if (normalize(line) === normalizedFind) yield line;
    }
    const findLines = find.split('\n');
    if (findLines.length > 1) {
        for (let i = 0; i <= lines.length - findLines.length; i++) {
            const block = lines.slice(i, i + findLines.length);
            if (normalize(block.join('\n')) === normalizedFind) yield block.join('\n');
        }
    }
};

const IndentationFlexibleReplacer: Replacer = function* (content, find) {
    const removeIndent = (text: string) => {
        const ls = text.split('\n');
        const nonEmpty = ls.filter(l => l.trim().length > 0);
        if (nonEmpty.length === 0) return text;
        const min = Math.min(...nonEmpty.map(l => { const m = l.match(/^(\s*)/); return m ? m[1].length : 0; }));
        return ls.map(l => l.trim().length === 0 ? l : l.slice(min)).join('\n');
    };
    const normalizedFind = removeIndent(find);
    const contentLines = content.split('\n');
    const findLines = find.split('\n');
    for (let i = 0; i <= contentLines.length - findLines.length; i++) {
        const block = contentLines.slice(i, i + findLines.length).join('\n');
        if (removeIndent(block) === normalizedFind) yield block;
    }
};

const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
    const trimmed = find.trim();
    if (trimmed === find) return;
    if (content.includes(trimmed)) yield trimmed;
    const lines = content.split('\n');
    const findLines = find.split('\n');
    for (let i = 0; i <= lines.length - findLines.length; i++) {
        const block = lines.slice(i, i + findLines.length).join('\n');
        if (block.trim() === trimmed) yield block;
    }
};

/** OpenCode's replace() — tries replacers in order until one works */
function replaceWithChain(content: string, oldString: string, newString: string, replaceAll = false): string {
    if (oldString === newString) throw new Error('No changes: oldString and newString are identical.');

    const replacers: Replacer[] = [
        SimpleReplacer,
        LineTrimmedReplacer,
        BlockAnchorReplacer,
        WhitespaceNormalizedReplacer,
        IndentationFlexibleReplacer,
        TrimmedBoundaryReplacer,
    ];

    let notFound = true;
    for (const replacer of replacers) {
        for (const search of replacer(content, oldString)) {
            const index = content.indexOf(search);
            if (index === -1) continue;
            notFound = false;
            if (replaceAll) return content.replaceAll(search, newString);
            const lastIndex = content.lastIndexOf(search);
            if (index !== lastIndex) continue; // multiple matches, try next replacer
            return content.substring(0, index) + newString + content.substring(index + search.length);
        }
    }

    if (notFound) {
        throw new Error('Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.');
    }
    throw new Error('Found multiple matches for oldString. Provide more surrounding context to make the match unique.');
}

// ── read_file ───────────────────────────────────────────────────────

registerTool({
    name: 'read_file',
    description: 'Read the contents of a project file. Returns content with line numbers. Use offset/limit for large files.',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Path to the file, e.g. scripts/player.axs' },
            offset: { type: 'integer', description: 'Line number to start reading from (1-based). Optional.' },
            limit: { type: 'integer', description: 'Maximum lines to read. Defaults to 2000.' },
        },
        required: ['path'],
    },
    access: ['build', 'plan', 'explore'],
    execute: async (ctx, input) => {
        const start = Date.now();
        const filePath = input.path as string;
        const offset = (input.offset as number) || 1;
        const limit = (input.limit as number) || 2000;

        const content = await getFileContent(ctx.projectId, filePath);
        if (content === null) {
            // OpenCode suggests similar files when not found
            const { data: allFiles } = await getAdmin()
                .from('project_files')
                .select('path')
                .eq('project_id', ctx.projectId);
            const suggestions = (allFiles ?? [])
                .filter(f => f.path.toLowerCase().includes(filePath.toLowerCase().split('/').pop() ?? ''))
                .slice(0, 3)
                .map(f => f.path);
            const hint = suggestions.length > 0 ? `\nDid you mean: ${suggestions.join(', ')}?` : '';
            return {
                callId: '', success: false, output: {},
                filesModified: [],
                error: `File not found: ${filePath}${hint}`,
                duration_ms: Date.now() - start,
            };
        }

        const allLines = content.split('\n');
        const totalLines = allLines.length;
        const startIdx = Math.max(0, offset - 1);
        const sliced = allLines.slice(startIdx, startIdx + limit);
        const truncated = startIdx + sliced.length < totalLines;

        // Line numbers like OpenCode: "lineNo: content"
        const numbered = sliced.map((l, i) => `${startIdx + i + 1}: ${l}`).join('\n');
        let output = numbered;
        if (truncated) {
            output += `\n\n(Showing lines ${offset}-${startIdx + sliced.length} of ${totalLines}. Use offset=${startIdx + sliced.length + 1} to continue.)`;
        } else {
            output += `\n\n(End of file - total ${totalLines} lines)`;
        }

        return {
            callId: '', success: true,
            output: { content: output, path: filePath, totalLines, linesReturned: sliced.length, truncated },
            filesModified: [],
            duration_ms: Date.now() - start,
        };
    },
});

// ── edit_file (with OpenCode fuzzy matching chain) ──────────────────

registerTool({
    name: 'edit_file',
    description: `Edit a project file using exact string replacement. The old_string must uniquely identify the text to replace.

IMPORTANT:
- You must read the file first before editing
- old_string must match exactly (the system will try fuzzy matching as fallback)
- For creating new files, use write_file instead
- For small changes, prefer this over write_file`,
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Path to the file to edit' },
            old_string: { type: 'string', description: 'The exact string to find and replace. Must be unique in the file.' },
            new_string: { type: 'string', description: 'The replacement string' },
            replace_all: { type: 'boolean', description: 'Replace all occurrences (default false)' },
        },
        required: ['path', 'old_string', 'new_string'],
    },
    access: ['build'],
    execute: async (ctx, input) => {
        const start = Date.now();
        const filePath = input.path as string;
        const oldStr = input.old_string as string;
        const newStr = input.new_string as string;
        const replaceAll = (input.replace_all as boolean) || false;

        // Creating new file via empty old_string (OpenCode pattern)
        if (oldStr === '') {
            await upsertFile(ctx, filePath, newStr);
            return {
                callId: '', success: true,
                output: { message: `Created ${filePath}`, path: filePath },
                filesModified: [filePath],
                duration_ms: Date.now() - start,
            };
        }

        const content = await getFileContent(ctx.projectId, filePath);
        if (content === null) {
            return {
                callId: '', success: false, output: {},
                filesModified: [],
                error: `File not found: ${filePath}`,
                duration_ms: Date.now() - start,
            };
        }

        try {
            const newContent = replaceWithChain(content, oldStr, newStr, replaceAll);
            await upsertFile(ctx, filePath, newContent);
            return {
                callId: '', success: true,
                output: { message: `Edit applied to ${filePath}`, path: filePath },
                filesModified: [filePath],
                duration_ms: Date.now() - start,
            };
        } catch (err) {
            return {
                callId: '', success: false,
                output: { hint: 'Use read_file to check the current content, then retry with the exact text.' },
                filesModified: [],
                error: err instanceof Error ? err.message : 'Edit failed',
                duration_ms: Date.now() - start,
            };
        }
    },
});

// ── write_file ──────────────────────────────────────────────────────

registerTool({
    name: 'write_file',
    description: 'Create a new file or completely overwrite an existing file. For small edits on existing files, prefer edit_file instead.',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Path for the file, e.g. scripts/enemy.axs' },
            content: { type: 'string', description: 'Full content of the file' },
        },
        required: ['path', 'content'],
    },
    access: ['build'],
    execute: async (ctx, input) => {
        const start = Date.now();
        const filePath = input.path as string;
        const content = input.content as string;
        await upsertFile(ctx, filePath, content);
        return {
            callId: '', success: true,
            output: { message: `Wrote ${filePath}`, path: filePath, lines: content.split('\n').length, bytes: new TextEncoder().encode(content).length },
            filesModified: [filePath],
            duration_ms: Date.now() - start,
        };
    },
});

// ── list_files ──────────────────────────────────────────────────────

registerTool({
    name: 'list_files',
    description: 'List all project files, optionally filtered by a glob-like pattern.',
    parameters: {
        type: 'object',
        properties: {
            pattern: { type: 'string', description: 'Optional filter pattern. Prefix match e.g. "scripts/", suffix match e.g. "*.axs".' },
        },
        required: [],
    },
    access: ['build', 'plan', 'explore'],
    execute: async (ctx, input) => {
        const start = Date.now();
        const pattern = (input.pattern as string) || '';
        const { data: files, error } = await getAdmin()
            .from('project_files')
            .select('path, content_type, size_bytes, updated_at')
            .eq('project_id', ctx.projectId)
            .order('path');
        if (error) return { callId: '', success: false, output: {}, filesModified: [], error: error.message, duration_ms: Date.now() - start };

        let filtered = files ?? [];
        if (pattern) {
            if (pattern.startsWith('*')) {
                const ext = pattern.slice(1);
                filtered = filtered.filter(f => f.path.endsWith(ext));
            } else if (pattern.endsWith('*')) {
                const prefix = pattern.slice(0, -1);
                filtered = filtered.filter(f => f.path.startsWith(prefix));
            } else {
                filtered = filtered.filter(f => f.path.startsWith(pattern) || f.path.includes(pattern));
            }
        }
        const fileList = filtered.map(f => `${f.path} (${f.content_type}, ${f.size_bytes ?? 0}B)`);
        return {
            callId: '', success: true,
            output: { files: fileList, count: fileList.length },
            filesModified: [],
            duration_ms: Date.now() - start,
        };
    },
});

// ── search_files ────────────────────────────────────────────────────

registerTool({
    name: 'search_files',
    description: 'Search across all project files for a text pattern (regex supported). Returns matching lines with file paths and line numbers.',
    parameters: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Search pattern (regex supported)' },
            file_pattern: { type: 'string', description: 'Optional: only search files matching this pattern' },
            max_results: { type: 'integer', description: 'Maximum matches to return', default: 20 },
        },
        required: ['query'],
    },
    access: ['build', 'plan', 'explore'],
    execute: async (ctx, input) => {
        const start = Date.now();
        const query = input.query as string;
        const filePattern = (input.file_pattern as string) || '';
        const maxResults = (input.max_results as number) || 20;
        const { data: files } = await getAdmin()
            .from('project_files')
            .select('path, text_content')
            .eq('project_id', ctx.projectId)
            .eq('content_type', 'text')
            .order('path');
        if (!files) return { callId: '', success: true, output: { matches: [], count: 0 }, filesModified: [], duration_ms: Date.now() - start };

        let regex: RegExp;
        try { regex = new RegExp(query, 'gi'); } catch { regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'); }

        const matches: Array<{ file: string; line: number; text: string }> = [];
        for (const file of files) {
            if (filePattern) {
                if (filePattern.startsWith('*') && !file.path.endsWith(filePattern.slice(1))) continue;
                if (!filePattern.startsWith('*') && !file.path.includes(filePattern)) continue;
            }
            if (!file.text_content) continue;
            const lines = file.text_content.split('\n');
            for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
                if (regex.test(lines[i])) { matches.push({ file: file.path, line: i + 1, text: lines[i].trim() }); }
                regex.lastIndex = 0;
            }
            if (matches.length >= maxResults) break;
        }
        return { callId: '', success: true, output: { matches, count: matches.length, query }, filesModified: [], duration_ms: Date.now() - start };
    },
});

// ── delete_file ─────────────────────────────────────────────────────

registerTool({
    name: 'delete_file',
    description: 'Delete a project file.',
    parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path to the file to delete' } },
        required: ['path'],
    },
    access: ['build'],
    execute: async (ctx, input) => {
        const start = Date.now();
        const filePath = input.path as string;
        const { error } = await getAdmin()
            .from('project_files')
            .delete()
            .eq('project_id', ctx.projectId)
            .eq('path', filePath);
        if (error) return { callId: '', success: false, output: {}, filesModified: [], error: error.message, duration_ms: Date.now() - start };
        return { callId: '', success: true, output: { message: `Deleted ${filePath}`, path: filePath }, filesModified: [filePath], duration_ms: Date.now() - start };
    },
});
