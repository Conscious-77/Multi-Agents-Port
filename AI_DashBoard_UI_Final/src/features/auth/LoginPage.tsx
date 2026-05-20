import { useState, type FormEvent } from 'react'
import { apiPost } from '@/lib/api'
import { saveUser, type AuthUser } from '@/lib/auth'

interface LoginResponse extends AuthUser {
  status?: number
}

export function LoginPage(props: { onLoggedIn: (user: AuthUser) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await apiPost<LoginResponse>('/api/user/login', {
        username,
        password,
      })
      if (res.success && res.data && typeof res.data.id === 'number') {
        const user: AuthUser = {
          id: res.data.id,
          username: res.data.username,
          role: res.data.role,
          display_name: res.data.display_name,
          group: res.data.group,
        }
        saveUser(user)
        props.onLoggedIn(user)
      } else {
        setError(res.message || 'Login failed')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className='login-page'>
      <form className='login-card glass' onSubmit={handleSubmit}>
        <div className='login-brand'>
          <div className='logo-mark' />
          <div className='logo-text'>Vyra</div>
        </div>
        <h2 className='login-title'>Sign in</h2>
        <p className='login-sub'>Connect with your NewAPI account</p>

        <label className='login-field'>
          <span>Username</span>
          <input
            type='text'
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete='username'
            autoFocus
            required
          />
        </label>

        <label className='login-field'>
          <span>Password</span>
          <input
            type='password'
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete='current-password'
            required
          />
        </label>

        {error && <div className='login-error'>{error}</div>}

        <button
          type='submit'
          className='login-submit'
          disabled={submitting || !username || !password}
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>

        <p className='login-hint'>
          Backend: <code>http://127.0.0.1:11002</code> via Vite proxy
        </p>
      </form>
    </div>
  )
}
