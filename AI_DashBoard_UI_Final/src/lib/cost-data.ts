import { apiGet, type ApiEnvelope } from './api'

export interface UsageCostItem {
  model_name: string
  provider: string
  created_at: number
  requests: number
  input_tokens: number
  output_tokens: number
  cached_input_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  cache_creation_input_tokens_1h: number
  reasoning_tokens: number
  cost_usd: number
  unpriced_requests: number
  pricing_version: string
}

export interface UsageCostResponse {
  items: UsageCostItem[]
  pricing_version: string
}

export interface FetchUsageCostParams {
  startTimestamp: number
  endTimestamp: number
  scope?: 'self' | 'admin'
  granularity?: 60 | 300 | 3600 | 86400
}

export async function fetchUsageCost(
  params: FetchUsageCostParams
): Promise<ApiEnvelope<UsageCostResponse>> {
  const scope = params.scope ?? 'self'
  const qs = new URLSearchParams({
    start_timestamp: String(params.startTimestamp),
    end_timestamp: String(params.endTimestamp),
    granularity: String(params.granularity ?? 60),
  })
  const endpoint = scope === 'admin' ? '/api/usage/cost' : '/api/usage/cost/self'
  return apiGet<UsageCostResponse>(`${endpoint}?${qs.toString()}`)
}
