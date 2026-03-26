/**
 * PTY Manager — Persistent terminal sessions for the Axiom agent.
 *
 * OpenCode pattern: Instead of ephemeral child_process.exec() calls,
 * manage persistent shell sessions that can run long-lived processes
 * (dev servers, build watchers, test runners) in the background.
 *
 * Since Axiom runs as a web backend (not local CLI), this uses
 * child_process.spawn with PTY-like state tracking. Each terminal
 * session has an ID, output buffer, and lifecycle management.
 *
 * Usage:
 *   import { ptyManager } from '@/lib/pty';
 *
 *   const id = await ptyManager.spawn('npm run dev', { cwd: '/project' });
 *   const output = ptyManager.read(id);
 *   await ptyManager.write(id, 'q\n');  // Send input
 *   await ptyManager.kill(id);          // Terminate
 */

import { spawn, type ChildProcess } from 'child_process';
import { bus } from '../bus';

// ── Types ───────────────────────────────────────────────────────────

export interface PtySession {
    id: string;
    command: string;
    cwd: string;
    process: ChildProcess;
    output: string[];
    maxOutputLines: number;
    status: 'running' | 'exited' | 'killed';
    exitCode: number | null;
    startedAt: string;
    endedAt: string | null;
}

export interface PtyCreateOptions {
    cwd?: string;
    env?: Record<string, string>;
    maxOutputLines?: number;
    /** Timeout in ms after which the process is auto-killed (0 = no timeout) */
    timeout?: number;
}

// ── PTY Manager ─────────────────────────────────────────────────────

class PtyManager {
    private sessions = new Map<string, PtySession>();
    private counter = 0;

    /**
     * Spawn a new persistent terminal session.
     * Returns the session ID.
     */
    spawn(command: string, options: PtyCreateOptions = {}): string {
        const id = `pty_${Date.now()}_${++this.counter}`;
        const cwd = options.cwd ?? process.cwd();
        const maxOutputLines = options.maxOutputLines ?? 1000;

        const isWindows = process.platform === 'win32';
        const shell = isWindows ? 'cmd' : 'bash';
        const args = isWindows ? ['/c', command] : ['-lc', command];

        const childProcess = spawn(shell, args, {
            cwd,
            env: { ...process.env, ...options.env },
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        const session: PtySession = {
            id,
            command,
            cwd,
            process: childProcess,
            output: [],
            maxOutputLines,
            status: 'running',
            exitCode: null,
            startedAt: new Date().toISOString(),
            endedAt: null,
        };

        // Capture stdout
        childProcess.stdout?.on('data', (data: Buffer) => {
            const text = data.toString();
            const lines = text.split('\n');
            session.output.push(...lines.filter(l => l.length > 0));

            // Prune output buffer
            if (session.output.length > maxOutputLines) {
                session.output = session.output.slice(-maxOutputLines);
            }
        });

        // Capture stderr (merge into same output)
        childProcess.stderr?.on('data', (data: Buffer) => {
            const text = data.toString();
            const lines = text.split('\n');
            session.output.push(...lines.filter(l => l.length > 0).map(l => `[stderr] ${l}`));

            if (session.output.length > maxOutputLines) {
                session.output = session.output.slice(-maxOutputLines);
            }
        });

        // Track exit
        childProcess.on('exit', (code) => {
            session.status = 'exited';
            session.exitCode = code;
            session.endedAt = new Date().toISOString();
            bus.emit('tool.complete', {
                toolName: `pty:${id}`,
                success: code === 0,
                duration_ms: Date.now() - new Date(session.startedAt).getTime(),
                callId: id,
            });
        });

        childProcess.on('error', (err) => {
            session.status = 'exited';
            session.exitCode = -1;
            session.endedAt = new Date().toISOString();
            session.output.push(`[error] ${err.message}`);
        });

        // Auto-kill timeout
        if (options.timeout && options.timeout > 0) {
            setTimeout(() => {
                if (session.status === 'running') {
                    this.kill(id);
                }
            }, options.timeout);
        }

        this.sessions.set(id, session);

        bus.emit('tool.start', {
            toolName: `pty:spawn`,
            input: { command, cwd },
            callId: id,
        });

        return id;
    }

    /**
     * Read the output buffer for a session.
     * @param lastN - Only return the last N lines (default: all)
     */
    read(id: string, lastN?: number): string {
        const session = this.sessions.get(id);
        if (!session) throw new Error(`PTY session "${id}" not found`);

        const lines = lastN ? session.output.slice(-lastN) : session.output;
        return lines.join('\n');
    }

    /**
     * Write input to a running session's stdin.
     */
    write(id: string, input: string): boolean {
        const session = this.sessions.get(id);
        if (!session) throw new Error(`PTY session "${id}" not found`);
        if (session.status !== 'running') return false;

        return session.process.stdin?.write(input) ?? false;
    }

    /**
     * Kill a running session.
     */
    kill(id: string): boolean {
        const session = this.sessions.get(id);
        if (!session) return false;
        if (session.status !== 'running') return false;

        session.process.kill('SIGTERM');
        session.status = 'killed';
        session.endedAt = new Date().toISOString();
        return true;
    }

    /**
     * Get info about a session.
     */
    info(id: string): Omit<PtySession, 'process'> | null {
        const session = this.sessions.get(id);
        if (!session) return null;

        const { process: _, ...info } = session;
        return info;
    }

    /**
     * List all sessions (active and completed).
     */
    list(): Array<{ id: string; command: string; status: string; exitCode: number | null }> {
        return Array.from(this.sessions.values()).map(s => ({
            id: s.id,
            command: s.command,
            status: s.status,
            exitCode: s.exitCode,
        }));
    }

    /**
     * Kill all running sessions. Useful for cleanup.
     */
    killAll(): number {
        let killed = 0;
        for (const session of this.sessions.values()) {
            if (session.status === 'running') {
                session.process.kill('SIGTERM');
                session.status = 'killed';
                session.endedAt = new Date().toISOString();
                killed++;
            }
        }
        return killed;
    }

    /**
     * Remove completed/killed sessions from memory.
     */
    prune(): number {
        let removed = 0;
        for (const [id, session] of this.sessions) {
            if (session.status !== 'running') {
                this.sessions.delete(id);
                removed++;
            }
        }
        return removed;
    }
}

// ── Singleton Export ─────────────────────────────────────────────────

/** Global PTY manager instance */
export const ptyManager = new PtyManager();

export { PtyManager };
