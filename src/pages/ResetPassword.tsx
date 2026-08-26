import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { Button, Input } from '@/components/ui'
import toast from 'react-hot-toast'

export function ResetPasswordPage() {
  const navigate = useNavigate()
  const { profile, setProfile } = useAuthStore()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const forced = !!profile?.must_reset_password

  async function handleReset() {
    if (password !== confirm) {
      toast.error('Passwords do not match')
      return
    }
    if (password.length < 6) {
      toast.error('Password must be at least 6 characters')
      return
    }
    setLoading(true)
    const { error } = await supabase.auth.updateUser({ password })
    if (error) {
      toast.error(error.message)
      setLoading(false)
      return
    }
    // Clear the forced-reset flag (best-effort — no-op if this session got
    // here via an emailed reset link rather than an admin reset).
    if (profile?.id) {
      const { error: flagErr } = await (supabase as any)
        .schema('platform').from('user_profiles').update({ must_reset_password: false }).eq('id', profile.id)
      if (!flagErr) setProfile({ ...profile, must_reset_password: false })
    }
    toast.success('Password updated!')
    navigate('/dashboard')
    setLoading(false)
  }

  return (
    <div className="min-h-screen bg-cream flex items-center justify-center font-mono">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="text-2xl font-bold text-inky tracking-widest uppercase mb-1">
            InventoryOS
          </div>
        </div>
        <div className="bg-cream border border-navy/30 rounded-lg p-6 flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-navy uppercase tracking-wide">Set New Password</h2>
          {forced && (
            <p className="text-xs text-inky/70 -mt-2">
              An admin reset your password. Set a new one to continue.
            </p>
          )}
          <Input
            label="New Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
          <Input
            label="Confirm Password"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="••••••••"
          />
          <Button loading={loading} onClick={handleReset} className="w-full justify-center">
            Update Password
          </Button>
        </div>
      </div>
    </div>
  )
}
