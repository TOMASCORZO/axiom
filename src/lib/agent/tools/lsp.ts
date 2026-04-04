/**
 * LSP Tools — Language Server Protocol integration as agent tools.
 *
 * OpenCode tools: lsp.ts
 * Exposes the LSP client as tools the agent can invoke for
 * go-to-definition, find-references, hover info, and diagnostics.
 */

import { registerTool, type ToolContext, type ToolInput } from './registry';
import { lspManager } from '../../lsp';

// ── lsp_diagnostics: Get diagnostics for a file ────────────────────

registerTool({
    name: 'lsp_diagnostics',
    description: 'Get type errors, lint warnings, and diagnostics for a file from the language server. Start the LSP server first with lsp_start.',
    parameters: {
        type: 'object',
        properties: {
            language: { type: 'string', description: 'Language server to query (typescript, python)' },
            uri: { type: 'string', description: 'File URI (e.g. file:///path/to/file.ts)' },
        },
        required: ['language', 'uri'],
    },
    access: ['build', 'plan', 'explore'],
    async execute(ctx: ToolContext, input: ToolInput) {
        const status = lspManager.status();
        const lang = input.language as string;
        const server = status.find(s => s.language === lang);

        if (!server || server.status !== 'ready') {
            return {
                success: false,
                output: null,
                error: `LSP server for "${lang}" is not running. Use lsp_start first.`,
                duration_ms: 0,
            };
        }

        return {
            success: true,
            output: { language: lang, uri: input.uri, hint: 'Diagnostics are pushed asynchronously by the LSP server.' },
            duration_ms: 0,
        };
    },
});

// ── lsp_definition: Go to definition ────────────────────────────────

registerTool({
    name: 'lsp_definition',
    description: 'Find the definition of a symbol at a specific position in a file.',
    parameters: {
        type: 'object',
        properties: {
            language: { type: 'string', description: 'Language server (typescript, python)' },
            uri: { type: 'string', description: 'File URI' },
            line: { type: 'number', description: 'Line number (0-indexed)' },
            character: { type: 'number', description: 'Column number (0-indexed)' },
        },
        required: ['language', 'uri', 'line', 'character'],
    },
    access: ['build', 'plan', 'explore'],
    async execute(ctx: ToolContext, input: ToolInput) {
        try {
            const locations = await lspManager.definition(
                input.language as string,
                input.uri as string,
                input.line as number,
                input.character as number,
            );
            return {
                success: true,
                output: { locations, count: locations.length },
                duration_ms: 0,
            };
        } catch (err) {
            return {
                success: false,
                output: null,
                error: err instanceof Error ? err.message : 'LSP error',
                duration_ms: 0,
            };
        }
    },
});

// ── lsp_references: Find all references ─────────────────────────────

registerTool({
    name: 'lsp_references',
    description: 'Find all references to a symbol at a specific position in a file.',
    parameters: {
        type: 'object',
        properties: {
            language: { type: 'string', description: 'Language server (typescript, python)' },
            uri: { type: 'string', description: 'File URI' },
            line: { type: 'number', description: 'Line number (0-indexed)' },
            character: { type: 'number', description: 'Column number (0-indexed)' },
        },
        required: ['language', 'uri', 'line', 'character'],
    },
    access: ['build', 'plan', 'explore'],
    async execute(ctx: ToolContext, input: ToolInput) {
        try {
            const locations = await lspManager.references(
                input.language as string,
                input.uri as string,
                input.line as number,
                input.character as number,
            );
            return {
                success: true,
                output: { locations, count: locations.length },
                duration_ms: 0,
            };
        } catch (err) {
            return {
                success: false,
                output: null,
                error: err instanceof Error ? err.message : 'LSP error',
                duration_ms: 0,
            };
        }
    },
});

// ── lsp_hover: Get hover info ───────────────────────────────────────

registerTool({
    name: 'lsp_hover',
    description: 'Get type information and documentation for a symbol at a position.',
    parameters: {
        type: 'object',
        properties: {
            language: { type: 'string', description: 'Language server (typescript, python)' },
            uri: { type: 'string', description: 'File URI' },
            line: { type: 'number', description: 'Line number (0-indexed)' },
            character: { type: 'number', description: 'Column number (0-indexed)' },
        },
        required: ['language', 'uri', 'line', 'character'],
    },
    access: ['build', 'plan', 'explore'],
    async execute(ctx: ToolContext, input: ToolInput) {
        try {
            const result = await lspManager.hover(
                input.language as string,
                input.uri as string,
                input.line as number,
                input.character as number,
            );
            return {
                success: true,
                output: result,
                duration_ms: 0,
            };
        } catch (err) {
            return {
                success: false,
                output: null,
                error: err instanceof Error ? err.message : 'LSP error',
                duration_ms: 0,
            };
        }
    },
});

// ── lsp_start: Start a language server ──────────────────────────────

registerTool({
    name: 'lsp_start',
    description: 'Start a language server for IDE-level code intelligence (typescript, python).',
    parameters: {
        type: 'object',
        properties: {
            language: { type: 'string', description: 'Language to start (typescript, python)' },
            rootUri: { type: 'string', description: 'Project root path' },
        },
        required: ['language', 'rootUri'],
    },
    access: ['build'],
    async execute(ctx: ToolContext, input: ToolInput) {
        const success = await lspManager.start(
            input.language as string,
            { rootUri: input.rootUri as string },
        );
        return {
            success,
            output: success
                ? { message: `LSP server for ${input.language} started successfully.` }
                : null,
            error: success ? undefined : `Failed to start LSP server for ${input.language}`,
            duration_ms: 0,
        };
    },
});
