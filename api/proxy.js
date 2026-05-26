import { normalizeUsageByProvider } from '../lib/usage-normalizers.js';
import { createUsageRecord, getUsageSnapshot, writeUsageRecord } from '../lib/stats-writer.js';

// Production Vercel entry for /api/proxy.
// Keep usage capture here so the public model endpoint always records stats.
async function streamResponseWithStats(apiResponse, clientResponse, onComplete) {
  if (typeof clientResponse.status === 'function') {
    clientResponse.status(apiResponse.status);
  } else {
    clientResponse.statusCode = apiResponse.status;
  }

  clientResponse.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  clientResponse.setHeader('Cache-Control', 'no-cache');
  clientResponse.setHeader('Connection', 'keep-alive');

  const reader = apiResponse.body.getReader();
  const decoder = new TextDecoder();
  let bufferedText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    clientResponse.write(value);
    bufferedText += decoder.decode(value, { stream: true });
  }

  bufferedText += decoder.decode();
  await onComplete(bufferedText);
  clientResponse.end();
}

function makeHttpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function buildAnthropicCompatibleUrl(baseUrl, requestPath) {
  const normalizedBaseUrl = (baseUrl || '').replace(/\/+$/, '');
  const normalizedPath = `/${(requestPath || 'v1/messages').replace(/^\/+/, '')}`;
  return `${normalizedBaseUrl}${normalizedPath}`;
}

function buildCompatibleUrl(baseUrl, requestPath, defaultPath) {
  const normalizedBaseUrl = (baseUrl || '').replace(/\/+$/, '');
  const finalPath = requestPath || defaultPath;
  const normalizedPath = `/${finalPath.replace(/^\/+/, '')}`;
  return `${normalizedBaseUrl}${normalizedPath}`;
}

function normalizeErrorCode(errorValue) {
  if (!errorValue) return 'upstream_error';
  if (typeof errorValue === 'string') return errorValue;
  if (typeof errorValue.code === 'string') return errorValue.code;
  if (typeof errorValue.status === 'string') return errorValue.status;
  return 'upstream_error';
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

export function collectJsonObjectsFromStreamingText(text) {
  const parsedArray = safeJsonParse(text);
  if (Array.isArray(parsedArray)) {
    return parsedArray;
  }

  const objects = [];
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line === 'data: [DONE]') continue;

    const candidate = line.startsWith('data: ')
      ? line.slice('data: '.length)
      : line;

    const parsed = safeJsonParse(candidate);
    if (parsed) {
      objects.push(parsed);
    }
  }

  return objects;
}

function hasUsageMetadata(provider, chunk) {
  if (!chunk || typeof chunk !== 'object') {
    return false;
  }

  if ((provider || '').toLowerCase() === 'gemini') {
    return Boolean(chunk.usageMetadata || chunk.usage_metadata);
  }

  // OpenAI Responses streams report final usage under response.usage.
  return Boolean(chunk.usage || chunk.response?.usage);
}

export function selectUsagePayload(provider, chunks, fallbackPayload = {}) {
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    if (hasUsageMetadata(provider, chunks[index])) {
      return chunks[index];
    }
  }

  return chunks[chunks.length - 1] || fallbackPayload;
}

function withOpenAICompatibleStreamUsage(body, includeUsage = true) {
  if (body.stream !== true || !includeUsage) {
    return body;
  }

  return {
    ...body,
    stream_options: {
      ...(body.stream_options || {}),
      include_usage: true,
    },
  };
}

function shouldTreatAsStreaming(apiResponse, upstream, body) {
  if (body.stream === true) return true;

  const contentType = apiResponse.headers?.get?.('content-type') || '';
  if (contentType.toLowerCase().includes('text/event-stream')) return true;

  return /streamGenerateContent/i.test(upstream.requestPath || '');
}

export function buildUpstreamRequest({ provider, requestPath, body }) {
  if (provider === 'claude') {
    return {
      provider: 'claude',
      modelFallback: body.model,
      apiUrl: 'https://api.anthropic.com/v1/messages',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body,
      requestPath: requestPath || 'v1/messages',
      errorLabel: 'Claude',
    };
  }

  if (provider === 'anthropic' || provider === 'claude-compatible') {
    if (!process.env.ANTHROPIC_BASE_URL) {
      throw makeHttpError("Missing 'ANTHROPIC_BASE_URL' environment variable", 500);
    }

    return {
      provider: 'anthropic',
      modelFallback: body.model,
      apiUrl: buildAnthropicCompatibleUrl(process.env.ANTHROPIC_BASE_URL, requestPath),
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body,
      requestPath: requestPath || 'v1/messages',
      errorLabel: 'Anthropic Compatible',
    };
  }

  if (provider === 'gpt-micu' || provider === 'micu-gpt') {
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'codex_cli_rs/0.77.0 (Windows 10.0.26100; x86_64) WindowsTerminal',
    };
    if (process.env.GPT_MICU_API_KEY) {
      headers.Authorization = `Bearer ${process.env.GPT_MICU_API_KEY}`;
    }

    return {
      provider: 'gpt-micu',
      modelFallback: body.model,
      apiUrl: buildCompatibleUrl('https://www.micuapi.ai', requestPath, 'v1/responses'),
      headers,
      body: withOpenAICompatibleStreamUsage(body),
      requestPath: requestPath || 'v1/responses',
      errorLabel: 'GPT Micu',
    };
  }

  if (provider === 'claude-micu' || provider === 'micu-claude') {
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'codex_cli_rs/0.77.0 (Windows 10.0.26100; x86_64) WindowsTerminal',
    };
    const apiKey = process.env.CLAUDE_MICU_PROXY_API_KEY || process.env.CLAUDE_MICU_API_KEY;
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    return {
      provider: 'claude-micu',
      modelFallback: body.model,
      apiUrl: buildCompatibleUrl('https://www.micuapi.ai', requestPath, 'v1/chat/completions'),
      headers,
      body: withOpenAICompatibleStreamUsage(body, false),
      requestPath: requestPath || 'v1/chat/completions',
      errorLabel: 'Claude Micu',
    };
  }

  if (provider === 'claude-yunwu-float') {
    if (!process.env.CLAUDE_YUNWU_FLOAT_API_KEY) {
      throw makeHttpError("Missing 'CLAUDE_YUNWU_FLOAT_API_KEY' environment variable", 500);
    }

    return {
      provider: 'claude-yunwu-float',
      modelFallback: body.model,
      apiUrl: buildCompatibleUrl('https://yunwu.ai', requestPath, 'v1/chat/completions'),
      headers: {
        Authorization: `Bearer ${process.env.CLAUDE_YUNWU_FLOAT_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: withOpenAICompatibleStreamUsage(body),
      requestPath: requestPath || 'v1/chat/completions',
      errorLabel: 'Claude Yunwu Float',
    };
  }

  if (provider === 'openai') {
    if (!requestPath) {
      throw makeHttpError("Missing 'path' parameter", 400);
    }

    return {
      provider: 'openai',
      modelFallback: body.model,
      apiUrl: `https://api.openai.com/v1/${requestPath}`,
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: withOpenAICompatibleStreamUsage(body),
      requestPath,
      errorLabel: 'OpenAI',
    };
  }

  if (provider === 'deepseek' || provider === 'deepseek_volcengine') {
    if (!process.env.DEEPSEEK_VOLCENGINE_API_KEY) {
      throw makeHttpError("Missing 'DEEPSEEK_VOLCENGINE_API_KEY' environment variable", 500);
    }

    return {
      provider: 'deepseek',
      modelFallback: body.model,
      apiUrl: buildCompatibleUrl('https://ark.cn-beijing.volces.com/api/v3', requestPath, 'chat/completions'),
      headers: {
        Authorization: `Bearer ${process.env.DEEPSEEK_VOLCENGINE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: withOpenAICompatibleStreamUsage(body),
      requestPath: requestPath || 'chat/completions',
      errorLabel: 'DeepSeek Volcengine',
    };
  }

  if (provider === 'volcengine' || provider === 'ark' || provider === 'doubao') {
    if (!process.env.VOLCENGINE_API_KEY) {
      throw makeHttpError("Missing 'VOLCENGINE_API_KEY' environment variable", 500);
    }

    return {
      provider: provider === 'doubao' ? 'doubao' : 'volcengine',
      modelFallback: body.model,
      apiUrl: buildCompatibleUrl('https://ark.cn-beijing.volces.com/api/v3', requestPath, 'chat/completions'),
      headers: {
        Authorization: `Bearer ${process.env.VOLCENGINE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: withOpenAICompatibleStreamUsage(body),
      requestPath: requestPath || 'chat/completions',
      errorLabel: provider === 'doubao' ? 'Doubao Ark' : 'Volcengine',
    };
  }

  if (provider === 'gemini') {
    if (!requestPath) {
      throw makeHttpError("Missing 'path' parameter", 400);
    }

    const geminiBody = { ...body };
    let finalPath = requestPath;
    if (body.stream === true) {
      finalPath = requestPath.replace(':generateContent', ':streamGenerateContent');
      delete geminiBody.stream;
    }

    return {
      provider: 'gemini',
      modelFallback: body.model,
      apiUrl: `https://generativelanguage.googleapis.com/${finalPath}`,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY,
      },
      body: geminiBody,
      requestPath: finalPath,
      errorLabel: 'Gemini',
    };
  }

  throw makeHttpError("Invalid 'provider'.", 400);
}

async function proxyRequestWithStats(request, response) {
  const body = request.body || {};
  const { searchParams } = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const provider = (searchParams.get('provider') || 'gemini').toLowerCase();
  const requestPath = searchParams.get('path');
  let isStreaming = body.stream === true;

  let upstream;
  try {
    upstream = buildUpstreamRequest({ provider, requestPath, body });
  } catch (error) {
    return response.status(error.statusCode || 500).json({ error: error.message });
  }

  try {
    const apiResponse = await fetch(upstream.apiUrl, {
      method: 'POST',
      headers: upstream.headers,
      body: JSON.stringify(upstream.body),
    });

    isStreaming = shouldTreatAsStreaming(apiResponse, upstream, body);

    if (isStreaming) {
      return streamResponseWithStats(apiResponse, response, async (streamText) => {
        const chunks = collectJsonObjectsFromStreamingText(streamText);
        const usagePayload = selectUsagePayload(upstream.provider, chunks, { model: upstream.modelFallback });
        const normalizedUsage = normalizeUsageByProvider(upstream.provider, usagePayload, upstream.modelFallback);
        const usageRecord = createUsageRecord({
          request,
          normalizedUsage,
          requestPath: upstream.requestPath,
          isStreaming: true,
          success: apiResponse.ok,
          statusCode: apiResponse.status,
          errorCode: apiResponse.ok ? null : 'upstream_stream_error',
        });
        await writeUsageRecord(usageRecord);
      });
    }

    const data = await apiResponse.json();
    const normalizedUsage = normalizeUsageByProvider(upstream.provider, data, upstream.modelFallback);
    const usageRecord = createUsageRecord({
      request,
      normalizedUsage,
      requestPath: upstream.requestPath,
      isStreaming: false,
      success: apiResponse.ok,
      statusCode: apiResponse.status,
      errorCode: apiResponse.ok ? null : normalizeErrorCode(data?.error),
    });
    await writeUsageRecord(usageRecord);

    return response.status(apiResponse.status).json(data);
  } catch (error) {
    console.error(`${upstream.errorLabel} Proxy Error:`, error);
    const usageRecord = createUsageRecord({
      request,
      normalizedUsage: {
        provider: upstream.provider,
        model: upstream.modelFallback || 'unknown',
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        cached_input_tokens: 0,
        cache_miss_tokens: 0,
        reasoning_tokens: 0,
        raw_usage_json: JSON.stringify({ error: error.message }),
      },
      requestPath: upstream.requestPath,
      isStreaming,
      success: false,
      statusCode: 500,
      errorCode: 'internal_proxy_error',
    });
    await writeUsageRecord(usageRecord);
    return response.status(500).json({ error: 'Internal Server Error' });
  }
}

export default async function handler(request, response) {
  const { searchParams } = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (searchParams.get('stats') === '1') {
    return response.status(200).json(getUsageSnapshot());
  }

  return proxyRequestWithStats(request, response);
}
