/**
 * Interactive Slash Commands
 * Intercepts user inputs beginning with '/' to run local functions without LLM cost.
 */

import { formatCostDisplay } from './cost';
import { autoCompactIfNeeded } from './services/autoCompact';
import { resolveProvider } from './providers';
import type { Message } from '../../types/agent';
import { execFileSync } from 'child_process';

export type CommandAction = (args: string, sessionId: string, history: Message[]) => Promise<string | { status: string, newHistory?: Message[] }>;

export interface CommandDefinition {
    name: string;
    description: string;
    action: CommandAction;
}

const commands = new Map<string, CommandDefinition>();

function registerCommand(def: CommandDefinition) {
    commands.set(def.name, def);
}

// ── Built-in Commands ────────────────────────────────────────────────

registerCommand({
    name: 'help',
    description: 'Lists all available slash commands',
    async action() {
        let out = 'Available Commands:\n';
        for (const [name, def] of commands) {
            out += `  /${name.padEnd(10)} - ${def.description}\n`;
        }
        return out;
    }
});

registerCommand({
    name: 'cost',
    description: 'Displays the total token cost for the current session',
    async action(_args, sessionId) {
        return formatCostDisplay(sessionId);
    }
});

registerCommand({
    name: 'clear',
    description: 'Wipes the conversation history, resetting the context window',
    async action() {
        return { status: "Context cleared. Starting fresh.", newHistory: [] };
    }
});

registerCommand({
    name: 'compact',
    description: 'Force compacts the oldest history messages into a summary to save tokens',
    async action(_args, _sessionId, history) {
        if (history.length < 3) {
            return "Nothing to compact yet.";
        }

        const providerData = resolveProvider();
        if (!providerData) {
            return "Cannot compact: no AI provider configured.";
        }

        const result = await autoCompactIfNeeded(history, providerData.provider, 0);
        if (!result.wasCompacted) {
            return "Nothing to compact.";
        }

        return {
            status: `Compacted conversation from ${history.length} to ${result.messages.length} messages.`,
            newHistory: result.messages
        };
    }
});

registerCommand({
    name: 'commit',
    description: 'Automatically commits staged files',
    async action(args) {
        try {
            const msg = args ? args.trim() : 'Auto-commit from Axiom agent';
            execFileSync('git', ['commit', '-m', msg], { stdio: 'pipe' });
            return "Successfully committed staged files.";
        } catch (e: any) {
            return "Failed to commit. Ensure you have staged files: " + e.message;
        }
    }
});

// ── Router ───────────────────────────────────────────────────────────

export async function handleSlashCommand(
    message: string,
    sessionId: string,
    history: Message[]
): Promise<{ intercepted: false } | { intercepted: true, output: string, newHistory?: Message[] }> {
    const trimmed = message.trim();
    if (!trimmed.startsWith('/')) return { intercepted: false };

    const parts = trimmed.slice(1).split(' ');
    const cmdName = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ');

    const cmd = commands.get(cmdName);
    if (!cmd) {
        return {
            intercepted: true,
            output: `Unknown command '/${cmdName}'. Type /help for available options.`
        };
    }

    try {
        const result = await cmd.action(args, sessionId, history);
        if (typeof result === 'string') {
            return { intercepted: true, output: result };
        }
        return { intercepted: true, output: result.status, newHistory: result.newHistory };
    } catch (err: any) {
        return { intercepted: true, output: `Command '/${cmdName}' failed: ${err.message}` };
    }
}
