import { useEffect, useState } from 'react'
import { apiGet } from '@/lib/api'

type Status = 'pending' | 'ok' | 'fail'

// Pings NewAPI /api/status on mount. Shown as a tiny pill in the top-left of
// the shell so we can confirm the Vite proxy + NewAPI backend are reachable
// before any feature touches real data.
export function ApiHealthPill() {
  const [status, setStatus] = useState<Status>('pending')
  const [detail, setDetail] = useState<string>('')

  useEffect(() => {
    let cancelled = false
    apiGet<{ version?: string; server_address?: string }>('/api/status')
      .then((res) => {
        if (cancelled) return
        if (res.success) {
          setStatus('ok')
          setDetail(res.data?.version ?? 'NewAPI')
        } else {
          setStatus('fail')
          setDetail(res.message ?? 'unknown error')
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setStatus('fail')
        setDetail(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const label =
    status === 'pending'
      ? 'API: pinging...'
      : status === 'ok'
        ? `API: online${detail ? ` · ${detail}` : ''}`
        : `API: offline${detail ? ` · ${detail}` : ''}`

  return (
    <div className='api-pill' title='Click to retry via page refresh'>
      <span className={`api-dot ${status}`} />
      {label}
    </div>
  )
}
