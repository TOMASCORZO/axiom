/**
 * Context Gathering
 * Parses local system and project information to grant the agent 
 * immediate situational awareness without requiring explicit tool calls.
 * Ported from Claude Code's context.ts
 */

import { execSync } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

export interface SystemContext {
    osName: string;
    cwd: string;
    gitStatus: string;
    gitBranch: string;
    packageDependencies: string;
}

function safeExec(cmd: string, cwd: string): string {
    try {
        return execSync(cmd, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
    } catch {
        return '';
    }
}

export function gatherSystemContext(workspaceDir: string): SystemContext {
    const osName = os.type() + " " + os.release() + " (" + os.arch() + ")";
    
    // Git Context
    const gitBranch = safeExec('git rev-parse --abbrev-ref HEAD', workspaceDir) || 'Not a git repository';
    const gitStatusRaw = safeExec('git status --short', workspaceDir);
    const gitStatus = gitStatusRaw ? gitStatusRaw : 'Clean working directory';
    
    // Dependencies
    let packageDependencies = 'No package.json found';
    try {
        const pkgPath = path.join(workspaceDir, 'package.json');
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
            const depNames = Object.keys(deps);
            packageDependencies = depNames.length > 0 
                ? "Found " + depNames.length + " dependencies including: " + depNames.slice(0, 5).join(', ') + "..."
                : 'package.json found but no dependencies listed';
        }
    } catch (err) {
        packageDependencies = 'Error parsing package.json';
    }

    return {
        osName,
        cwd: workspaceDir,
        gitBranch,
        gitStatus,
        packageDependencies
    };
}

/**
 * Compiles the context into a dense string to be injected into the system prompt.
 */
export function buildContextPrompt(workspaceDir: string): string {
    const ctx = gatherSystemContext(workspaceDir);
    return [
        "<system_context>",
        "OS: " + ctx.osName,
        "Working Directory: " + ctx.cwd,
        "Git Branch: " + ctx.gitBranch,
        "Git Status:",
        ctx.gitStatus,
        "Project Dependencies: " + ctx.packageDependencies,
        "</system_context>"
    ].join("\\n");
}
