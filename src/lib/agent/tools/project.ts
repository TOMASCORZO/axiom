/**
 * Project Context Tool — read_project_state.
 *
 * OpenCode tool: Provides a full overview of the project structure
 * for the agent to understand what it's working with.
 */

import { registerTool, type ToolContext, type ToolInput } from './registry';
import { getAdminClient as getAdmin } from '@/lib/supabase/admin';

registerTool({
    name: 'read_project_state',
    description: 'Get a complete overview of the project: file tree, file sizes, content types, and total stats. Use this first to understand the project structure.',
    parameters: {
        includeContent: { type: 'boolean', description: 'Include file contents (warning: can be very large). Default: false.' },
        pathFilter: { type: 'string', description: 'Only show files matching this path prefix' },
    },
    access: ['build', 'plan', 'explore'],
    async execute(ctx: ToolContext, input: ToolInput) {
        let query = getAdmin()
            .from('project_files')
            .select(input.includeContent ? 'path, content_type, size_bytes, text_content' : 'path, content_type, size_bytes')
            .eq('project_id', ctx.projectId)
            .order('path');

        if (input.pathFilter) {
            query = query.like('path', `${input.pathFilter}%`);
        }

        const { data } = await query;
        const allFiles = (data ?? []) as unknown as Array<{ path: string; content_type: string; size_bytes: number; text_content?: string }>;

        // Compute stats
        const stats = {
            totalFiles: allFiles.length,
            totalSize: allFiles.reduce((sum, f) => sum + (f.size_bytes ?? 0), 0),
            byType: {} as Record<string, number>,
            byExtension: {} as Record<string, number>,
        };

        for (const f of allFiles) {
            stats.byType[f.content_type] = (stats.byType[f.content_type] || 0) + 1;
            const ext = f.path.split('.').pop() ?? 'unknown';
            stats.byExtension[ext] = (stats.byExtension[ext] || 0) + 1;
        }

        // Build tree structure
        const tree = allFiles.map(f => ({
            path: f.path,
            type: f.content_type,
            size: f.size_bytes ?? 0,
            ...(input.includeContent && f.text_content ? { content: f.text_content } : {}),
        }));

        return {
            success: true,
            output: { tree, stats },
            duration_ms: 0,
        };
    },
});
