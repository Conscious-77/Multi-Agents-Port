function parseJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function getRequestBody(request) {
  if (!request.body) return {};
  if (typeof request.body === 'string') {
    try {
      return JSON.parse(request.body);
    } catch {
      return {};
    }
  }
  return request.body;
}

function makeError(message, statusCode = 500) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeSessionId(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return value;
}

function getLastUserContent(messages = []) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if ((msg?.role || '').toLowerCase() === 'user') return msg.content || '';
  }
  return '';
}

function buildPromptList(messages = []) {
  const promptList = [];
  let pendingQuestion = null;

  for (const msg of messages) {
    const role = (msg?.role || '').toLowerCase();
    const content = msg?.content || '';

    if (role === 'system') continue;

    if (role === 'user') {
      if (pendingQuestion !== null) {
        promptList.push({ question: pendingQuestion, answer: '' });
      }
      pendingQuestion = content;
      continue;
    }

    if (role === 'assistant' && pendingQuestion !== null) {
      promptList.push({ question: pendingQuestion, answer: content });
      pendingQuestion = null;
    }
  }

  return {
    promptList,
    question: pendingQuestion || getLastUserContent(messages),
  };
}

function buildHeaders() {
  if (!process.env.IBRAIN_COOKIE) {
    throw new Error("Missing 'IBRAIN_COOKIE' environment variable");
  }

  return {
    'Accept': '*/*',
    'Content-Type': 'application/json',
    'Origin': process.env.IBRAIN_ORIGIN || 'http://ibrain.qiyi.domain',
    'Referer': process.env.IBRAIN_REFERER || 'http://ibrain.qiyi.domain/explore/chat',
    'User-Agent': process.env.IBRAIN_UA || 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36',
    'Cookie': process.env.IBRAIN_COOKIE,
  };
}

function baseUrl() {
  return (process.env.IBRAIN_BASE_URL || 'http://ibrain.qiyi.domain').replace(/\/+$/, '');
}

function pickUid(body) {
  return (body.uid || body.user || process.env.IBRAIN_UID || '').trim();
}

function pickPid(body) {
  return (body.pid || process.env.IBRAIN_PID || pickUid(body) || '').trim();
}

function pickServiceName(body) {
  return (body.service_name || body.serviceName || process.env.IBRAIN_SERVICE_NAME || 'prompt_console').trim();
}

function pickPromptToken(body) {
  return (body.prompt_token || body.promptToken || process.env.IBRAIN_PROMPT_TOKEN || 'test').trim();
}

function pickFileUrl(body) {
  return body.file_url ?? body.fileUrl ?? process.env.IBRAIN_FILE_URL ?? 'undefined';
}

function pickDocumentId(body) {
  return Number(body.document_id ?? body.documentId ?? process.env.IBRAIN_DOCUMENT_ID ?? -1);
}

function pickDatasetId(body) {
  return Number(body.dataset_id ?? body.datasetId ?? process.env.IBRAIN_DATASET_ID ?? -1);
}

function pickPluginList(body) {
  if (Array.isArray(body.use_function_list)) return body.use_function_list;
  if (Array.isArray(body.useFunctionList)) return body.useFunctionList;
  if (Array.isArray(body.plugins)) return body.plugins;
  return parseJsonEnv('IBRAIN_PLUGIN_STR', ['bing_search']);
}

function pickModel(body) {
  return (body.model || process.env.IBRAIN_MODEL || process.env.OPENAI_DEFAULT_MODEL || 'claude-4.6-opus-qiniu').trim();
}

function shouldForceNewSession(body) {
  return body.new_session === true || body.newSession === true;
}

function shouldAutoCreateSession(body) {
  if (body.auto_session === false || body.autoSession === false) return false;
  return true;
}

async function createSession(body, model) {
  const uid = pickUid(body);
  if (!uid) {
    throw makeError("Missing 'uid' in request and 'IBRAIN_UID' environment variable", 500);
  }
  const params = new URLSearchParams({
    uid,
    title: getLastUserContent(body.messages || []) || 'New Chat',
    file_url: pickFileUrl(body),
    model_name: model,
    document_id: String(pickDocumentId(body)),
    dataset_id: String(pickDatasetId(body)),
    pluginStr: JSON.stringify(pickPluginList(body)),
  });

  const response = await fetch(`${baseUrl()}/session/api/creation_session?${params.toString()}`, {
    method: 'POST',
    headers: buildHeaders(),
    body: '',
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Create session failed: ${JSON.stringify(data)}`);
  }

  if (typeof data?.data === 'number') return data.data;
  if (typeof data?.data === 'string' && /^\d+$/.test(data.data)) return Number(data.data);
  if (typeof data?.data?.session_id === 'number') return data.data.session_id;
  if (typeof data?.data?.sessionId === 'number') return data.data.sessionId;

  throw new Error(`Invalid create session response: ${JSON.stringify(data)}`);
}

async function resolveSession(body) {
  const requestedSessionId = normalizeSessionId(body.session_id ?? body.sessionId);

  if (shouldForceNewSession(body)) {
    return {
      sessionId: await createSession(body, pickModel(body)),
      sessionMode: 'new',
    };
  }

  if (requestedSessionId !== null) {
    return {
      sessionId: requestedSessionId,
      sessionMode: 'existing',
    };
  }

  if (shouldAutoCreateSession(body)) {
    return {
      sessionId: await createSession(body, pickModel(body)),
      sessionMode: 'new',
    };
  }

  throw makeError("Missing 'session_id' when 'auto_session' is false", 400);
}

function buildStreamPayload(body, sessionId) {
  const { promptList, question } = buildPromptList(body.messages || []);
  return {
    prompt_token: pickPromptToken(body),
    question,
    prompt_list: promptList,
    service_name: pickServiceName(body),
    model: pickModel(body),
    model_name: null,
    temperature: body.temperature ?? 1,
    uid: pickUid(body),
    dataset_id: pickDatasetId(body),
    document_id: pickDocumentId(body),
    pid: pickPid(body),
    answer_count: 1,
    not_use_cache: body.not_use_cache ?? body.notUseCache ?? true,
    session_id: sessionId,
    use_function_list: pickPluginList(body),
    enable_think: body.enable_think ?? body.enableThink ?? null,
    response_mode: body.response_mode ?? body.responseMode ?? 2,
  };
}

function streamResponse(apiResponse, clientResponse, sessionId, sessionMode) {
  clientResponse.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  clientResponse.setHeader('Cache-Control', 'no-cache');
  clientResponse.setHeader('Connection', 'keep-alive');
  clientResponse.setHeader('X-Session-Id', String(sessionId));
  clientResponse.setHeader('X-Session-Mode', sessionMode);

  const reader = apiResponse.body.getReader();

  return (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      clientResponse.write(value);
    }
    clientResponse.end();
  })();
}

function extractContentFromChunk(obj) {
  const choices = obj?.choices;
  if (!Array.isArray(choices) || !choices.length) return null;
  const delta = choices[0]?.delta;
  if (!delta || typeof delta !== 'object') return null;
  return typeof delta.content === 'string' ? delta.content : null;
}

async function collectNonStreamText(apiResponse) {
  const reader = apiResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const parts = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    while (buffer.includes('\n')) {
      const idx = buffer.indexOf('\n');
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);

      if (!line || !line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (raw === '[DONE]') continue;

      try {
        const obj = JSON.parse(raw);
        const text = extractContentFromChunk(obj);
        if (text) parts.push(text);
      } catch {
        if (raw) parts.push(raw);
      }
    }
  }

  return parts.join('');
}

export default async function handler(request, response) {
  try {
    const body = getRequestBody(request);
    const isStreaming = body.stream === true;

    if (!pickUid(body)) {
      throw makeError("Missing 'uid' in request and 'IBRAIN_UID' environment variable", 500);
    }

    const { sessionId, sessionMode } = await resolveSession(body);
    const streamPayload = buildStreamPayload(body, sessionId);

    const apiResponse = await fetch(`${baseUrl()}/prompt/api/sync/little-assistant-stream`, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify(streamPayload),
    });

    if (isStreaming) {
      return streamResponse(apiResponse, response, sessionId, sessionMode);
    }

    const text = await collectNonStreamText(apiResponse);
    response.setHeader('X-Session-Id', String(sessionId));
    response.setHeader('X-Session-Mode', sessionMode);
    return response.status(apiResponse.status).json({
      id: `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: pickModel(body),
      session_id: sessionId,
      session_mode: sessionMode,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    });
  } catch (error) {
    console.error('iBrain Route Error:', error);
    const statusCode = error?.statusCode || 500;
    return response.status(statusCode).json({
      error: statusCode >= 500 ? 'Internal Server Error' : 'Bad Request',
      detail: error?.message || String(error),
    });
  }
}
