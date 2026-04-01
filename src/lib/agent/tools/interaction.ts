/**
 * User Interaction Tools
 * 
 * Includes AskUserQuestionTool and BriefTool to facilitate asking clarification 
 * questions and presenting options to the user.
 */

import { registerTool, type ToolContext, type ToolInput } from './registry';

registerTool({
    name: 'AskUserQuestionTool',
    isReadOnly: true,
    isConcurrencySafe: false,
    description: `Asks the user multiple choice questions to gather information, clarify ambiguity, understand preferences, make decisions or offer them choices.

Usage notes:
- Users will always be able to select "Other" to provide custom text input
- Use multiSelect: true to allow multiple answers to be selected for a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label

Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.`,
    parameters: {
        type: 'object',
        properties: {
            question: { type: 'string', description: 'The question to ask the user' },
            options: {
                type: 'array',
                items: { type: 'string' },
                description: 'A list of options to present to the user',
            },
            multiSelect: { type: 'boolean', description: 'Whether the user can select multiple options' },
        },
        required: ['question', 'options'],
    },
    access: ['build', 'plan'],
    async execute(ctx: ToolContext, input: ToolInput) {
        // Return a special formatted output instructing the CLI/Frontend to prompt the user
        // This is caught by the Next.js API route and sent as a special block or interactive element
        return {
            success: true,
            output: {
                __interactive: true,
                type: 'question',
                question: input.question,
                options: input.options,
                multiSelect: input.multiSelect,
                message: `Asked user: ${input.question}`
            },
            duration_ms: 0,
        };
    },
});

registerTool({
    name: 'BriefTool',
    isReadOnly: true,
    isConcurrencySafe: true,
    description: `Creates a briefing or status update for the user.
    
Use this when you want to summarize progress, note an important discovery, or explain a complex change to the user without pausing execution entirely.`,
    parameters: {
        type: 'object',
        properties: {
            message: { type: 'string', description: 'The briefing message to send to the user' },
        },
        required: ['message'],
    },
    access: ['build', 'plan', 'explore'],
    async execute(ctx: ToolContext, input: ToolInput) {
        return {
            success: true,
            output: {
                __interactive: true,
                type: 'brief',
                message: input.message,
            },
            duration_ms: 0,
        };
    },
});
