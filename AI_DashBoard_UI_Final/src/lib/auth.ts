// Cached identity for the NewAPI session. NewAPI's UserAuth middleware
// requires both the session cookie (set by /api/user/login) and a matching
// `New-Api-User: <id>` header on every request; we stash the id here after
// login so the API layer can attach it automatically.

const KEY = 'vyra.auth.user'

export interface AuthUser {
  id: number
  username: string
  role?: number
  display_name?: string
  group?: string
}

export function readUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as AuthUser
    if (typeof parsed.id !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

export function saveUser(user: AuthUser): void {
  localStorage.setItem(KEY, JSON.stringify(user))
}

export function clearUser(): void {
  localStorage.removeItem(KEY)
}
