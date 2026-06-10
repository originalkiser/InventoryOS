import { useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import { Modal, Button, Input, Select } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import toast from 'react-hot-toast'

interface InviteUserModalProps {
  open: boolean
  onClose: () => void
  onInvited: () => void
}

// Second client purely for signUp — keeps admin session untouched
function makeTempClient() {
  return createClient(
    import.meta.env.VITE_SUPABASE_URL as string,
    import.meta.env.VITE_SUPABASE_ANON_KEY as string,
    { auth: { persistSession: false, autoRefreshToken: false } }
  )
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
      const tempClient = makeTempClient()

      // Create the auth user using a throw-away client so admin stays signed in
      const { data: authData, error: authErr } = await tempClient.auth.signUp({
        email: email.trim(),
        password: tempPassword,
      })
      if (authErr) throw authErr

      const userId = authData.user?.id
      if (!userId) throw new Error('User creation returned no ID. Email confirmation may be required — check your Supabase Auth settings.')

      // Insert profile linked to this company
      const { error: profileErr } = await (supabase as any)
        .from('profiles')
        .insert({
          id: userId,
          company_id: profile.company_id,
          full_name: fullName.trim(),
          email: email.trim(),
          role,
        })
      if (profileErr) throw profileErr

      setCreated({ email: email.trim(), tempPassword })
      onInvited()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create user')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal open={open} onClose={handleClose} title="Invite User" size="md">
      {created ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2 text-[#39ff14]">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-sm font-mono font-semibold">User created</span>
          </div>

          <p className="text-xs text-gray-400 font-mono">
            Share these credentials with <span className="text-white">{created.email}</span>. They should change their password after first login.
          </p>

          <div className="bg-[#0f1117] border border-[#2a2d3e] rounded p-4 flex flex-col gap-2 font-mono text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">Email</span>
              <span className="text-white">{created.email}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-500">Temp Password</span>
              <div className="flex items-center gap-2">
                <span className="text-[#ffb300] tracking-wider">{created.tempPassword}</span>
                <button
                  onClick={() => { navigator.clipboard.writeText(created.tempPassword); toast.success('Copied') }}
                  className="text-gray-500 hover:text-white transition-colors"
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
          <p className="text-xs text-gray-500 font-mono">
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
