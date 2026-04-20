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

function buildCompatibleUrl(baseUrl, path, defaultPath) {
  const normalizedBaseUrl = (baseUrl || '').replace(/\/+$/, '');
  const normalizedPath = `/${(path || defaultPath).replace(/^\/+/, '')}`;
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
  // 这是当前默认的 Claude 请求方式
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
        'anthropic-version': '2023-06-01',
      },
      body,
      response,
      isStreaming,
      'Anthropic Compatible',
    );
  }

  // GPT Micu 兼容路由，面向 OpenAI chat completions 接口
  if (provider === 'gpt-micu') {
    if (!process.env.GPT_MICU_BASE_URL) {
      return response.status(500).json({ error: "Missing 'GPT_MICU_BASE_URL' environment variable" });
    }
    if (!process.env.GPT_MICU_API_KEY) {
      return response.status(500).json({ error: "Missing 'GPT_MICU_API_KEY' environment variable" });
    }

    const gptMicuApiUrl = buildCompatibleUrl(
      process.env.GPT_MICU_BASE_URL,
      path,
      'v1/chat/completions',
    );
    return proxyJsonRequest(
      gptMicuApiUrl,
      {
        'Authorization': `Bearer ${process.env.GPT_MICU_API_KEY}`,
        'Content-Type': 'application/json',
        'User-Agent': 'codex_cli_rs/0.77.0 (Windows 10.0.26100; x86_64) WindowsTerminal',
      },
      body,
      response,
      isStreaming,
      'GPT Micu',
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

  // DeepSeek 火山路由，按 DeepSeek 独立配置，底层仍走火山方舟
  if (provider === 'deepseek' || provider === 'deepseek_volcengine') {
    if (!process.env.DEEPSEEK_VOLCENGINE_API_KEY) {
      return response.status(500).json({ error: "Missing 'DEEPSEEK_VOLCENGINE_API_KEY' environment variable" });
    }

    const deepseekApiUrl = buildCompatibleUrl(
      'https://ark.cn-beijing.volces.com/api/v3',
      path,
      'chat/completions',
    );
    return proxyJsonRequest(
      deepseekApiUrl,
      {
        'Authorization': `Bearer ${process.env.DEEPSEEK_VOLCENGINE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body,
      response,
      isStreaming,
      'DeepSeek Volcengine',
    );
  }

  // 火山引擎方舟路由，使用固定 base URL，只需配置 API Key
  if (provider === 'volcengine' || provider === 'ark') {
    if (!process.env.VOLCENGINE_API_KEY) {
      return response.status(500).json({ error: "Missing 'VOLCENGINE_API_KEY' environment variable" });
    }

    const volcengineApiUrl = buildCompatibleUrl(
      'https://ark.cn-beijing.volces.com/api/v3',
      path,
      'chat/completions',
    );
    return proxyJsonRequest(
      volcengineApiUrl,
      {
        'Authorization': `Bearer ${process.env.VOLCENGINE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body,
      response,
      isStreaming,
      'Volcengine',
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
