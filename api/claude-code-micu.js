import { normalizeUsageByProvider } from '../lib/usage-normalizers.js';
import { createUsageRecord, getUsageSnapshot, writeUsageRecord } from '../lib/stats-writer.js';

const TARGET_BASE_URL = 'https://www.micuapi.ai';

// Dedicated Claude Code compatible Micu endpoint, with the same usage writer.
function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function getHeader(request, name) {
  const headers = request?.headers || {};
  if (typeof headers.get === 'function') {
    return headers.get(name) || headers.get(name.toLowerCase()) || headers.get(name.toUpperCase()) || '';
  }

  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || '';
}

function setHeader(headers, name, value) {
  if (value === undefined || value === null || value === '') return;
  headers[name] = value;
}

function pathFromRequestUrl(url) {
  const prefix = '/api/claude-code-micu/';
  if (!url.pathname.startsWith(prefix)) return '';
  return url.pathname.slice(prefix.length);
}

function buildTargetUrl(request) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const requestPath = url.searchParams.get('path') || pathFromRequestUrl(url) || 'v1/messages';
  const normalizedPath = `/${requestPath.replace(/^\/+/, '')}`;
  const forwardedSearchParams = new URLSearchParams(url.searchParams);
  forwardedSearchParams.delete('path');
  forwardedSearchParams.delete('stats');
  const queryString = forwardedSearchParams.toString();

  return {
    requestPath,
    targetUrl: `${TARGET_BASE_URL}${normalizedPath}${queryString ? `?${queryString}` : ''}`,
  };
}

function buildForwardHeaders(request) {
  const headers = {};
  setHeader(headers, 'Content-Type', getHeader(request, 'content-type') || 'application/json');
  setHeader(headers, 'Accept', getHeader(request, 'accept'));
  setHeader(headers, 'User-Agent', getHeader(request, 'user-agent') || 'Claude-Code');
  setHeader(headers, 'anthropic-version', getHeader(request, 'anthropic-version') || '2023-06-01');
  setHeader(headers, 'anthropic-beta', getHeader(request, 'anthropic-beta'));
  setHeader(headers, 'anthropic_version', getHeader(request, 'anthropic_version'));
  setHeader(headers, 'anthropic_beta', getHeader(request, 'anthropic_beta'));

  const upstreamApiKey = process.env.CLAUDE_MICU_PROXY_API_KEY || process.env.CLAUDE_MICU_API_KEY;
  const clientApiKey = getHeader(request, 'x-api-key');
  const authorization = getHeader(request, 'authorization');
  const apiKey = upstreamApiKey || clientApiKey;

  if (apiKey) {
    setHeader(headers, 'Authorization', `Bearer ${apiKey}`);
  } else if (authorization) {
    setHeader(headers, 'Authorization', authorization);
  }
  if (apiKey) {
    setHeader(headers, 'x-api-key', apiKey);
  }

  return headers;
}

function extractModelFromBody(body) {
  return body?.model || body?.model_name || 'unknown';
}

function shouldSendBody(method) {
  return !['GET', 'HEAD'].includes(String(method || '').toUpperCase());
}

function collectJsonObjectsFromStreamingText(text) {
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

function selectUsagePayload(chunks, fallbackModel) {
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    if (chunks[index]?.usage) {
      return chunks[index];
    }
  }

  return chunks[chunks.length - 1] || { model: fallbackModel };
}

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

function normalizeErrorCode(errorValue) {
  if (!errorValue) return 'upstream_error';
  if (typeof errorValue === 'string') return errorValue;
  if (typeof errorValue.code === 'string') return errorValue.code;
  if (typeof errorValue.status === 'string') return errorValue.status;
  return 'upstream_error';
}

export default async function handler(request, response) {
  const { searchParams } = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (String(request.method || '').toUpperCase() === 'HEAD') {
    return response.status(200).end();
  }

  if (searchParams.get('stats') === '1') {
    return response.status(200).json(getUsageSnapshot());
  }

  const body = request.body || {};
  const { requestPath, targetUrl } = buildTargetUrl(request);
  const modelFallback = extractModelFromBody(body);

  try {
    const method = request.method || 'POST';
    const fetchOptions = {
      method,
      headers: buildForwardHeaders(request),
    };

    if (shouldSendBody(method)) {
      fetchOptions.body = typeof request.body === 'string'
        ? request.body
        : JSON.stringify(body);
    }

    const apiResponse = await fetch(targetUrl, fetchOptions);

    if (body.stream === true) {
      return streamResponseWithStats(apiResponse, response, async (streamText) => {
        const chunks = collectJsonObjectsFromStreamingText(streamText);
        const usagePayload = selectUsagePayload(chunks, modelFallback);
        const normalizedUsage = normalizeUsageByProvider('claude-code-micu', usagePayload, modelFallback);
        await writeUsageRecord(createUsageRecord({
          request,
          normalizedUsage,
          requestPath,
          isStreaming: true,
          success: apiResponse.ok,
          statusCode: apiResponse.status,
          errorCode: apiResponse.ok ? null : 'upstream_stream_error',
        }));
      });
    }

    const data = await apiResponse.json();
    const normalizedUsage = normalizeUsageByProvider('claude-code-micu', data, modelFallback);
    await writeUsageRecord(createUsageRecord({
      request,
      normalizedUsage,
      requestPath,
      isStreaming: false,
      success: apiResponse.ok,
      statusCode: apiResponse.status,
      errorCode: apiResponse.ok ? null : normalizeErrorCode(data?.error),
    }));

    return response.status(apiResponse.status).json(data);
  } catch (error) {
    console.error('Claude Code Micu Proxy Error:', error);
    const normalizedUsage = normalizeUsageByProvider('claude-code-micu', {
      model: modelFallback,
      usage: {},
    }, modelFallback);
    await writeUsageRecord(createUsageRecord({
      request,
      normalizedUsage,
      requestPath,
      isStreaming: Boolean(body.stream),
      success: false,
      statusCode: 500,
      errorCode: 'internal_proxy_error',
    }));

    return response.status(500).json({ error: 'Internal Server Error' });
  }
}
