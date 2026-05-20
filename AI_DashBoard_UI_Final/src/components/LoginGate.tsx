import { useEffect, useState, type ReactNode } from 'react'
import { LoginPage } from '@/features/auth/LoginPage'
import { apiGet } from '@/lib/api'
import { clearUser, readUser, saveUser, type AuthUser } from '@/lib/auth'

type Phase = 'checking' | 'unauthed' | 'authed'

// Boots the app into one of three states: showing a loading splash while
// we re-validate the cached user against /api/user/self, the login page if
// no valid session exists, or the actual dashboard once authed.
export function LoginGate(props: { children: ReactNode }) {
  const cached = readUser()
  const [user, setUser] = useState<AuthUser | null>(cached)
  const [phase, setPhase] = useState<Phase>(cached ? 'checking' : 'unauthed')

  useEffect(() => {
    if (phase !== 'checking' || !user) return
    let cancelled = false
    apiGet<AuthUser>('/api/user/self')
      .then((res) => {
        if (cancelled) return
        if (res.success && res.data) {
          // Refresh cached identity in case display_name/group changed.
          const fresh: AuthUser = {
            id: res.data.id,
            username: res.data.username,
            role: res.data.role,
            display_name: res.data.display_name,
            group: res.data.group,
          }
          saveUser(fresh)
          setUser(fresh)
          setPhase('authed')
        } else {
          clearUser()
          setUser(null)
          setPhase('unauthed')
        }
      })
      .catch(() => {
        if (cancelled) return
        clearUser()
        setUser(null)
        setPhase('unauthed')
      })
    return () => {
      cancelled = true
    }
  }, [phase, user])

  const handleLoggedIn = (u: AuthUser) => {
    setUser(u)
    setPhase('authed')
  }

  if (phase === 'checking') {
    return <div className='auth-loading'>Connecting…</div>
  }
  if (phase === 'unauthed' || !user) {
    return <LoginPage onLoggedIn={handleLoggedIn} />
  }
  return <>{props.children}</>
}
