import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, 'dist')
const port = Number(process.env.PORT || 11004)
const host = process.env.HOST || '0.0.0.0'
const apiTarget = process.env.API_TARGET || process.env.NEWAPI_BASE_URL || 'http://127.0.0.1:11002'

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

function serveStatic(req, res, url) {
  let pathname = '/'
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    pathname = '/'
  }

  let file = path.join(root, pathname)
  if (!file.startsWith(root)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Forbidden')
    return
  }

  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    file = path.join(file, 'index.html')
  }
  if (!fs.existsSync(file)) {
    file = path.join(root, 'index.html')
  }

  const ext = path.extname(file)
  res.writeHead(200, {
    'content-type': mime[ext] || 'application/octet-stream',
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  fs.createReadStream(file).pipe(res)
}

function proxyApi(req, res) {
  const target = new URL(req.url || '/', apiTarget)
  const headers = { ...req.headers, host: target.host }
  delete headers.connection
  delete headers['proxy-connection']
  delete headers['accept-encoding']

  const transport = target.protocol === 'https:' ? https : http
  const upstreamReq = transport.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
    },
    (upstreamRes) => {
      const responseHeaders = { ...upstreamRes.headers }
      delete responseHeaders['content-encoding']
      delete responseHeaders['transfer-encoding']
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders)
      upstreamRes.pipe(res)
    }
  )

  upstreamReq.on('error', (error) => {
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ success: false, message: error.message }))
  })
  req.pipe(upstreamReq)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  if (url.pathname.startsWith('/api/')) {
    proxyApi(req, res)
    return
  }
  serveStatic(req, res, url)
})

server.listen(port, host, () => {
  console.log(`AI dashboard listening on http://${host}:${port}`)
  console.log(`Proxying /api to ${apiTarget}`)
})
