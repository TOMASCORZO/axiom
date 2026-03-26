import { OpenAICompatAdapter } from './openai-compat';

export class DeepSeekAdapter extends OpenAICompatAdapter {
    readonly id = 'deepseek';
    readonly label = 'DeepSeek R1';
    readonly color = 'cyan';
    readonly model = 'deepseek-reasoner';
    readonly baseUrl = 'https://api.deepseek.com/v1';
}
