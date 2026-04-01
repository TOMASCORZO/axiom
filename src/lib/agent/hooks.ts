/**
 * Hook System — Pre/post tool execution hooks.
 * Ported from Claude Code's hook architecture.
 *
 * Hooks can:
 * - Block a tool call (pre-hook returns { block: true, reason })
 * - Modify tool input (pre-hook returns { updatedInput })
 * - React to tool results (post-hook for logging, side effects)
 * - Run on session start / compact events
 */

export type HookEvent =
    | 'pre_tool_use'
    | 'post_tool_use'
    | 'pre_compact'
    | 'post_compact'
    | 'session_start';

export interface PreToolHookResult {
    /** If true, the tool call is blocked and the reason is returned as an error */
    block?: boolean;
    reason?: string;
    /** If set, replaces the tool input */
    updatedInput?: Record<string, unknown>;
}

export interface PostToolHookResult {
    /** Optional message to inject into the conversation */
    systemNote?: string;
}

export type PreToolHook = (
    toolName: string,
    input: Record<string, unknown>,
    context: { projectId: string; userId: string }
) => Promise<PreToolHookResult | null>;

export type PostToolHook = (
    toolName: string,
    input: Record<string, unknown>,
    result: { success: boolean; output: any; error?: string },
    context: { projectId: string; userId: string }
) => Promise<PostToolHookResult | null>;

export type LifecycleHook = (
    context: { projectId: string; userId: string }
) => Promise<void>;

interface HookRegistry {
    preToolUse: Array<{ name: string; matcher: string | RegExp | '*'; hook: PreToolHook }>;
    postToolUse: Array<{ name: string; matcher: string | RegExp | '*'; hook: PostToolHook }>;
    preCompact: LifecycleHook[];
    postCompact: LifecycleHook[];
    sessionStart: LifecycleHook[];
}

const registry: HookRegistry = {
    preToolUse: [],
    postToolUse: [],
    preCompact: [],
    postCompact: [],
    sessionStart: [],
};

function matchesTool(matcher: string | RegExp | '*', toolName: string): boolean {
    if (matcher === '*') return true;
    if (typeof matcher === 'string') return toolName === matcher;
    return matcher.test(toolName);
}

// ── Registration API ────────────────────────────────────────────────

export function onPreToolUse(name: string, matcher: string | RegExp | '*', hook: PreToolHook) {
    registry.preToolUse.push({ name, matcher, hook });
}

export function onPostToolUse(name: string, matcher: string | RegExp | '*', hook: PostToolHook) {
    registry.postToolUse.push({ name, matcher, hook });
}

export function onPreCompact(hook: LifecycleHook) {
    registry.preCompact.push(hook);
}

export function onPostCompact(hook: LifecycleHook) {
    registry.postCompact.push(hook);
}

export function onSessionStart(hook: LifecycleHook) {
    registry.sessionStart.push(hook);
}

// ── Execution API ───────────────────────────────────────────────────

export async function runPreToolHooks(
    toolName: string,
    input: Record<string, unknown>,
    context: { projectId: string; userId: string }
): Promise<{ blocked: boolean; reason?: string; finalInput: Record<string, unknown> }> {
    let currentInput = { ...input };

    for (const entry of registry.preToolUse) {
        if (!matchesTool(entry.matcher, toolName)) continue;
        try {
            const result = await entry.hook(toolName, currentInput, context);
            if (result?.block) {
                return { blocked: true, reason: result.reason ?? `Blocked by hook: ${entry.name}`, finalInput: currentInput };
            }
            if (result?.updatedInput) {
                currentInput = result.updatedInput;
            }
        } catch (err) {
            console.warn(`[Hooks] Pre-tool hook "${entry.name}" threw:`, err);
        }
    }

    return { blocked: false, finalInput: currentInput };
}

export async function runPostToolHooks(
    toolName: string,
    input: Record<string, unknown>,
    result: { success: boolean; output: any; error?: string },
    context: { projectId: string; userId: string }
): Promise<string | null> {
    let systemNote: string | null = null;

    for (const entry of registry.postToolUse) {
        if (!matchesTool(entry.matcher, toolName)) continue;
        try {
            const hookResult = await entry.hook(toolName, input, result, context);
            if (hookResult?.systemNote) {
                systemNote = (systemNote ?? '') + '\n' + hookResult.systemNote;
            }
        } catch (err) {
            console.warn(`[Hooks] Post-tool hook "${entry.name}" threw:`, err);
        }
    }

    return systemNote;
}

export async function runLifecycleHooks(event: 'preCompact' | 'postCompact' | 'sessionStart', context: { projectId: string; userId: string }) {
    const hooks = registry[event];
    for (const hook of hooks) {
        try {
            await hook(context);
        } catch (err) {
            console.warn(`[Hooks] Lifecycle hook "${event}" threw:`, err);
        }
    }
}

export function clearHooks() {
    registry.preToolUse.length = 0;
    registry.postToolUse.length = 0;
    registry.preCompact.length = 0;
    registry.postCompact.length = 0;
    registry.sessionStart.length = 0;
}
