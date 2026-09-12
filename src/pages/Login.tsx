import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { supabase } from '@/lib/supabase'
import { Button, Input } from '@/components/ui'
import toast from 'react-hot-toast'

const schema = z.object({
  email: z.string().email('Invalid email'),
  password: z.string().min(6, 'Password too short'),
})

type FormData = z.infer<typeof schema>

export function LoginPage() {
  const navigate = useNavigate()
  const [resetMode, setResetMode] = useState(false)
  const [resetEmail, setResetEmail] = useState('')
  const [resetSending, setResetSending] = useState(false)

  // Two-step sign-in: confirm the email belongs to a real, unlocked account
  // BEFORE the password field ever appears. Someone landing here from a
  // public menu-board share link (no account, no reason to be here) can't
  // get anywhere near attempting a password.
  const [step, setStep] = useState<'email' | 'password'>('email')
  const [checkingEmail, setCheckingEmail] = useState(false)
  const [stepError, setStepError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    watch,
    trigger,
    getValues,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({ resolver: zodResolver(schema) })

  const emailValue = watch('email', '')
  const showBranding =
    emailValue.toLowerCase().endsWith('@sboilchange.com') ||
    resetEmail.toLowerCase().endsWith('@sboilchange.com')

  async function onContinue() {
    const valid = await trigger('email')
    if (!valid) return
    setStepError(null)
    setCheckingEmail(true)
    try {
      const email = getValues('email')
      const { data, error } = await supabase.functions.invoke('check-login-email', { body: { email } })
      if (error || data?.error) { toast.error('Could not verify that email — try again'); return }
      if (!data.exists) { setStepError("This email isn't registered."); return }
      if (data.locked) { setStepError('This account is locked after too many failed attempts. Contact an administrator to unlock it.'); return }
      setStep('password')
    } finally {
      setCheckingEmail(false)
    }
  }

  function changeEmail() {
    setStep('email')
    setStepError(null)
    setValue('password', '')
  }

  async function onSubmit(data: FormData) {
    const { error } = await supabase.auth.signInWithPassword(data)
    if (error) {
      const { data: attempt } = await supabase.functions.invoke('record-login-attempt', { body: { email: data.email, success: false } })
      if (attempt?.locked) {
        setStep('email')
        setValue('password', '')
        setStepError('This account is now locked after too many failed attempts. Contact an administrator to unlock it.')
      } else if (typeof attempt?.attemptsRemaining === 'number' && attempt.attemptsRemaining <= 2) {
        toast.error(`Incorrect password. ${attempt.attemptsRemaining} attempt${attempt.attemptsRemaining === 1 ? '' : 's'} remaining before this account is locked.`)
      } else {
        toast.error(error.message)
      }
    } else {
      supabase.functions.invoke('record-login-attempt', { body: { email: data.email, success: true } }).catch(() => {})
      navigate('/dashboard')
    }
  }

  async function sendReset() {
    if (!resetEmail) return
    setResetSending(true)
    const { error } = await supabase.auth.resetPasswordForEmail(resetEmail, {
      redirectTo: `${window.location.origin}${import.meta.env.BASE_URL}reset-password`,
    })
    if (error) {
      toast.error(error.message)
    } else {
      toast.success('Password reset email sent')
      setResetMode(false)
    }
    setResetSending(false)
  }

  return (
    <div className="min-h-screen bg-cream flex items-center justify-center font-body">
      <div className="w-full max-w-sm">
        <div className={[
          'text-center overflow-hidden transition-all duration-500',
          showBranding ? 'max-h-20 opacity-100 mb-8' : 'max-h-0 opacity-0 mb-0',
        ].join(' ')}>
          <div className="text-2xl font-heading font-bold text-navy tracking-widest uppercase mb-1">
            Strickland Brothers
          </div>
          <div className="text-xs text-inky font-body tracking-wide">SB Net</div>
        </div>

        <div className="bg-cream border border-navy/40 rounded-xl p-6 shadow-sm">
          {resetMode ? (
            <div className="flex flex-col gap-4">
              <h2 className="text-sm font-heading font-bold text-navy uppercase tracking-wide">
                Reset Password
              </h2>
              <Input
                label="Email"
                type="email"
                value={resetEmail}
                onChange={(e) => setResetEmail(e.target.value)}
                placeholder="you@example.com"
              />
              <Button loading={resetSending} onClick={sendReset} className="w-full justify-center">
                Send Reset Link
              </Button>
              <button
                onClick={() => setResetMode(false)}
                className="text-xs text-inky hover:text-navy transition-colors text-center font-body"
              >
                Back to sign in
              </button>
            </div>
          ) : (
            <form
              onSubmit={step === 'email' ? (e) => { e.preventDefault(); onContinue() } : handleSubmit(onSubmit)}
              className="flex flex-col gap-4"
            >
              <h2 className="text-sm font-heading font-bold text-navy uppercase tracking-wide">Sign In</h2>
              <Input
                label="Email"
                type="email"
                placeholder="you@example.com"
                error={errors.email?.message}
                disabled={step === 'password'}
                {...register('email')}
              />
              {step === 'password' && (
                <Input
                  label="Password"
                  type="password"
                  placeholder="••••••••"
                  error={errors.password?.message}
                  autoFocus
                  {...register('password')}
                />
              )}
              {stepError && (
                <p className="text-xs font-body text-[#C0392B] -mt-2">{stepError}</p>
              )}
              <Button type="submit" loading={step === 'email' ? checkingEmail : isSubmitting} className="w-full justify-center">
                {step === 'email' ? 'Continue' : 'Sign In'}
              </Button>
              {step === 'password' && (
                <button
                  type="button"
                  onClick={changeEmail}
                  className="text-xs text-inky hover:text-navy transition-colors text-center font-body"
                >
                  Not you? Change email
                </button>
              )}
              <button
                type="button"
                onClick={() => setResetMode(true)}
                className="text-xs text-inky hover:text-navy transition-colors text-center font-body"
              >
                Forgot password?
              </button>
              <div className="border-t border-navy/20 pt-3 text-center">
                <Link
                  to="/setup"
                  className="text-xs text-inky/70 hover:text-navy transition-colors font-body"
                >
                  New workspace? Set one up →
                </Link>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
