/**
 * Structural Editing Tools — multiedit and apply_patch.
 *
 * OpenCode tools: multiedit.ts, apply_patch.ts
 * Allows the agent to make multiple non-contiguous edits in parallel
 * and apply unified diff patches.
 */

import { registerTool, type ToolContext, type ToolInput } from './registry';
import { getAdminClient as getAdmin } from '@/lib/supabase/admin';

// ── multiedit: Apply multiple edits to a single file ────────────────

registerTool({
    name: 'multiedit',
    description: 'Apply multiple find-and-replace edits to a single file in one operation. More efficient than multiple edit_file calls.',
    parameters: {
        path: { type: 'string', description: 'File path to edit', required: true },
        edits: { type: 'array', description: 'Array of { find: string, replace: string } objects', required: true },
    },
    access: ['build'],
    requiresApproval: false,
    async execute(ctx: ToolContext, input: ToolInput) {
        const path = input.path as string;
        const edits = input.edits as Array<{ find: string; replace: string }>;

        // Read current content
        const { data } = await getAdmin()
            .from('project_files')
            .select('text_content')
            .eq('project_id', ctx.projectId)
            .eq('path', path)
            .single();

        if (!data?.text_content) {
            return {
                success: false,
                output: null,
                error: `File not found: ${path}`,
                duration_ms: 0,
            };
        }

        let content = data.text_content;
        const applied: string[] = [];
        const failed: string[] = [];

        for (const edit of edits) {
            if (content.includes(edit.find)) {
                content = content.replace(edit.find, edit.replace);
                applied.push(edit.find.slice(0, 40));
            } else {
                failed.push(edit.find.slice(0, 40));
            }
        }

        if (applied.length === 0) {
            return {
                success: false,
                output: { applied: 0, failed: failed.length, failedEdits: failed },
                error: 'No edits matched',
                duration_ms: 0,
            };
        }

        // Write back
        const sizeBytes = new TextEncoder().encode(content).length;
        ctx.createdFiles.push({ path, content, size_bytes: sizeBytes, content_type: 'text' });

        const { error } = await getAdmin()
            .from('project_files')
            .upsert({
                project_id: ctx.projectId,
                path,
                text_content: content,
                content_type: 'text',
                size_bytes: sizeBytes,
                updated_at: new Date().toISOString(),
            }, { onConflict: 'project_id,path' });

        return {
            success: !error,
            output: { applied: applied.length, failed: failed.length, appliedEdits: applied, failedEdits: failed },
            error: error?.message,
            filesModified: [path],
            duration_ms: 0,
        };
    },
});

// ── apply_patch: Apply a unified diff patch ─────────────────────────

registerTool({
    name: 'apply_patch',
    description: 'Apply a unified diff patch to a file. Use standard unified diff format with --- and +++ headers.',
    parameters: {
        path: { type: 'string', description: 'File path to patch', required: true },
        patch: { type: 'string', description: 'Unified diff patch content', required: true },
    },
    access: ['build'],
    requiresApproval: false,
    async execute(ctx: ToolContext, input: ToolInput) {
        const path = input.path as string;
        const patch = input.patch as string;

        // Read current content
        const { data } = await getAdmin()
            .from('project_files')
            .select('text_content')
            .eq('project_id', ctx.projectId)
            .eq('path', path)
            .single();

        if (!data?.text_content) {
            return {
                success: false,
                output: null,
                error: `File not found: ${path}`,
                duration_ms: 0,
            };
        }

        try {
            const patched = applyUnifiedDiff(data.text_content, patch);
            const sizeBytes = new TextEncoder().encode(patched).length;

            ctx.createdFiles.push({ path, content: patched, size_bytes: sizeBytes, content_type: 'text' });

            const { error } = await getAdmin()
                .from('project_files')
                .upsert({
                    project_id: ctx.projectId,
                    path,
                    text_content: patched,
                    content_type: 'text',
                    size_bytes: sizeBytes,
                    updated_at: new Date().toISOString(),
                }, { onConflict: 'project_id,path' });

            return {
                success: !error,
                output: { message: `Patch applied to ${path}` },
                error: error?.message,
                filesModified: [path],
                duration_ms: 0,
            };
        } catch (err) {
            return {
                success: false,
                output: null,
                error: err instanceof Error ? err.message : 'Patch failed',
                duration_ms: 0,
            };
        }
    },
});

// ── Patch application logic ─────────────────────────────────────────

function applyUnifiedDiff(original: string, patch: string): string {
    const lines = original.split('\n');
    const patchLines = patch.split('\n');
    const result = [...lines];
    let offset = 0;

    for (let i = 0; i < patchLines.length; i++) {
        const hunkMatch = patchLines[i].match(/^@@\s*-(\d+)(?:,\d+)?\s*\+(\d+)(?:,\d+)?\s*@@/);
        if (!hunkMatch) continue;

        const startLine = parseInt(hunkMatch[1], 10) - 1 + offset;
        let pos = startLine;

        for (let j = i + 1; j < patchLines.length; j++) {
            const line = patchLines[j];
            if (line.startsWith('@@') || line.startsWith('---') || line.startsWith('+++')) break;

            if (line.startsWith('-')) {
                result.splice(pos, 1);
                offset--;
            } else if (line.startsWith('+')) {
                result.splice(pos, 0, line.slice(1));
                pos++;
                offset++;
            } else if (line.startsWith(' ')) {
                pos++;
            }
        }
    }

    return result.join('\n');
}
