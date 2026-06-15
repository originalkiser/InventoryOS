import { useState } from 'react'
import { Modal, Button, Input, Select } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import toast from 'react-hot-toast'

interface InviteUserModalProps {
  open: boolean
  onClose: () => void
  onInvited: () => void
}

function generatePassword(length = 16) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$'
  return Array.from(crypto.getRandomValues(new Uint8Array(length)))
    .map((b) => chars[b % chars.length])
    .join('')
}

export function InviteUserModal({ open, onClose, onInvited }: InviteUserModalProps) {
  const { profile } = useAuthStore()
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'user' | 'admin'>('user')
  const [loading, setLoading] = useState(false)
  const [created, setCreated] = useState<{ email: string; tempPassword: string } | null>(null)

  function reset() {
    setFullName('')
    setEmail('')
    setRole('user')
    setCreated(null)
  }

  function handleClose() {
    reset()
    onClose()
  }

  async function handleInvite() {
    if (!fullName.trim() || !email.trim()) {
      toast.error('Name and email are required')
      return
    }
    if (!profile?.company_id) return

    setLoading(true)
    try {
      const tempPassword = generatePassword()

      // Create the user via the Edge Function (service-role, no confirmation
      // email → no rate limit, and the user is created already-confirmed).
      const { data, error } = await supabase.functions.invoke('invite-user', {
        body: { email: email.trim(), full_name: fullName.trim(), role, password: tempPassword },
      })
      if (error) {
        // On a non-2xx the real reason is in the response body, not error.message.
        let msg = error.message
        try {
          const ctx = (error as { context?: Response }).context
          if (ctx && typeof ctx.json === 'function') { const b = await ctx.json(); if (b?.error) msg = b.error }
        } catch { /* keep generic message */ }
        throw new Error(msg)
      }
      if (data?.error) throw new Error(data.error)

      setCreated({ email: email.trim(), tempPassword })
      onInvited()
    } catch (e) {
      const msg = (e as { message?: string })?.message || (typeof e === 'string' ? e : 'Failed to create user')
      toast.error(msg)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal open={open} onClose={handleClose} title="Invite User" size="md">
      {created ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2 text-green-700">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-sm font-mono font-semibold">User created</span>
          </div>

          <p className="text-xs text-inky font-mono">
            Share these credentials with <span className="text-navy">{created.email}</span>. They should change their password after first login.
          </p>

          <div className="bg-cream border border-navy/30 rounded p-4 flex flex-col gap-2 font-mono text-sm">
            <div className="flex justify-between">
              <span className="text-inky">Email</span>
              <span className="text-navy">{created.email}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-inky">Temp Password</span>
              <div className="flex items-center gap-2">
                <span className="text-orange-600 tracking-wider">{created.tempPassword}</span>
                <button
                  onClick={() => { navigator.clipboard.writeText(created.tempPassword); toast.success('Copied') }}
                  className="text-inky hover:text-navy transition-colors"
                  title="Copy password"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </button>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" size="sm" onClick={() => { reset() }}>
              Invite Another
            </Button>
            <Button size="sm" onClick={handleClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-xs text-inky font-mono">
            A temporary password will be generated. Share it with the new user — they can change it after signing in.
          </p>

          <Input
            label="Full Name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Jane Smith"
          />
          <Input
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="jane@example.com"
          />
          <Select
            label="Role"
            value={role}
            onChange={(e) => setRole(e.target.value as 'user' | 'admin')}
            options={[
              { value: 'user', label: 'User — standard access' },
              { value: 'admin', label: 'Admin — can manage config & users' },
            ]}
          />

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" size="sm" onClick={handleClose}>Cancel</Button>
            <Button size="sm" loading={loading} onClick={handleInvite}>
              Create User
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
