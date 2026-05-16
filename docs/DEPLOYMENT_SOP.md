# Deployment SOP

This repo has three deployable services:

- `.cc proxy` on Vercel: project `multi-agents-port`
- NewAPI backend on Railway: project `connectmulti-usage-analysis`, service `newapi-backend`
- New frontend on Railway: project `connectmulti-usage-analysis`, service `web-synthex`

Production URLs:

```txt
.cc proxy:       https://multi-agents-port.vercel.app/api/proxy
NewAPI backend: https://newapi-backend-production.up.railway.app
web-synthex:    https://web-synthex-production.up.railway.app
```

## 0. Preflight

Check the Railway service you are linked to before deploying:

```bash
railway status
```

Switch services explicitly:

```bash
railway service newapi-backend
railway service web-synthex
```

Important Railway variables:

```txt
newapi-backend:
  FRONTEND_BASE_URL=https://web-synthex-production.up.railway.app
  USAGE_INGEST_SECRET=<secret>
  USAGE_INGEST_DEFAULT_USER_ID=2

web-synthex:
  VITE_REACT_APP_SERVER_URL=https://newapi-backend-production.up.railway.app
```

Do not set `NODE_TYPE=slave` just to enable the frontend redirect. The backend code allows `FRONTEND_BASE_URL` on the master node.

## 1. Deploy NewAPI Backend

Use this when changing files under `NewAPI/`, including backend APIs, database logic, usage ingest, or routing.

```bash
cd /Users/acher/Desktop/MacBook/Projects/ConnectMulti_Token/NewAPI
railway service newapi-backend
railway status
railway variables --kv | rg '^(FRONTEND_BASE_URL|USAGE_INGEST_DEFAULT_USER_ID|RAILWAY_SERVICE_NAME|RAILWAY_PUBLIC_DOMAIN)='
railway up --ci --service newapi-backend --path-as-root .
```

If `railway up` fails with `413 Payload Too Large`, confirm `.dockerignore` and `.railwayignore` exist and exclude `.git`, `data`, `logs`, and frontend `dist` folders.

Verify backend deployment:

```bash
curl -I https://newapi-backend-production.up.railway.app
curl -sS -D - https://newapi-backend-production.up.railway.app/api/status -o /tmp/newapi-status.json
railway logs --deployment --service newapi-backend
```

Expected:

```txt
GET /                      -> 301 Location: https://web-synthex-production.up.railway.app/
GET /api/status            -> 200
POST /api/usage/ingest     -> 200 when .cc reports usage
```

## 2. Deploy web-synthex Frontend

Use this when changing files under `web-synthex/`.

```bash
cd /Users/acher/Desktop/MacBook/Projects/ConnectMulti_Token/web-synthex
railway service web-synthex
railway status
railway variables --kv | rg '^(VITE_REACT_APP_SERVER_URL|RAILWAY_SERVICE_NAME|RAILWAY_PUBLIC_DOMAIN)='
bun run build
railway up --ci --service web-synthex --path-as-root .
```

`web-synthex/node_modules` is large. Keep `.dockerignore` and `.railwayignore` in place so Railway does not upload local dependencies.

Verify frontend deployment:

```bash
curl -I https://web-synthex-production.up.railway.app
curl -sS https://web-synthex-production.up.railway.app | head -c 500
```

Expected:

```txt
GET / -> 200 and returns the web-synthex HTML bundle
```

## 3. Deploy .cc Proxy

Use this when changing root `api/`, root `lib/`, `vercel.json`, or root `package.json`.

The Vercel project is bound at repo root:

```txt
.vercel/project.json -> multi-agents-port
```

Required Vercel environment variables:

```txt
NEWAPI_INGEST_ENABLED=true
NEWAPI_INGEST_URL=https://newapi-backend-production.up.railway.app/api/usage/ingest
NEWAPI_INGEST_SECRET=<same value as Railway newapi-backend USAGE_INGEST_SECRET>
NEWAPI_INGEST_USER_ID=2
```

To read the Railway secret into clipboard:

```bash
cd /Users/acher/Desktop/MacBook/Projects/ConnectMulti_Token/NewAPI
railway service newapi-backend
railway variables --kv | awk -F= '/^USAGE_INGEST_SECRET=/{print substr($0, length($1)+2)}' | pbcopy
```

Deploy from Vercel dashboard or CLI. After deployment, verify:

```bash
curl -sS 'https://multi-agents-port.vercel.app/api/proxy?stats=1' | head -c 1000
```

Then send one real `.cc` request and check Railway logs:

```bash
cd /Users/acher/Desktop/MacBook/Projects/ConnectMulti_Token/NewAPI
railway logs --deployment --service newapi-backend
```

Expected:

```txt
POST /api/usage/ingest -> 200
```

## 4. Rollback

Railway:

```bash
railway down --service newapi-backend
railway down --service web-synthex
```

Vercel: use the Vercel dashboard deployment history and promote the previous deployment.

## 5. Common Pitfalls

- `HEAD /api/status` may redirect because the API route is registered for `GET`; verify with `GET`.
- If backend root returns NewAPI embedded HTML instead of redirecting, check `FRONTEND_BASE_URL` on `newapi-backend`.
- If `.cc` stats increase but NewAPI usage does not, check Vercel `NEWAPI_INGEST_*` variables and backend logs for `POST /api/usage/ingest`.
- Do not paste secrets into docs or chat. Copy them directly between Railway and Vercel variable panels.
