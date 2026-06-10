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

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({ resolver: zodResolver(schema) })

  async function onSubmit(data: FormData) {
    const { error } = await supabase.auth.signInWithPassword(data)
    if (error) {
      toast.error(error.message)
    } else {
      navigate('/dashboard')
    }
  }

  async function sendReset() {
    if (!resetEmail) return
    setResetSending(true)
    const { error } = await supabase.auth.resetPasswordForEmail(resetEmail, {
      redirectTo: `${window.location.origin}/reset-password`,
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
    <div className="min-h-screen bg-[#0f1117] flex items-center justify-center font-mono">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="text-2xl font-bold text-[#00e5ff] tracking-widest uppercase mb-1">
            InventoryOS
          </div>
          <div className="text-xs text-gray-500 tracking-wide">Real-time inventory management</div>
        </div>

        <div className="bg-[#161820] border border-[#2a2d3e] rounded-lg p-6">
          {resetMode ? (
            <div className="flex flex-col gap-4">
              <h2 className="text-sm font-semibold text-white uppercase tracking-wide">
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
                className="text-xs text-gray-500 hover:text-gray-300 transition-colors text-center"
              >
                Back to login
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
              <h2 className="text-sm font-semibold text-white uppercase tracking-wide">Sign In</h2>
              <Input
                label="Email"
                type="email"
                placeholder="you@example.com"
                error={errors.email?.message}
                {...register('email')}
              />
              <Input
                label="Password"
                type="password"
                placeholder="••••••••"
                error={errors.password?.message}
                {...register('password')}
              />
              <Button type="submit" loading={isSubmitting} className="w-full justify-center">
                Sign In
              </Button>
              <button
                type="button"
                onClick={() => setResetMode(true)}
                className="text-xs text-gray-500 hover:text-[#00e5ff] transition-colors text-center"
              >
                Forgot password?
              </button>
              <div className="border-t border-[#2a2d3e] pt-3 text-center">
                <Link
                  to="/setup"
                  className="text-xs text-gray-600 hover:text-gray-400 transition-colors"
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
