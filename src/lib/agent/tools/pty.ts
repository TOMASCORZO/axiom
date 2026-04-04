/**
 * PTY Tools — Expose persistent terminal sessions as agent tools.
 *
 * OpenCode tools: ptyManager interface
 */

import { registerTool, type ToolContext, type ToolInput } from './registry';
import { ptyManager } from '../../pty';

// ── pty_spawn: Start a persistent process ───────────────────────────

registerTool({
    name: 'pty_spawn',
    description: 'Start a persistent background process (dev server, watcher, test runner). Returns session ID for monitoring.',
    parameters: {
        type: 'object',
        properties: {
            command: { type: 'string', description: 'Command to run' },
            cwd: { type: 'string', description: 'Working directory' },
            timeout: { type: 'number', description: 'Auto-kill timeout in ms (0 = no timeout)' },
        },
        required: ['command'],
    },
    access: ['build'],
    requiresApproval: true,
    permissionPatterns: ['shell:*'],
    async execute(ctx: ToolContext, input: ToolInput) {
        const id = ptyManager.spawn(input.command as string, {
            cwd: input.cwd as string | undefined,
            timeout: input.timeout as number || 0,
        });

        await new Promise(r => setTimeout(r, 1500));
        const output = ptyManager.read(id, 30);

        return {
            success: true,
            output: { sessionId: id, initialOutput: output },
            duration_ms: 0,
        };
    },
});

// ── pty_read: Read output from a session ────────────────────────────

registerTool({
    name: 'pty_read',
    description: 'Read the output buffer from a persistent terminal session.',
    parameters: {
        type: 'object',
        properties: {
            sessionId: { type: 'string', description: 'Session ID from pty_spawn' },
            lastN: { type: 'number', description: 'Only return the last N lines (default: all)' },
        },
        required: ['sessionId'],
    },
    access: ['build', 'plan', 'explore'],
    async execute(ctx: ToolContext, input: ToolInput) {
        try {
            const output = ptyManager.read(input.sessionId as string, input.lastN as number | undefined);
            const info = ptyManager.info(input.sessionId as string);
            return {
                success: true,
                output: { output, status: info?.status ?? 'unknown', exitCode: info?.exitCode },
                duration_ms: 0,
            };
        } catch (err) {
            return { success: false, output: null, error: err instanceof Error ? err.message : 'Read failed', duration_ms: 0 };
        }
    },
});

// ── pty_write: Send input to a session ──────────────────────────────

registerTool({
    name: 'pty_write',
    description: 'Send input to a running terminal session stdin (e.g. answer prompts, send keyboard shortcuts).',
    parameters: {
        type: 'object',
        properties: {
            sessionId: { type: 'string', description: 'Session ID' },
            input: { type: 'string', description: 'Input to send (include \\n for Enter)' },
        },
        required: ['sessionId', 'input'],
    },
    access: ['build'],
    async execute(ctx: ToolContext, input: ToolInput) {
        try {
            const success = ptyManager.write(input.sessionId as string, input.input as string);
            return {
                success,
                output: { written: success },
                error: success ? undefined : 'Session not running or stdin not available',
                duration_ms: 0,
            };
        } catch (err) {
            return { success: false, output: null, error: err instanceof Error ? err.message : 'Write failed', duration_ms: 0 };
        }
    },
});

// ── pty_kill: Kill a session ────────────────────────────────────────

registerTool({
    name: 'pty_kill',
    description: 'Kill a running terminal session.',
    parameters: {
        type: 'object',
        properties: {
            sessionId: { type: 'string', description: 'Session ID to kill' },
        },
        required: ['sessionId'],
    },
    access: ['build'],
    async execute(ctx: ToolContext, input: ToolInput) {
        const killed = ptyManager.kill(input.sessionId as string);
        return {
            success: killed,
            output: { killed },
            error: killed ? undefined : 'Session not found or already stopped',
            duration_ms: 0,
        };
    },
});

// ── pty_list: List all sessions ─────────────────────────────────────

registerTool({
    name: 'pty_list',
    description: 'List all terminal sessions (active and completed).',
    parameters: { type: 'object', properties: {}, required: [] },
    access: ['build', 'plan', 'explore'],
    async execute(ctx: ToolContext, input: ToolInput) {
        const sessions = ptyManager.list();
        return {
            success: true,
            output: { sessions, count: sessions.length },
            duration_ms: 0,
        };
    },
});
