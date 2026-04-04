/**
 * Snapshot Tools — Expose snapshot operations as agent tools.
 *
 * OpenCode pattern: The agent can create, diff, and revert snapshots.
 */

import { registerTool, type ToolContext, type ToolInput } from './registry';
import { SnapshotManager } from '../../snapshot';

// ── snapshot_create: Capture current state ──────────────────────────

registerTool({
    name: 'snapshot_create',
    description: 'Capture a snapshot of all project files. Use before making risky changes so you can revert later.',
    parameters: {
        type: 'object',
        properties: {
            label: { type: 'string', description: 'Label for the snapshot (e.g. "before refactor")' },
        },
        required: [],
    },
    access: ['build'],
    async execute(ctx: ToolContext, input: ToolInput) {
        const mgr = new SnapshotManager(ctx.supabase, ctx.projectId);
        const id = await mgr.capture(input.label as string || 'manual');
        return {
            success: true,
            output: { snapshotId: id, message: 'Snapshot captured. Use snapshot_diff or snapshot_revert with this ID.' },
            duration_ms: 0,
        };
    },
});

// ── snapshot_diff: See what changed ─────────────────────────────────

registerTool({
    name: 'snapshot_diff',
    description: 'Compare the current project state against a previous snapshot. Shows added, modified, and deleted files.',
    parameters: {
        type: 'object',
        properties: {
            snapshotId: { type: 'string', description: 'Snapshot ID from snapshot_create' },
        },
        required: ['snapshotId'],
    },
    access: ['build', 'plan'],
    async execute(ctx: ToolContext, input: ToolInput) {
        const mgr = new SnapshotManager(ctx.supabase, ctx.projectId);
        try {
            const diffs = await mgr.diff(input.snapshotId as string);
            return {
                success: true,
                output: {
                    summary: SnapshotManager.formatDiff(diffs),
                    changes: diffs.map(d => ({ path: d.path, action: d.action })),
                    totalChanges: diffs.length,
                },
                duration_ms: 0,
            };
        } catch (err) {
            return { success: false, output: null, error: err instanceof Error ? err.message : 'Diff failed', duration_ms: 0 };
        }
    },
});

// ── snapshot_revert: Undo changes ───────────────────────────────────

registerTool({
    name: 'snapshot_revert',
    description: 'Revert all project files to a previous snapshot state. This will undo all changes made after the snapshot.',
    parameters: {
        type: 'object',
        properties: {
            snapshotId: { type: 'string', description: 'Snapshot ID to revert to' },
        },
        required: ['snapshotId'],
    },
    access: ['build'],
    requiresApproval: true,
    permissionPatterns: ['snapshot:revert'],
    async execute(ctx: ToolContext, input: ToolInput) {
        const mgr = new SnapshotManager(ctx.supabase, ctx.projectId);
        try {
            const result = await mgr.revert(input.snapshotId as string);
            return {
                success: result.errors.length === 0,
                output: result,
                error: result.errors.length > 0 ? result.errors.join('; ') : undefined,
                duration_ms: 0,
            };
        } catch (err) {
            return { success: false, output: null, error: err instanceof Error ? err.message : 'Revert failed', duration_ms: 0 };
        }
    },
});
