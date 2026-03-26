import { OpenAICompatAdapter } from './openai-compat';

export class OpenAIAdapter extends OpenAICompatAdapter {
    readonly id = 'gpt';
    readonly label = 'GPT-5.4';
    readonly color = 'green';
    readonly model = 'gpt-5.4';
    readonly baseUrl = 'https://api.openai.com/v1';
}
