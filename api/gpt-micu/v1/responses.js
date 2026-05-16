import proxyStats from '../../proxy-stats.js';

export default function handler(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  url.searchParams.set('provider', 'gpt-micu');
  url.searchParams.set('path', 'v1/responses');
  request.url = `${url.pathname}?${url.searchParams.toString()}`;

  if (!request.headers['x-source-app']) {
    request.headers['x-source-app'] = 'codex-gpt-micu';
  }

  return proxyStats(request, response);
}
