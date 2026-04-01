/**
 * Sandbox & Planning Tools
 * Uses per-session worktree tracking instead of mutating process.cwd().
 */

import { registerTool, type ToolContext, type ToolInput } from './registry';
import { execSync } from 'child_process';
import * as path from 'path';

// Per-session state (keyed by projectId to be multi-tenant safe)
const worktrees = new Map<string, { path: string; branch: string }>();
let planModeActive = false;

export function getEffectiveCwd(ctx: ToolContext): string {
    const wt = worktrees.get(ctx.projectId);
    return wt ? wt.path : process.cwd();
}

export function isPlanMode(): boolean {
    return planModeActive;
}

// ── EnterWorktreeTool ───────────────────────────────────────────────

registerTool({
    name: 'EnterWorktreeTool',
    isReadOnly: false,
    isConcurrencySafe: false,
    isDestructive: false,
    description: "Create an isolated Git worktree to test out code edits or refactors without touching the main directory. Use when you are unsure if a large codebase change will compile or work correctly.",
    parameters: {
        type: 'object',
        properties: {
            branchName: { type: 'string', description: 'Name of the new isolated branch to create and bind to the worktree.' }
        },
        required: ['branchName']
    },
    access: ['build', 'plan'],
    async execute(ctx: ToolContext, input: ToolInput) {
        if (worktrees.has(ctx.projectId)) {
            return { callId: '', success: false, output: null, filesModified: [], error: "Already inside a worktree for this project. Exit first.", duration_ms: 0 };
        }

        const branch = input.branchName as string;
        const safeBranch = branch.replace(/[^a-zA-Z0-9_-]/g, '-');
        const wtPath = path.join('/tmp', `axiom_worktree_${safeBranch}_${Date.now()}`);

        try {
            execSync(`git worktree add "${wtPath}" -b "${safeBranch}"`, { stdio: 'pipe' });
            worktrees.set(ctx.projectId, { path: wtPath, branch: safeBranch });

            return {
                callId: '', success: true, filesModified: [],
                output: `Entered isolated Git worktree at ${wtPath}. All subsequent BashTool commands for this session should use cwd="${wtPath}".`,
                duration_ms: 0
            };
        } catch (e: any) {
            return { callId: '', success: false, output: null, error: e.message || String(e), filesModified: [], duration_ms: 0 };
        }
    }
});

// ── ExitWorktreeTool ────────────────────────────────────────────────

registerTool({
    name: 'ExitWorktreeTool',
    isReadOnly: false,
    isConcurrencySafe: false,
    description: "Exit the isolated Git worktree and return to the main project directory. If your changes were successful, you can merge them into the main branch or discard them.",
    parameters: {
        type: 'object',
        properties: {
            action: { type: 'string', description: '"discard" or "merge"' }
        },
        required: ['action']
    },
    access: ['build', 'plan'],
    async execute(ctx: ToolContext, input: ToolInput) {
        const wt = worktrees.get(ctx.projectId);
        if (!wt) {
            return { callId: '', success: false, output: null, filesModified: [], error: "Not currently in a worktree.", duration_ms: 0 };
        }
        const action = input.action as string;

        try {
            if (action === 'merge') {
                execSync(`git merge "${wt.branch}"`, { cwd: process.cwd(), stdio: 'pipe' });
            }

            execSync(`git worktree remove --force "${wt.path}"`, { stdio: 'pipe' });
            worktrees.delete(ctx.projectId);

            return {
                callId: '', success: true, filesModified: [],
                output: action === 'merge'
                    ? "Successfully merged worktree changes back to the main branch."
                    : "Successfully discarded the worktree and all experimental changes.",
                duration_ms: 0
            };
        } catch (e: any) {
            worktrees.delete(ctx.projectId);
            return { callId: '', success: false, output: null, error: e.message || String(e), filesModified: [], duration_ms: 0 };
        }
    }
});

// ── EnterPlanModeTool ───────────────────────────────────────────────

registerTool({
    name: 'EnterPlanModeTool',
    isReadOnly: true,
    isConcurrencySafe: false,
    description: "Switch into read-only planning mode. Destructive tools (FileEdit, Bash) will be blocked. Use this at the start of complex requests to thoroughly explore and investigate without accidentally breaking the project.",
    parameters: { type: 'object', properties: {}, required: [] },
    access: ['build', 'plan'],
    async execute(_ctx: ToolContext, _input: ToolInput) {
        planModeActive = true;
        return {
            callId: '', success: true, filesModified: [],
            output: "Orchestrator is now in PRE-EXECUTION PLANNING MODE. Destructive actions are disabled. Use ExitPlanModeTool once you have created a solid implementation plan.",
            duration_ms: 0
        };
    }
});

// ── ExitPlanModeTool ────────────────────────────────────────────────

registerTool({
    name: 'ExitPlanModeTool',
    description: "Exit planning mode and unlock destructive tools (FileEdit, Bash) to begin executing your plan.",
    parameters: { type: 'object', properties: {}, required: [] },
    access: ['plan'],
    async execute(_ctx: ToolContext, _input: ToolInput) {
        planModeActive = false;
        return {
            callId: '', success: true, filesModified: [],
            output: "Orchestrator is now in EXECUTION MODE. Destructive tools are unlocked and ready.",
            duration_ms: 0
        };
    }
});
