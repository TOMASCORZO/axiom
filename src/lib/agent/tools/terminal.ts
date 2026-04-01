/**
 * Terminal Execution Tools — Real shell execution via child_process.
 * Ported from Claude Code's BashTool architecture.
 */

import { registerTool, type ToolContext, type ToolInput } from './registry';
import { execSync, spawn } from 'child_process';
import { isPlanMode } from './sandbox';

const MAX_OUTPUT_CHARS = 30_000;
const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes
const MAX_TIMEOUT_MS = 600_000;     // 10 minutes

// Security: commands that are always blocked
const BLOCKED_PATTERNS = [
    /rm\s+-rf\s+\//,
    /sudo\s+rm/,
    /mkfs\./,
    /dd\s+if=.*of=\/dev/,
    />\s*\/dev\/sd/,
    /chmod\s+-R\s+777\s+\//,
];

// Commands considered read-only (used for plan mode enforcement)
const READ_ONLY_COMMANDS = new Set([
    'ls', 'cat', 'head', 'tail', 'less', 'more', 'wc', 'find', 'grep', 'rg',
    'ag', 'ack', 'tree', 'du', 'df', 'stat', 'file', 'which', 'whereis',
    'echo', 'printf', 'date', 'pwd', 'whoami', 'hostname', 'uname',
    'git status', 'git log', 'git diff', 'git branch', 'git show',
    'npm list', 'npm ls', 'node -v', 'npm -v', 'bun -v',
    'env', 'printenv', 'type', 'man', 'help',
]);

function isReadOnlyCommand(cmd: string): boolean {
    const trimmed = cmd.trim();
    for (const ro of READ_ONLY_COMMANDS) {
        if (trimmed === ro || trimmed.startsWith(ro + ' ')) return true;
    }
    return false;
}

function isBlockedCommand(cmd: string): boolean {
    return BLOCKED_PATTERNS.some(p => p.test(cmd));
}

// ── BashTool ────────────────────────────────────────────────────────

registerTool({
    name: 'BashTool',
    isReadOnly: false,  // checked dynamically in execute via isReadOnlyCommand()
    isConcurrencySafe: false,
    isDestructive: false, // checked dynamically via isBlockedCommand()
    description: "Execute bash commands in the workspace.\n\nUsage:\n- Use for running tests, builds, git operations, or querying system state.\n- Prefer dedicated tools (FileReadTool, GrepTool, GlobTool) over bash equivalents.\n- Commands run with a 2-minute timeout by default (max 10 minutes).\n- Use background=true for long-running processes like dev servers.",
    parameters: {
        type: 'object',
        properties: {
            command: { type: 'string', description: 'Bash command to run' },
            background: { type: 'boolean', description: 'Run in background and return immediately (default: false)' },
            timeoutMs: { type: 'integer', description: 'Max execution time in ms (default: 120000, max: 600000)' }
        },
        required: ['command']
    },
    access: ['build', 'plan', 'explore'],
    async execute(ctx: ToolContext, input: ToolInput) {
        const start = Date.now();
        const cmd = input.command as string;
        const isBg = !!input.background;
        const timeout = Math.min((input.timeoutMs as number) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

        // Security: block dangerous commands
        if (isBlockedCommand(cmd)) {
            return {
                callId: '', success: false, output: null, filesModified: [],
                error: 'Command blocked: contains forbidden destructive patterns.',
                duration_ms: Date.now() - start
            };
        }

        // Plan mode: only allow read-only commands
        if (isPlanMode() && !isReadOnlyCommand(cmd)) {
            return {
                callId: '', success: false, output: null, filesModified: [],
                error: 'Plan mode is active. Only read-only commands are allowed. Exit plan mode first.',
                duration_ms: Date.now() - start
            };
        }

        if (isBg) {
            // Background: spawn detached, return immediately
            try {
                const child = spawn('bash', ['-c', cmd], {
                    detached: true,
                    stdio: 'ignore',
                    cwd: process.cwd()
                });
                child.unref();
                return {
                    callId: '', success: true, filesModified: [],
                    output: { message: `Command launched in background (PID: ${child.pid}).`, pid: child.pid },
                    duration_ms: Date.now() - start
                };
            } catch (e: any) {
                return {
                    callId: '', success: false, output: null, filesModified: [],
                    error: 'Failed to spawn background process: ' + e.message,
                    duration_ms: Date.now() - start
                };
            }
        }

        // Foreground: run synchronously with timeout
        try {
            const result = execSync(cmd, {
                cwd: process.cwd(),
                encoding: 'utf-8',
                timeout,
                maxBuffer: 10 * 1024 * 1024, // 10MB
                stdio: ['pipe', 'pipe', 'pipe'],
            });

            let stdout = result ?? '';
            if (stdout.length > MAX_OUTPUT_CHARS) {
                stdout = stdout.slice(0, MAX_OUTPUT_CHARS) + '\n...[truncated]';
            }

            return {
                callId: '', success: true, filesModified: [],
                output: { stdout, exitCode: 0 },
                duration_ms: Date.now() - start
            };
        } catch (e: any) {
            const stdout = (e.stdout as string ?? '').slice(0, MAX_OUTPUT_CHARS);
            const stderr = (e.stderr as string ?? '').slice(0, MAX_OUTPUT_CHARS);
            const exitCode = e.status ?? 1;
            const timedOut = e.killed || e.signal === 'SIGTERM';

            return {
                callId: '', success: false, filesModified: [],
                output: {
                    stdout,
                    stderr,
                    exitCode,
                    timedOut
                },
                error: timedOut
                    ? `Command timed out after ${timeout}ms. Use background=true for long-running commands.`
                    : stderr || e.message,
                duration_ms: Date.now() - start
            };
        }
    }
});

// ── REPLTool ────────────────────────────────────────────────────────

const REPL_COMMANDS: Record<string, string> = {
    node: 'node -e',
    python: 'python3 -c',
    python3: 'python3 -c',
    ruby: 'ruby -e',
    bash: 'bash -c',
};

registerTool({
    name: 'REPLTool',
    isReadOnly: false,
    isConcurrencySafe: false,
    description: "Execute code snippets in a REPL (Node.js, Python, Ruby). Use for quick evaluation, testing expressions, or running scripts.",
    parameters: {
        type: 'object',
        properties: {
            language: { type: 'string', description: 'Language: "node", "python", "ruby", "bash"' },
            code: { type: 'string', description: 'Code snippet to evaluate' },
        },
        required: ['language', 'code']
    },
    access: ['build', 'plan', 'explore'],
    async execute(ctx: ToolContext, input: ToolInput) {
        const start = Date.now();
        const lang = (input.language as string).toLowerCase();
        const code = input.code as string;

        const prefix = REPL_COMMANDS[lang];
        if (!prefix) {
            return {
                callId: '', success: false, output: null, filesModified: [],
                error: `Unsupported language: "${lang}". Supported: ${Object.keys(REPL_COMMANDS).join(', ')}`,
                duration_ms: Date.now() - start
            };
        }

        try {
            const result = execSync(`${prefix} ${JSON.stringify(code)}`, {
                cwd: process.cwd(),
                encoding: 'utf-8',
                timeout: 30_000,
                maxBuffer: 5 * 1024 * 1024,
                stdio: ['pipe', 'pipe', 'pipe'],
            });

            let output = result ?? '';
            if (output.length > MAX_OUTPUT_CHARS) {
                output = output.slice(0, MAX_OUTPUT_CHARS) + '\n...[truncated]';
            }

            return {
                callId: '', success: true, filesModified: [],
                output: { result: output, language: lang },
                duration_ms: Date.now() - start
            };
        } catch (e: any) {
            return {
                callId: '', success: false, filesModified: [],
                output: {
                    stdout: (e.stdout ?? '').slice(0, MAX_OUTPUT_CHARS),
                    stderr: (e.stderr ?? '').slice(0, MAX_OUTPUT_CHARS),
                },
                error: (e.stderr ?? e.message ?? 'Execution failed').slice(0, 2000),
                duration_ms: Date.now() - start
            };
        }
    }
});

// ── SleepTool ───────────────────────────────────────────────────────

registerTool({
    name: 'SleepTool',
    isReadOnly: true,
    isConcurrencySafe: true,
    description: "Pause execution for a specific number of milliseconds. Capped at 15 seconds.",
    parameters: {
        type: 'object',
        properties: {
            durationMs: { type: 'integer', description: 'Milliseconds to sleep' }
        },
        required: ['durationMs']
    },
    access: ['build', 'plan'],
    async execute(_ctx: ToolContext, input: ToolInput) {
        const ms = Math.min(input.durationMs as number, 15_000);
        await new Promise(resolve => setTimeout(resolve, ms));
        return {
            callId: '', success: true, filesModified: [],
            output: `Slept for ${ms}ms.`,
            duration_ms: ms
        };
    }
});
