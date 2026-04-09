async function streamResponse(apiResponse, clientResponse) {
  clientResponse.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  clientResponse.setHeader('Cache-Control', 'no-cache');
  clientResponse.setHeader('Connection', 'keep-alive');

  const reader = apiResponse.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    clientResponse.write(value);
  }
  clientResponse.end();
}

async function proxyJsonRequest(apiUrl, headers, body, response, isStreaming, errorLabel) {
  try {
    const apiResponse = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (isStreaming) {
      return streamResponse(apiResponse, response);
    }

    const data = await apiResponse.json();
    return response.status(apiResponse.status).json(data);
  } catch (error) {
    console.error(`${errorLabel} Proxy Error:`, error);
    return response.status(500).json({ error: 'Internal Server Error' });
  }
}

function buildAnthropicCompatibleUrl(baseUrl, path) {
  const normalizedBaseUrl = (baseUrl || '').replace(/\/+$/, '');
  const normalizedPath = `/${(path || 'v1/messages').replace(/^\/+/, '')}`;
  return `${normalizedBaseUrl}${normalizedPath}`;
}

export default async function handler(request, response) {
  const body = request.body || {};
  const { searchParams } = new URL(request.url, `http://${request.headers.host}`);
  const provider = (searchParams.get('provider') || 'gemini').toLowerCase();
  let path = searchParams.get('path');
  const isStreaming = body.stream === true;

  // Claude 路由...
  if (provider === 'claude') {
    const claudeApiUrl = 'https://api.anthropic.com/v1/messages';
    return proxyJsonRequest(
      claudeApiUrl,
      {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body,
      response,
      isStreaming,
      'Claude',
    );
  }

  // Anthropic 兼容路由，保留旧 Claude 官方直连方式
  if (provider === 'anthropic' || provider === 'claude-compatible') {
    if (!process.env.ANTHROPIC_BASE_URL) {
      return response.status(500).json({ error: "Missing 'ANTHROPIC_BASE_URL' environment variable" });
    }

    const anthropicApiUrl = buildAnthropicCompatibleUrl(process.env.ANTHROPIC_BASE_URL, path);
    return proxyJsonRequest(
      anthropicApiUrl,
      {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY,
        'anthropic-version': process.env.ANTHROPIC_VERSION || '2023-06-01',
      },
      body,
      response,
      isStreaming,
      'Anthropic Compatible',
    );
  }

  // OpenAI 路由...
  if (provider === 'openai') {
    if (!path) return response.status(400).json({ error: "Missing 'path' parameter" });
    const openaiApiUrl = `https://api.openai.com/v1/${path}`;
    return proxyJsonRequest(
      openaiApiUrl,
      {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body,
      response,
      isStreaming,
      'OpenAI',
    );
  }

  // Gemini 路由...
  if (provider === 'gemini') {
    if (!path) return response.status(400).json({ error: "Missing 'path' parameter" });
    const geminiBody = { ...body };
    if (isStreaming) {
      path = path.replace(':generateContent', ':streamGenerateContent');
      delete geminiBody.stream;
    }
    const geminiApiUrl = `https://generativelanguage.googleapis.com/${path}`;
    return proxyJsonRequest(
      geminiApiUrl,
      {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY,
      },
      geminiBody,
      response,
      true,
      'Gemini',
    );
  }

  return response.status(400).json({ error: "Invalid 'provider'." });
}
