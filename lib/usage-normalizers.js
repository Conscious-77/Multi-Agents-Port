function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function safeJson(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch (error) {
    return JSON.stringify({ stringify_error: error.message });
  }
}

export function normalizeGeminiUsage(payload = {}) {
  const usage = payload.usageMetadata || payload.usage_metadata || {};
  const inputTokens = toNumber(usage.promptTokenCount || usage.prompt_token_count);
  const outputTokens = toNumber(usage.candidatesTokenCount || usage.candidates_token_count);
  const cachedInputTokens = toNumber(usage.cachedContentTokenCount || usage.cached_content_token_count);
  const reasoningTokens = toNumber(usage.thoughtsTokenCount || usage.thoughts_token_count);
  const toolUsePromptTokens = toNumber(usage.toolUsePromptTokenCount || usage.tool_use_prompt_token_count);
  const totalTokens = toNumber(usage.totalTokenCount || usage.total_token_count)
    || inputTokens + outputTokens + cachedInputTokens + reasoningTokens + toolUsePromptTokens;

  return {
    provider: 'gemini',
    model: payload.modelVersion || payload.model || 'unknown',
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    cached_input_tokens: cachedInputTokens,
    cache_miss_tokens: 0,
    reasoning_tokens: reasoningTokens,
    raw_usage_json: safeJson(usage),
  };
}

export function normalizeOpenAIUsage(payload = {}, fallbackModel, provider = 'openai') {
  // Chat Completions uses usage; Responses streaming completes with response.usage.
  const usage = payload.usage || payload.response?.usage || {};
  const inputDetails = usage.input_tokens_details || usage.prompt_tokens_details || {};
  const outputDetails = usage.output_tokens_details || usage.completion_tokens_details || {};
  const inputTokens = toNumber(usage.input_tokens || usage.prompt_tokens);
  const outputTokens = toNumber(usage.output_tokens || usage.completion_tokens);
  const totalTokens = toNumber(usage.total_tokens) || inputTokens + outputTokens;

  return {
    provider,
    model: payload.model || payload.response?.model || fallbackModel || 'unknown',
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    cached_input_tokens: toNumber(inputDetails.cached_tokens),
    cache_miss_tokens: 0,
    reasoning_tokens: toNumber(outputDetails.reasoning_tokens),
    raw_usage_json: safeJson(usage),
  };
}

export function normalizeAnthropicCompatibleUsage(payload = {}, fallbackModel, provider = 'anthropic') {
  const usage = payload.usage || payload.message?.usage || {};
  const inputTokens = toNumber(usage.input_tokens);
  const outputTokens = toNumber(usage.output_tokens);
  const cacheCreationTokens = toNumber(usage.cache_creation_input_tokens);
  const cacheReadTokens = toNumber(usage.cache_read_input_tokens);
  const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;

  return {
    provider,
    model: payload.model || payload.message?.model || fallbackModel || 'unknown',
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    cached_input_tokens: cacheReadTokens,
    cache_miss_tokens: cacheCreationTokens,
    reasoning_tokens: 0,
    raw_usage_json: safeJson(usage),
  };
}

export function normalizeDeepSeekUsage(payload = {}, fallbackModel) {
  const usage = payload.usage || {};
  const inputTokens = toNumber(usage.prompt_tokens);
  const outputTokens = toNumber(usage.completion_tokens);

  return {
    provider: 'deepseek',
    model: payload.model || fallbackModel || 'unknown',
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: toNumber(usage.total_tokens) || inputTokens + outputTokens,
    cached_input_tokens: toNumber(usage.prompt_cache_hit_tokens),
    cache_miss_tokens: toNumber(usage.prompt_cache_miss_tokens),
    reasoning_tokens: 0,
    raw_usage_json: safeJson(usage),
  };
}

export function normalizeArkUsage(payload = {}, fallbackModel, provider = 'volcengine') {
  const usage = payload.usage || {};
  const promptDetails = usage.prompt_tokens_details || {};
  const completionDetails = usage.completion_tokens_details || {};
  const inputTokens = toNumber(usage.prompt_tokens);
  const outputTokens = toNumber(usage.completion_tokens);

  return {
    provider,
    model: payload.model || fallbackModel || 'unknown',
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: toNumber(usage.total_tokens) || inputTokens + outputTokens,
    cached_input_tokens: toNumber(promptDetails.cached_tokens),
    cache_miss_tokens: 0,
    reasoning_tokens: toNumber(completionDetails.reasoning_tokens),
    raw_usage_json: safeJson(usage),
  };
}

export function normalizeUsageByProvider(provider, payload = {}, fallbackModel) {
  const normalizedProvider = (provider || '').toLowerCase();

  switch (normalizedProvider) {
    case 'gemini':
      return normalizeGeminiUsage(payload);
    case 'gpt-micu':
    case 'micu-gpt':
      return normalizeOpenAIUsage(payload, fallbackModel, 'gpt-micu');
    case 'claude-code-micu':
      return normalizeAnthropicCompatibleUsage(payload, fallbackModel, 'claude-code-micu');
    case 'claude-micu':
    case 'micu-claude':
      return normalizeOpenAIUsage(payload, fallbackModel, 'claude-micu');
    case 'openai':
    case 'gpt':
      return normalizeOpenAIUsage(payload, fallbackModel, 'openai');
    case 'deepseek':
    case 'deepseek_volcengine':
      return normalizeDeepSeekUsage(payload, fallbackModel);
    case 'volcengine':
    case 'ark':
      return normalizeArkUsage(payload, fallbackModel, 'volcengine');
    case 'doubao':
      return normalizeArkUsage(payload, fallbackModel, 'doubao');
    default:
      return {
        provider: provider || 'unknown',
        model: payload?.model || fallbackModel || 'unknown',
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        cached_input_tokens: 0,
        cache_miss_tokens: 0,
        reasoning_tokens: 0,
        raw_usage_json: safeJson(payload?.usage || payload?.usageMetadata || payload?.usage_metadata || {}),
      };
  }
}
