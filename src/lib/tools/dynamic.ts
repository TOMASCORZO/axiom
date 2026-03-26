/**
 * Dynamic Tool Loader — Runtime tool discovery and registration.
 *
 * OpenCode pattern: Scan local directories for custom tool definitions
 * (JS/TS files) and dynamically import + register them into the agent's
 * tool registry at startup. Users can extend the agent without modifying
 * core code.
 *
 * Scan directories (in order):
 * 1. Project-local: .axiom/tools/
 * 2. User-global:   ~/.axiom/tools/
 *
 * Each tool file must export a default object matching ToolDef interface.
 *
 * Usage:
 *   import { scanAndRegisterTools } from '@/lib/tools/dynamic';
 *
 *   const count = await scanAndRegisterTools('/path/to/project');
 *   console.log(`Loaded ${count} custom tools`);
 */

import { readdirSync, existsSync, statSync } from 'fs';
import { join, extname, basename } from 'path';
import { homedir } from 'os';
import { registerTool, type ToolDef } from '../agent/tools/registry';
import { bus } from '../bus';

// ── Configuration ───────────────────────────────────────────────────

/** Directories to scan for custom tools (relative to project root) */
const PROJECT_TOOLS_DIR = '.axiom/tools';

/** Global user tools directory */
const USER_TOOLS_DIR = join(homedir(), '.axiom', 'tools');

/** Allowed file extensions for tool definitions */
const ALLOWED_EXTENSIONS = new Set(['.ts', '.js', '.mjs']);

// ── Scanner ─────────────────────────────────────────────────────────

/**
 * Scan directories for custom tool files and register them.
 * Returns the number of tools successfully loaded.
 */
export async function scanAndRegisterTools(projectRoot?: string): Promise<number> {
    const dirs: string[] = [];

    // Project-local tools
    if (projectRoot) {
        const projectToolsPath = join(projectRoot, PROJECT_TOOLS_DIR);
        dirs.push(projectToolsPath);
    }

    // Global user tools
    dirs.push(USER_TOOLS_DIR);

    let loaded = 0;

    for (const dir of dirs) {
        if (!existsSync(dir) || !statSync(dir).isDirectory()) {
            continue;
        }

        const files = listToolFiles(dir);

        for (const filePath of files) {
            try {
                const toolDef = await loadToolFile(filePath);
                if (toolDef) {
                    // Prefix custom tools to avoid name collisions
                    const prefixed: ToolDef = {
                        ...toolDef,
                        name: toolDef.name.startsWith('custom_') ? toolDef.name : `custom_${toolDef.name}`,
                    };
                    registerTool(prefixed);
                    loaded++;

                    bus.emit('tool.start', {
                        toolName: `dynamic:${prefixed.name}`,
                        input: { source: filePath },
                    });
                }
            } catch (err) {
                console.error(`[DynamicTools] Failed to load ${filePath}:`, err);
            }
        }
    }

    if (loaded > 0) {
        console.log(`[DynamicTools] Loaded ${loaded} custom tool(s)`);
    }

    return loaded;
}

/**
 * List all tool files in a directory (non-recursive).
 */
function listToolFiles(dir: string): string[] {
    try {
        return readdirSync(dir)
            .filter(f => ALLOWED_EXTENSIONS.has(extname(f)))
            .filter(f => !f.startsWith('_') && !f.startsWith('.'))
            .map(f => join(dir, f));
    } catch {
        return [];
    }
}

/**
 * Load and validate a single tool file.
 * The file must export a default object matching ToolDef.
 */
async function loadToolFile(filePath: string): Promise<ToolDef | null> {
    try {
        // Dynamic import
        const module = await import(filePath);
        const toolDef = module.default || module;

        // Validate required fields
        if (!toolDef.name || typeof toolDef.name !== 'string') {
            console.warn(`[DynamicTools] ${basename(filePath)}: missing or invalid 'name'`);
            return null;
        }

        if (!toolDef.execute || typeof toolDef.execute !== 'function') {
            console.warn(`[DynamicTools] ${basename(filePath)}: missing 'execute' function`);
            return null;
        }

        // Apply defaults
        return {
            name: toolDef.name,
            description: toolDef.description ?? `Custom tool: ${toolDef.name}`,
            parameters: toolDef.parameters ?? {},
            access: toolDef.access ?? ['build'],
            requiresApproval: toolDef.requiresApproval ?? false,
            permissionPatterns: toolDef.permissionPatterns ?? [],
            execute: toolDef.execute,
        };
    } catch (err) {
        console.error(`[DynamicTools] Import failed for ${filePath}:`, err);
        return null;
    }
}

/**
 * Get the paths that would be scanned for tools.
 * Useful for debugging and UI display.
 */
export function getToolScanPaths(projectRoot?: string): string[] {
    const paths: string[] = [];
    if (projectRoot) {
        paths.push(join(projectRoot, PROJECT_TOOLS_DIR));
    }
    paths.push(USER_TOOLS_DIR);
    return paths;
}
