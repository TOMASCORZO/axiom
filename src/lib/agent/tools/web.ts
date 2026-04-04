/**
 * Web Navigation Tools — fetch and search the web.
 *
 * OpenCode tools: webfetch.ts, websearch.ts
 * Allows the agent to fetch web pages and search documentation.
 */

import { registerTool, type ToolContext, type ToolInput } from './registry';

// ── webfetch: Fetch a URL and extract text ──────────────────────────

registerTool({
    name: 'webfetch',
    description: 'Fetch a URL and return its text content. Useful for reading documentation, API references, and error pages.',
    parameters: {
        type: 'object',
        properties: {
            url: { type: 'string', description: 'URL to fetch' },
            maxLength: { type: 'number', description: 'Max characters to return (default: 10000)' },
        },
        required: ['url'],
    },
    access: ['build', 'plan', 'explore'],
    async execute(ctx: ToolContext, input: ToolInput) {
        const url = input.url as string;
        const maxLength = input.maxLength as number || 10_000;

        try {
            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'Axiom-Agent/1.0',
                    'Accept': 'text/html,text/plain,application/json',
                },
                signal: AbortSignal.timeout(15_000),
            });

            if (!response.ok) {
                return {
                    success: false,
                    output: null,
                    error: `HTTP ${response.status}: ${response.statusText}`,
                    duration_ms: 0,
                };
            }

            const contentType = response.headers.get('content-type') ?? '';
            let text: string;

            if (contentType.includes('application/json')) {
                const json = await response.json();
                text = JSON.stringify(json, null, 2);
            } else {
                const html = await response.text();
                // Strip HTML tags for readability
                text = html
                    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                    .replace(/<[^>]+>/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();
            }

            if (text.length > maxLength) {
                text = text.slice(0, maxLength) + `\n\n[... truncated at ${maxLength} chars]`;
            }

            return {
                success: true,
                output: { url, contentType, length: text.length, content: text },
                duration_ms: 0,
            };
        } catch (err) {
            return {
                success: false,
                output: null,
                error: err instanceof Error ? err.message : 'Fetch failed',
                duration_ms: 0,
            };
        }
    },
});

// ── websearch: Search the web ───────────────────────────────────────

registerTool({
    name: 'websearch',
    description: 'Search the web for information. Returns search result snippets. Useful for finding documentation, troubleshooting errors, and researching APIs.',
    parameters: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Search query' },
            maxResults: { type: 'number', description: 'Maximum results (default: 5)' },
        },
        required: ['query'],
    },
    access: ['build', 'plan', 'explore'],
    async execute(ctx: ToolContext, input: ToolInput) {
        const query = input.query as string;
        const maxResults = input.maxResults as number || 5;

        // Use DuckDuckGo Instant Answer API (no API key required)
        try {
            const encoded = encodeURIComponent(query);
            const response = await fetch(
                `https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1&skip_disambig=1`,
                { signal: AbortSignal.timeout(10_000) },
            );

            if (!response.ok) {
                return {
                    success: false,
                    output: null,
                    error: `Search API returned ${response.status}`,
                    duration_ms: 0,
                };
            }

            const data = await response.json() as {
                AbstractText?: string;
                AbstractURL?: string;
                AbstractSource?: string;
                RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
            };

            const results: Array<{ title: string; snippet: string; url: string }> = [];

            if (data.AbstractText) {
                results.push({
                    title: data.AbstractSource ?? 'Summary',
                    snippet: data.AbstractText,
                    url: data.AbstractURL ?? '',
                });
            }

            for (const topic of (data.RelatedTopics ?? []).slice(0, maxResults)) {
                if (topic.Text && topic.FirstURL) {
                    results.push({
                        title: topic.Text.split(' - ')[0] ?? topic.Text.slice(0, 60),
                        snippet: topic.Text,
                        url: topic.FirstURL,
                    });
                }
            }

            return {
                success: true,
                output: { query, results: results.slice(0, maxResults), totalResults: results.length },
                duration_ms: 0,
            };
        } catch (err) {
            return {
                success: false,
                output: null,
                error: err instanceof Error ? err.message : 'Search failed',
                duration_ms: 0,
            };
        }
    },
});
