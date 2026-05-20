import { apiGet, type ApiEnvelope } from './api'

// /api/data returns NewAPI's hourly-rolled usage statistics. Each row is a
// (user_id, model_name, hour) bucket: `token_used` = total tokens (no
// input/output split), `count` = request count, `quota` = cost in NewAPI
// credits.
export interface QuotaDataItem {
  user_id?: number
  username?: string
  model_name?: string
  created_at: number
  token_used?: number
  count?: number
  quota?: number
}

export interface FetchQuotaDataParams {
  startTimestamp: number
  endTimestamp: number
  scope?: 'self' | 'admin'
  defaultTime?: 'hour' | 'day'
}

export async function fetchQuotaData(
  params: FetchQuotaDataParams
): Promise<ApiEnvelope<QuotaDataItem[]>> {
  const scope = params.scope ?? 'self'
  const qs = new URLSearchParams({
    start_timestamp: String(params.startTimestamp),
    end_timestamp: String(params.endTimestamp),
    default_time: params.defaultTime ?? 'hour',
  })
  const endpoint = scope === 'admin' ? '/api/data' : '/api/data/self'
  return apiGet<QuotaDataItem[]>(`${endpoint}?${qs.toString()}`)
}
