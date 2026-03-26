/**
 * Truncate — Safe output truncation for tool results.
 *
 * Prevents context window exhaustion by enforcing character limits
 * on tool outputs before they are fed back into the LLM message history.
 *
 * OpenCode pattern: Every tool output passes through Truncate.output()
 * automatically, protecting the agent from accidentally reading massive
 * files, minified bundles, or gigabytes of shell output.
 */

/** Default max characters for tool output (~50k chars ≈ ~12k tokens) */
const DEFAULT_MAX_CHARS = 50_000;

/** Absolute minimum to keep output useful */
const MIN_CHARS = 200;

/** Lines to preserve from head and tail when truncating */
const HEAD_LINES = 80;
const TAIL_LINES = 40;

export interface TruncateResult {
    /** The (possibly truncated) content */
    content: string;
    /** Whether truncation was applied */
    truncated: boolean;
    /** Original length in characters */
    originalLength: number;
}

/**
 * Truncate a string output to fit within the context window budget.
 *
 * Strategy:
 * 1. If content fits within maxChars, return as-is
 * 2. Otherwise, keep the first HEAD_LINES and last TAIL_LINES lines
 *    with a clear marker showing what was omitted
 * 3. If even that exceeds the limit, hard-cut at maxChars
 */
export function truncateOutput(
    content: string,
    maxChars: number = DEFAULT_MAX_CHARS,
): TruncateResult {
    if (!content || content.length <= maxChars) {
        return { content, truncated: false, originalLength: content?.length ?? 0 };
    }

    const originalLength = content.length;
    const lines = content.split('\n');

    // If the content has enough lines, use smart head/tail truncation
    if (lines.length > HEAD_LINES + TAIL_LINES + 5) {
        const headSection = lines.slice(0, HEAD_LINES).join('\n');
        const tailSection = lines.slice(-TAIL_LINES).join('\n');
        const omittedLines = lines.length - HEAD_LINES - TAIL_LINES;

        const smartTruncated = [
            headSection,
            '',
            `[... ${omittedLines} lines omitted (${originalLength} chars total, truncated to fit context window) ...]`,
            '',
            tailSection,
        ].join('\n');

        // If smart truncation fits, use it
        if (smartTruncated.length <= maxChars) {
            return { content: smartTruncated, truncated: true, originalLength };
        }
    }

    // Hard truncation: cut at maxChars boundary
    const effectiveMax = Math.max(maxChars, MIN_CHARS);
    const halfBudget = Math.floor(effectiveMax / 2);

    const head = content.slice(0, halfBudget);
    const tail = content.slice(-halfBudget + 200); // Reserve 200 chars for the marker

    const hardTruncated = [
        head,
        `\n\n[... content truncated: ${originalLength} chars total, showing first and last ${halfBudget} chars ...]\n\n`,
        tail,
    ].join('');

    return {
        content: hardTruncated.slice(0, effectiveMax),
        truncated: true,
        originalLength,
    };
}

/**
 * Truncate a tool result's serialized output.
 * This is the main entry point used by the ReAct loop.
 */
export function truncateToolOutput(
    resultJson: string,
    maxChars: number = DEFAULT_MAX_CHARS,
): TruncateResult {
    return truncateOutput(resultJson, maxChars);
}
