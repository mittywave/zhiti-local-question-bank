import { openAiBody } from './openai';
import type { AdapterContext, Json } from './types';
/** Official contracts checked 2026-09-26. Catalog IDs/capabilities are not presets. */
export function deepSeekBody(protocol: 'responses' | 'chat_completions', ctx: AdapterContext): Json {
    const body = openAiBody(protocol, ctx);
    if (protocol === 'chat_completions') {
        // DeepSeek Chat JSON Output is not OpenAI strict structured output.
        delete body.max_completion_tokens;
        body.max_tokens = ctx.input.maxTokens || 32768;
        if (ctx.options.format !== 'prompt')
            body.response_format = { type: 'json_object' };
        if (ctx.options.reasoning && ctx.provider.reasoningEffort) {
            body.thinking = { type: ctx.provider.reasoningEffort === 'none' ? 'disabled' : 'enabled' };
            if (ctx.provider.reasoningEffort === 'none')
                delete body.reasoning_effort;
        }
    }
    else {
        // Stateless DeepSeek Responses does not inherit every OpenAI optional field.
        delete body.store;
        if (ctx.options.format === 'schema')
            body.text = { format: { type: 'json_schema', name: ctx.input.schemaName, schema: ctx.input.schema } };
    }
    return body;
}
