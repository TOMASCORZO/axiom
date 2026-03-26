/**
 * Snapshot — State capture and rollback for project files.
 *
 * OpenCode pattern: Before destructive tool operations, the agent captures
 * file state snapshots. If something goes wrong, the agent (or user) can
 * revert to a known-good state.
 *
 * Since Axiom uses Supabase for file storage (not local filesystem),
 * this module captures file states at the Supabase level and stores
 * snapshots in a dedicated table for diff and rollback capabilities.
 *
 * Usage:
 *   import { SnapshotManager } from '@/lib/snapshot';
 *
 *   const snap = new SnapshotManager(supabase, projectId);
 *   const id = await snap.capture('Before editing player.ts');
 *   // ... agent makes changes ...
 *   const diff = await snap.diff(id);   // See what changed
 *   await snap.revert(id);              // Undo everything
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { bus } from '../bus';

// ── Types ───────────────────────────────────────────────────────────

export interface FileSnapshot {
    path: string;
    content: string | null;
    size_bytes: number;
    content_type: string;
}

export interface Snapshot {
    id: string;
    projectId: string;
    label: string;
    timestamp: string;
    files: FileSnapshot[];
}

export interface FileDiff {
    path: string;
    action: 'added' | 'modified' | 'deleted' | 'unchanged';
    before: string | null;
    after: string | null;
}

// ── Bus Events ──────────────────────────────────────────────────────

// Extend the bus events (these are emitted but typed loosely for now)
// Future: merge into BusEvents interface

// ── Snapshot Manager ────────────────────────────────────────────────

export class SnapshotManager {
    private snapshots = new Map<string, Snapshot>();
    private counter = 0;

    constructor(
        private supabase: SupabaseClient,
        private projectId: string,
    ) {}

    /**
     * Capture a snapshot of all project files at the current moment.
     * Returns a snapshot ID that can be used for diff or revert.
     */
    async capture(label: string = 'auto'): Promise<string> {
        const { data: files } = await this.supabase
            .from('project_files')
            .select('path, text_content, size_bytes, content_type')
            .eq('project_id', this.projectId);

        const fileSnapshots: FileSnapshot[] = (files ?? []).map(f => ({
            path: f.path,
            content: f.text_content ?? null,
            size_bytes: f.size_bytes ?? 0,
            content_type: f.content_type ?? 'text',
        }));

        const id = `snap_${Date.now()}_${++this.counter}`;
        const snapshot: Snapshot = {
            id,
            projectId: this.projectId,
            label,
            timestamp: new Date().toISOString(),
            files: fileSnapshots,
        };

        this.snapshots.set(id, snapshot);

        // Prune old snapshots (keep last 20)
        if (this.snapshots.size > 20) {
            const oldest = Array.from(this.snapshots.keys())[0];
            this.snapshots.delete(oldest);
        }

        bus.emit('tool.complete', {
            toolName: 'snapshot.capture',
            success: true,
            duration_ms: 0,
            callId: id,
        });

        return id;
    }

    /**
     * Compare the current project state against a snapshot.
     * Returns a list of file diffs showing what changed.
     */
    async diff(snapshotId: string): Promise<FileDiff[]> {
        const snapshot = this.snapshots.get(snapshotId);
        if (!snapshot) throw new Error(`Snapshot "${snapshotId}" not found`);

        const { data: currentFiles } = await this.supabase
            .from('project_files')
            .select('path, text_content, size_bytes, content_type')
            .eq('project_id', this.projectId);

        const current = new Map((currentFiles ?? []).map(f => [f.path, f.text_content ?? null]));
        const snapped = new Map(snapshot.files.map(f => [f.path, f.content]));

        const diffs: FileDiff[] = [];

        // Check for modified and deleted files
        for (const [path, oldContent] of snapped) {
            const newContent = current.get(path);
            if (newContent === undefined) {
                diffs.push({ path, action: 'deleted', before: oldContent, after: null });
            } else if (newContent !== oldContent) {
                diffs.push({ path, action: 'modified', before: oldContent, after: newContent });
            }
            // unchanged files are skipped for brevity
        }

        // Check for new files
        for (const [path, newContent] of current) {
            if (!snapped.has(path)) {
                diffs.push({ path, action: 'added', before: null, after: newContent });
            }
        }

        return diffs;
    }

    /**
     * Revert the project to a snapshot's state.
     * Restores all files to their exact content at capture time.
     * Files added after the snapshot are deleted.
     * Files deleted after the snapshot are re-created.
     */
    async revert(snapshotId: string): Promise<{ restored: number; deleted: number; errors: string[] }> {
        const snapshot = this.snapshots.get(snapshotId);
        if (!snapshot) throw new Error(`Snapshot "${snapshotId}" not found`);

        const diffs = await this.diff(snapshotId);
        let restored = 0;
        let deleted = 0;
        const errors: string[] = [];

        for (const d of diffs) {
            try {
                switch (d.action) {
                    case 'modified':
                    case 'deleted': {
                        // Restore original content
                        const original = snapshot.files.find(f => f.path === d.path);
                        if (original && original.content !== null) {
                            const { error } = await this.supabase
                                .from('project_files')
                                .upsert({
                                    project_id: this.projectId,
                                    path: d.path,
                                    text_content: original.content,
                                    content_type: original.content_type,
                                    size_bytes: original.size_bytes,
                                    updated_at: new Date().toISOString(),
                                }, { onConflict: 'project_id,path' });
                            if (error) errors.push(`Restore ${d.path}: ${error.message}`);
                            else restored++;
                        }
                        break;
                    }
                    case 'added': {
                        // Delete files that didn't exist at snapshot time
                        const { error } = await this.supabase
                            .from('project_files')
                            .delete()
                            .eq('project_id', this.projectId)
                            .eq('path', d.path);
                        if (error) errors.push(`Delete ${d.path}: ${error.message}`);
                        else deleted++;
                        break;
                    }
                }
            } catch (err) {
                errors.push(`${d.path}: ${err instanceof Error ? err.message : 'unknown error'}`);
            }
        }

        return { restored, deleted, errors };
    }

    /**
     * List all available snapshots for this project.
     */
    list(): Array<{ id: string; label: string; timestamp: string; fileCount: number }> {
        return Array.from(this.snapshots.values()).map(s => ({
            id: s.id,
            label: s.label,
            timestamp: s.timestamp,
            fileCount: s.files.length,
        }));
    }

    /**
     * Get a summary string of a diff (for LLM consumption).
     */
    static formatDiff(diffs: FileDiff[]): string {
        if (diffs.length === 0) return 'No changes detected.';

        const lines: string[] = [`${diffs.length} file(s) changed:`];
        for (const d of diffs) {
            const icon = d.action === 'added' ? '+' : d.action === 'deleted' ? '-' : '~';
            lines.push(`  ${icon} ${d.path} (${d.action})`);
        }
        return lines.join('\n');
    }
}
