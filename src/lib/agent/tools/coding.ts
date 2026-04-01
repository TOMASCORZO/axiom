/**
 * Coding Tools — File operations mapped to Claude Code's sophisticated tool models.
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
        const { error } = await admin.from('project_files').upsert({
            project_id: ctx.projectId,
            path,
            content_type: 'text',
            text_content: content,
            size_bytes: sizeBytes,
            updated_at: new Date().toISOString(),
        }, { onConflict: 'project_id,path' }).select('id');
        if (error) console.error("[axiom] File write failed for " + path + ":", error.message);
    } catch { /* Supabase not configured */ }
}

// ── Edit Replacers ──────────────────────────────────────────────────

type Replacer = (content: string, find: string) => Generator<string, void, unknown>;

const SimpleReplacer: Replacer = function* (_content, find) { yield find; };

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
            if (index !== lastIndex) continue;
            return content.substring(0, index) + newString + content.substring(index + search.length);
        }
    }

    if (notFound) {
        throw new Error('Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.');
    }
    throw new Error('Found multiple matches for oldString. Provide more surrounding context to make the match unique.');
}

// ── FileReadTool ────────────────────────────────────────────────────

registerTool({
    name: 'FileReadTool',
    description: "Read the contents of a file. Returns contents with line numbers. Use offset/limit for large files.\n\nUsage:\n- ALWAYS pass the absolute or valid relative path.\n- If the file is too large, it will be paginated using offset/limit.",
    isReadOnly: true,
    isConcurrencySafe: true,
    isDestructive: false,
    maxResultSizeChars: Infinity, // Never truncate reads — they self-paginate
    parameters: {
        type: 'object',
        properties: {
            file_path: { type: 'string', description: 'Path to the file to read' },
            offset: { type: 'integer', description: 'Line number to start reading from (1-based). Optional.' },
            limit: { type: 'integer', description: 'Maximum lines to read. Defaults to 2000.' },
        },
        required: ['file_path'],
    },
    access: ['build', 'plan', 'explore'],
    execute: async (ctx, input) => {
        const start = Date.now();
        const filePath = input.file_path as string;
        const offset = (input.offset as number) || 1;
        const limit = (input.limit as number) || 2000;

        const content = await getFileContent(ctx.projectId, filePath);
        if (content === null) {
            const { data: allFiles } = await getAdmin()
                .from('project_files')
                .select('path')
                .eq('project_id', ctx.projectId);
            const suggestions = (allFiles ?? [])
                .filter(f => f.path.toLowerCase().includes(filePath.toLowerCase().split('/').pop() ?? ''))
                .slice(0, 3)
                .map(f => f.path);
            const hint = suggestions.length > 0 ? "\nDid you mean: " + suggestions.join(', ') + "?" : "";
            return {
                callId: '', success: false, output: {},
                filesModified: [],
                error: "File not found: " + filePath + hint,
                duration_ms: Date.now() - start,
            };
        }

        const allLines = content.split('\n');
        const totalLines = allLines.length;
        const startIdx = Math.max(0, offset - 1);
        const sliced = allLines.slice(startIdx, startIdx + limit);
        const truncated = startIdx + sliced.length < totalLines;

        const numbered = sliced.map((l, i) => (startIdx + i + 1) + ": " + l).join('\n');
        let output = numbered;
        if (truncated) {
            output += "\n\n(Showing lines " + offset + "-" + (startIdx + sliced.length) + " of " + totalLines + ". Use offset=" + (startIdx + sliced.length + 1) + " to continue.)";
        } else {
            output += "\n\n(End of file - total " + totalLines + " lines)";
        }

        return {
            callId: '', success: true,
            output: { content: output, path: filePath, totalLines, linesReturned: sliced.length, truncated },
            filesModified: [],
            duration_ms: Date.now() - start,
        };
    },
});

// ── FileEditTool ────────────────────────────────────────────────────

registerTool({
    name: 'FileEditTool',
    isReadOnly: false,
    isConcurrencySafe: false,
    isDestructive: false,
    description: "Performs exact string replacements in files.\n\nUsage:\n- You must use your FileReadTool tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.\n- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: line number + colon + space (e.g., '12: '). Everything after that is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.\n- The edit will FAIL if old_string is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use replace_all to change every instance of old_string.\n- Use replace_all for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.",
    parameters: {
        type: 'object',
        properties: {
            file_path: { type: 'string', description: 'Path to the file to edit' },
            old_string: { type: 'string', description: 'The exact string to find and replace. Must be unique in the file.' },
            new_string: { type: 'string', description: 'The replacement string' },
            replace_all: { type: 'boolean', description: 'Replace all occurrences (default false)' },
        },
        required: ['file_path', 'old_string', 'new_string'],
    },
    access: ['build'],
    execute: async (ctx, input) => {
        const start = Date.now();
        const filePath = input.file_path as string;
        const oldStr = input.old_string as string;
        const newStr = input.new_string as string;
        const replaceAll = (input.replace_all as boolean) || false;

        const content = await getFileContent(ctx.projectId, filePath);
        if (content === null) {
            return {
                callId: '', success: false, output: {},
                filesModified: [],
                error: "File not found: " + filePath,
                duration_ms: Date.now() - start,
            };
        }

        try {
            const newContent = replaceWithChain(content, oldStr, newStr, replaceAll);
            await upsertFile(ctx, filePath, newContent);
            return {
                callId: '', success: true,
                output: { message: "Edit applied to " + filePath, path: filePath },
                filesModified: [filePath],
                duration_ms: Date.now() - start,
            };
        } catch (err) {
            return {
                callId: '', success: false,
                output: { hint: 'Use FileReadTool to check the current content, then retry with the exact text.' },
                filesModified: [],
                error: err instanceof Error ? err.message : 'Edit failed',
                duration_ms: Date.now() - start,
            };
        }
    },
});

// ── FileWriteTool ───────────────────────────────────────────────────

registerTool({
    name: 'FileWriteTool',
    isReadOnly: false,
    isConcurrencySafe: false,
    isDestructive: true,
    description: "Writes a file to the local filesystem.\n\nUsage:\n- This tool will overwrite the existing file if there is one at the provided path.\n- If this is an existing file, you MUST use the FileReadTool tool first to read the file's contents.\n- Prefer the Edit tool for modifying existing files — it only sends the diff. Only use this tool to create new files or for complete rewrites.\n- NEVER create documentation files (*.md) or README files unless explicitly requested by the User.\n- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.",
    parameters: {
        type: 'object',
        properties: {
            file_path: { type: 'string', description: 'Path for the file, e.g. scripts/enemy.ts' },
            content: { type: 'string', description: 'Full content of the file' },
        },
        required: ['file_path', 'content'],
    },
    access: ['build'],
    execute: async (ctx, input) => {
        const start = Date.now();
        const filePath = input.file_path as string;
        const content = input.content as string;
        await upsertFile(ctx, filePath, content);
        return {
            callId: '', success: true,
            output: { message: "Wrote " + filePath, path: filePath, lines: content.split('\n').length, bytes: new TextEncoder().encode(content).length },
            filesModified: [filePath],
            duration_ms: Date.now() - start,
        };
    },
});
