import { apiGet, type ApiEnvelope } from './api'

// Mirror of NewAPI's UsageLog row (subset of fields we actually use). The
// `other` field is a JSON string written by both NewAPI native paths and the
// ConnectMulti .cc ingest path; we parse it lazily.
export interface UsageLog {
  id: number
  user_id: number
  created_at: number
  type: number
  model_name: string
  prompt_tokens: number
  completion_tokens: number
  quota: number
  use_time: number
  is_stream: boolean
  other: string
}

export interface LogOther {
  usage_ingest?: boolean
  provider?: string
  source_app?: string
  cached_input_tokens?: number
  cache_miss_tokens?: number
  reasoning_tokens?: number
  total_tokens?: number
  cache_tokens?: number // NewAPI native (Claude/Gemini path)
  cache_creation_tokens?: number
  cache_creation_tokens_5m?: number
  cache_creation_tokens_1h?: number
}

interface LogsPage {
  items: UsageLog[]
  total: number
  page: number
  page_size: number
}

export function parseOther(raw: string | null | undefined): LogOther {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as LogOther
  } catch {
    return {}
  }
}

export interface FetchLogsParams {
  startTimestamp: number
  endTimestamp: number
  pageSize?: number
  page?: number
  // 2 = consume. NewAPI also uses 0/5/6 for other states; for token rollups
  // we want consume logs only.
  type?: number
  // 'self' hits /api/log/self (own logs); 'admin' hits /api/log/ which
  // returns every user's logs and requires role >= RoleAdminUser.
  scope?: 'self' | 'admin'
  // admin scope only: filter by username so the dashboard can focus on the
  // ingest user (e.g. "connectmulti").
  username?: string
}

// Pulls one page of consume logs in the given window. NewAPI uses
// unix-seconds for timestamps.
export async function fetchLogs(
  params: FetchLogsParams
): Promise<ApiEnvelope<LogsPage>> {
  const scope = params.scope ?? 'self'
  const qs = new URLSearchParams({
    p: String(params.page ?? 1),
    page_size: String(params.pageSize ?? 1000),
    type: String(params.type ?? 2),
    start_timestamp: String(params.startTimestamp),
    end_timestamp: String(params.endTimestamp),
  })
  if (scope === 'admin' && params.username) {
    qs.set('username', params.username)
  }
  const endpoint = scope === 'admin' ? '/api/log/' : '/api/log/self'
  return apiGet<LogsPage>(`${endpoint}?${qs.toString()}`)
}
