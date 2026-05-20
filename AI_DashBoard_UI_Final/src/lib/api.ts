import { readUser } from './auth'

// Thin fetch wrapper. Requests are routed through Vite's dev proxy:
//   /api/* -> http://127.0.0.1:11002 (NewAPI backend)
// so the NewAPI session cookie (set by /api/user/login) flows through.
// NewAPI's UserAuth middleware additionally requires a New-Api-User header
// that matches the session's user id — see middleware/auth.go.

export interface ApiEnvelope<T> {
  success: boolean
  message?: string
  data?: T
}

function authHeaders(): Record<string, string> {
  const user = readUser()
  return user ? { 'New-Api-User': String(user.id) } : {}
}

export async function apiGet<T>(path: string): Promise<ApiEnvelope<T>> {
  const res = await fetch(path, {
    method: 'GET',
    credentials: 'include',
    headers: { Accept: 'application/json', ...authHeaders() },
  })
  return (await res.json()) as ApiEnvelope<T>
}

export async function apiPost<T>(
  path: string,
  body: unknown
): Promise<ApiEnvelope<T>> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify(body),
  })
  return (await res.json()) as ApiEnvelope<T>
}
