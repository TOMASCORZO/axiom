import type { ProviderTool } from './base';
import { OpenAICompatAdapter } from './openai-compat';

export class MoonshotAdapter extends OpenAICompatAdapter {
    readonly id = 'kimi';
    readonly label = 'Kimi K2.5';
    readonly color = 'blue';
    readonly model = 'kimi-k2.5';
    readonly baseUrl = 'https://api.moonshot.ai/v1';

    protected customizeBody(body: Record<string, unknown>, tools: ProviderTool[]): Record<string, unknown> {
        // Kimi K2.5: thinking mode is incompatible with tool_choice "required"
        // Disable thinking when tools are present
        if (tools.length > 0) {
            body.thinking = { type: 'disabled' };
        }
        return body;
    }
}
