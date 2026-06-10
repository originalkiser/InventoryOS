import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { Button, Input } from '@/components/ui'
import toast from 'react-hot-toast'

const ALLOWED_DOMAINS = (import.meta.env.VITE_SETUP_ALLOWED_DOMAINS ?? '')
  .split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean)

const ALLOWED_EMAILS = (import.meta.env.VITE_SETUP_ALLOWED_EMAILS ?? '')
  .split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean)

const RESTRICTIONS_CONFIGURED = ALLOWED_DOMAINS.length > 0 || ALLOWED_EMAILS.length > 0

function isEmailAllowed(email: string): boolean {
  if (!RESTRICTIONS_CONFIGURED) return true
  const lower = email.trim().toLowerCase()
  const domain = lower.split('@')[1] ?? ''
  return ALLOWED_EMAILS.includes(lower) || ALLOWED_DOMAINS.includes(domain)
}

export function SetupPage() {
  const navigate = useNavigate()
  const [companyName, setCompanyName] = useState('')
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  // Shown after signUp when email confirmation is required
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false)
  const [confirmedEmail, setConfirmedEmail] = useState('')

  async function handleSetup() {
    if (!companyName.trim() || !fullName.trim() || !email.trim()) {
      toast.error('All fields are required')
      return
    }
    if (password.length < 6) {
      toast.error('Password must be at least 6 characters')
      return
    }
    if (password !== confirm) {
      toast.error('Passwords do not match')
      return
    }
    if (!isEmailAllowed(email)) {
      toast.error('This email is not authorized to create a workspace')
      return
    }

    setLoading(true)
    try {
      // Store workspace details in user metadata — needed after email confirmation
      const { data: authData, error: authErr } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: {
            pending_company: companyName.trim(),
            full_name: fullName.trim(),
          },
        },
      })

      if (authErr) {
        const waitMatch = authErr.message.match(/after (\d+) second/i)
        if (waitMatch) throw new Error(`Too many attempts — please wait ${waitMatch[1]} seconds and try again.`)
        if (authErr.message.toLowerCase().includes('already registered')) {
          throw new Error('An account with this email already exists. Use "Sign in" instead.')
        }
        throw authErr
      }

      const session = authData.session
      const userId = authData.user?.id

      if (session && userId) {
        // Email confirmation is OFF — user is already authenticated, complete setup now
        await completeSetup(userId, companyName.trim(), fullName.trim(), email.trim())
        navigate('/dashboard')
      } else {
        // Email confirmation is ON — show the "check your inbox" screen
        setConfirmedEmail(email.trim())
        setAwaitingConfirmation(true)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Setup failed', { duration: 6000 })
    } finally {
      setLoading(false)
    }
  }

  if (awaitingConfirmation) {
    return (
      <div className="min-h-screen bg-[#0f1117] flex items-center justify-center font-mono">
        <div className="w-full max-w-sm">
          <div className="mb-8 text-center">
            <div className="text-2xl font-bold text-[#00e5ff] tracking-widest uppercase mb-1">
              InventoryOS
            </div>
          </div>
          <div className="bg-[#161820] border border-[#2a2d3e] rounded-lg p-6 flex flex-col gap-4 text-center">
            <div className="flex justify-center">
              <div className="w-12 h-12 rounded-full bg-[#00e5ff]/10 border border-[#00e5ff]/30 flex items-center justify-center">
                <svg className="w-6 h-6 text-[#00e5ff]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              </div>
            </div>
            <h2 className="text-sm font-semibold text-white uppercase tracking-wide">
              Confirm your email
            </h2>
            <p className="text-sm text-gray-400 font-mono leading-relaxed">
              We sent a confirmation link to
              <br />
              <span className="text-[#00e5ff]">{confirmedEmail}</span>
            </p>
            <p className="text-xs text-gray-500 font-mono">
              Click the link in that email to activate your account. Your workspace will finish setting up automatically when you sign in.
            </p>
            <div className="border-t border-[#2a2d3e] pt-3">
              <Link to="/login" className="text-xs text-[#00e5ff] hover:underline">
                Go to sign in →
              </Link>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#0f1117] flex items-center justify-center font-mono">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="text-2xl font-bold text-[#00e5ff] tracking-widest uppercase mb-1">
            InventoryOS
          </div>
          <div className="text-xs text-gray-500 tracking-wide">Create your workspace</div>
        </div>

        <div className="bg-[#161820] border border-[#2a2d3e] rounded-lg p-6 flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-white uppercase tracking-wide">
            First-Time Setup
          </h2>

          {!RESTRICTIONS_CONFIGURED ? (
            <div className="flex items-start gap-2 px-3 py-2.5 bg-[#ffb300]/10 border border-[#ffb300]/30 rounded text-xs font-mono text-[#ffb300]">
              <svg className="w-4 h-4 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
              <span>
                No email restrictions configured — anyone can create a workspace.
                Set <code className="text-white">VITE_SETUP_ALLOWED_DOMAINS</code> or{' '}
                <code className="text-white">VITE_SETUP_ALLOWED_EMAILS</code> in your .env to restrict access.
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2 px-3 py-2 bg-[#39ff14]/10 border border-[#39ff14]/20 rounded text-xs font-mono text-[#39ff14]">
              <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
              <span>
                Invite-only
                {ALLOWED_DOMAINS.length > 0 && ` · domains: ${ALLOWED_DOMAINS.join(', ')}`}
                {ALLOWED_EMAILS.length > 0 && ` · ${ALLOWED_EMAILS.length} approved email${ALLOWED_EMAILS.length !== 1 ? 's' : ''}`}
              </span>
            </div>
          )}

          <div className="border-t border-[#2a2d3e] pt-3">
            <p className="text-xs text-[#00e5ff] font-mono uppercase tracking-wide mb-3">Workspace</p>
            <Input label="Company / Workspace Name" value={companyName}
              onChange={(e) => setCompanyName(e.target.value)} placeholder="Acme Co." />
          </div>

          <div className="border-t border-[#2a2d3e] pt-3 flex flex-col gap-3">
            <p className="text-xs text-[#00e5ff] font-mono uppercase tracking-wide">Admin Account</p>
            <Input label="Full Name" value={fullName}
              onChange={(e) => setFullName(e.target.value)} placeholder="Jane Smith" />
            <Input label="Email" type="email" value={email}
              onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            <Input label="Password" type="password" value={password}
              onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
            <Input label="Confirm Password" type="password" value={confirm}
              onChange={(e) => setConfirm(e.target.value)} placeholder="••••••••" />
          </div>

          <Button loading={loading} onClick={handleSetup} className="w-full justify-center">
            Create Workspace
          </Button>

          <Link to="/login" className="text-xs text-gray-500 hover:text-gray-300 transition-colors text-center">
            Already have an account? Sign in
          </Link>
        </div>
      </div>
    </div>
  )
}

// Called from Setup (email conf off) or from useAuth (email conf on, first login)
export async function completeSetup(
  userId: string,
  companyName: string,
  fullName: string,
  email: string
) {
  const { data: company, error: companyErr } = await (supabase as any)
    .from('companies')
    .insert({ name: companyName })
    .select()
    .single()
  if (companyErr) throw companyErr

  const { error: profileErr } = await (supabase as any)
    .from('profiles')
    .insert({
      id: userId,
      company_id: company.id,
      full_name: fullName,
      email,
      role: 'admin',
    })
  if (profileErr) throw profileErr
}
