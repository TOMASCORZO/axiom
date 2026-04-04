/**
 * Shell Execution Tools — bash and batch command execution.
 *
 * OpenCode tools: bash.ts, batch.ts
 * Provides real command execution via the PTY manager (persistent sessions)
 * or one-shot execution via child_process.
 */

import { registerTool, type ToolContext, type ToolInput } from './registry';
import { ptyManager } from '../../pty';

// ── bash: Execute a shell command ───────────────────────────────────

registerTool({
    name: 'bash',
    description: 'Execute a shell command and return its output. For long-running processes (dev servers, watchers), use background=true.',
    parameters: {
        type: 'object',
        properties: {
            command: { type: 'string', description: 'The shell command to execute' },
            cwd: { type: 'string', description: 'Working directory (defaults to project root)' },
            timeout: { type: 'number', description: 'Timeout in ms (default: 30000, max: 120000)' },
            background: { type: 'boolean', description: 'If true, run as persistent background process via PTY' },
        },
        required: ['command'],
    },
    access: ['build'],
    requiresApproval: true,
    permissionPatterns: ['shell:*'],
    async execute(ctx: ToolContext, input: ToolInput) {
        const command = input.command as string;
        const timeout = Math.min(input.timeout as number || 30_000, 120_000);
        const background = input.background as boolean || false;

        if (background) {
            // Persistent PTY session
            const sessionId = ptyManager.spawn(command, {
                timeout: 0, // No auto-kill for background
                maxOutputLines: 500,
            });

            // Wait a bit to capture initial output
            await new Promise(r => setTimeout(r, 2000));
            const output = ptyManager.read(sessionId, 50);

            return {
                success: true,
                output: {
                    sessionId,
                    status: 'running',
                    initialOutput: output,
                    hint: `Background process started. Use pty_read('${sessionId}') to check output, pty_kill('${sessionId}') to stop.`,
                },
                duration_ms: 0,
            };
        }

        // One-shot execution
        const { execSync } = await import('child_process');
        try {
            const result = execSync(command, {
                timeout,
                encoding: 'utf-8',
                maxBuffer: 1024 * 1024 * 5, // 5MB
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            return {
                success: true,
                output: { stdout: result.trim(), exitCode: 0 },
                duration_ms: 0,
            };
        } catch (err: unknown) {
            const e = err as { stdout?: string; stderr?: string; status?: number; message?: string };
            return {
                success: false,
                output: {
                    stdout: e.stdout?.trim() ?? '',
                    stderr: e.stderr?.trim() ?? '',
                    exitCode: e.status ?? 1,
                },
                error: e.stderr?.trim() || e.message || 'Command failed',
                duration_ms: 0,
            };
        }
    },
});

// ── batch: Execute multiple commands sequentially ───────────────────

registerTool({
    name: 'batch',
    description: 'Execute multiple shell commands sequentially. Stops on first failure unless continueOnError is true.',
    parameters: {
        type: 'object',
        properties: {
            commands: { type: 'array', items: { type: 'string' }, description: 'Array of shell command strings' },
            cwd: { type: 'string', description: 'Working directory' },
            continueOnError: { type: 'boolean', description: 'Continue executing after a command fails (default: false)' },
        },
        required: ['commands'],
    },
    access: ['build'],
    requiresApproval: true,
    permissionPatterns: ['shell:*'],
    async execute(ctx: ToolContext, input: ToolInput) {
        const commands = input.commands as string[];
        const continueOnError = input.continueOnError as boolean || false;
        const { execSync } = await import('child_process');

        const results: Array<{ command: string; exitCode: number; stdout: string; stderr: string }> = [];
        let allSuccess = true;

        for (const cmd of commands) {
            try {
                const stdout = execSync(cmd, {
                    timeout: 30_000,
                    encoding: 'utf-8',
                    maxBuffer: 1024 * 1024 * 5,
                    stdio: ['pipe', 'pipe', 'pipe'],
                });
                results.push({ command: cmd, exitCode: 0, stdout: stdout.trim(), stderr: '' });
            } catch (err: unknown) {
                const e = err as { stdout?: string; stderr?: string; status?: number };
                allSuccess = false;
                results.push({
                    command: cmd,
                    exitCode: e.status ?? 1,
                    stdout: e.stdout?.trim() ?? '',
                    stderr: e.stderr?.trim() ?? '',
                });
                if (!continueOnError) break;
            }
        }

        return {
            success: allSuccess,
            output: { results, totalCommands: commands.length, executed: results.length },
            error: allSuccess ? undefined : `${results.filter(r => r.exitCode !== 0).length} command(s) failed`,
            duration_ms: 0,
        };
    },
});
