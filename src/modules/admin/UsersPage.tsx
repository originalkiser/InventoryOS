import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { Button, Modal, Input } from '@/components/ui'
import { InviteUserModal } from './InviteUserModal'
import { ROLES, ROLE_OPTIONS, getRoleLabel, isDeveloper, isAdminOrDeveloper } from '@/lib/roles'
import type { Profile } from '@/types'
import { format, differenceInDays } from 'date-fns'
import toast from 'react-hot-toast'

type RoleValue = typeof ROLES[keyof typeof ROLES] | 'admin' | 'user'

const ROLE_BADGE_COLOR: Record<string, string> = {
  developer: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
  administrator: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-300',
  admin: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-300',
  director: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  area_manager: 'bg-sky/20 text-navy dark:bg-sky/10 dark:text-sky',
  department_user: 'bg-navy/10 text-inky dark:bg-[#F2F1E6]/10 dark:text-[#F2F1E6]/70',
  user: 'bg-navy/10 text-inky dark:bg-[#F2F1E6]/10 dark:text-[#F2F1E6]/70',
}

const DEPT_OPTIONS = [
  { key: 'dept:inventory', label: 'Inventory' },
  { key: 'dept:operations', label: 'Operations' },
  { key: 'dept:finance', label: 'Finance' },
  { key: 'dept:accounting', label: 'Accounting' },
  { key: 'dept:marketing', label: 'Marketing' },
]

const MODULE_OPTIONS = [
  { key: 'module:monthend', label: 'Month End Count', dept: 'dept:inventory' },
  { key: 'module:weekly', label: 'Weekly Count', dept: 'dept:inventory' },
  { key: 'module:orders', label: 'Orders', dept: 'dept:inventory' },
  { key: 'module:projects', label: 'Projects', dept: 'dept:inventory' },
]

interface UserWithAccess extends Profile {
  featureKeys?: string[]
  deleted_at?: string | null
}

function RoleBadge({ role }: { role: string | null | undefined }) {
  const cls = ROLE_BADGE_COLOR[role ?? ''] ?? 'bg-navy/10 text-inky dark:bg-[#F2F1E6]/10 dark:text-[#F2F1E6]/70'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono ${cls}`}>
      {getRoleLabel(role)}
    </span>
  )
}

// ── Manage User Modal ────────────────────────────────────────────────────────

function ManageUserModal({
  user,
  myProfile,
  amDeveloper,
  onClose,
  onSaved,
  onRemoved,
}: {
  user: UserWithAccess
  myProfile: Profile
  amDeveloper: boolean
  onClose: () => void
  onSaved: () => void
  onRemoved: () => void
}) {
  const isSelf = user.id === myProfile.id
  const [editName, setEditName] = useState(user.full_name ?? '')
  const [editRole, setEditRole] = useState<RoleValue>((user.role as RoleValue) ?? ROLES.DEPARTMENT_USER)
  const [editAccess, setEditAccess] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [resettingPw, setResettingPw] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)

  useEffect(() => {
    const sb = supabase as any
    sb.schema('core').from('user_feature_access')
      .select('feature_key').eq('user_id', user.id).eq('enabled', true)
      .then(({ data }: any) => setEditAccess(new Set((data ?? []).map((r: any) => r.feature_key as string))))
  }, [user.id])

  function toggleAccess(key: string) {
    setEditAccess((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
        MODULE_OPTIONS.filter((m) => m.dept === key).forEach((m) => next.delete(m.key))
      } else {
        next.add(key)
        MODULE_OPTIONS.filter((m) => m.dept === key).forEach((m) => next.add(m.key))
      }
      return next
    })
  }

  const activeDepts = DEPT_OPTIONS.filter((d) => editAccess.has(d.key))
  const effectiveRole = isSelf ? (user.role as RoleValue) : editRole

  async function save() {
    setSaving(true)
    const sb = supabase as any
    const newName = editName.trim() || null
    const oldName = user.full_name ?? null
    const roleToSave = isSelf ? (user.role as RoleValue) : editRole

    if (isSelf) await sb.auth.updateUser({ data: { full_name: newName } })

    const { error } = await sb
      .schema('platform').from('user_profiles')
      .update({ role: roleToSave, full_name: newName })
      .eq('id', user.id)

    if (error) { toast.error(error.message); setSaving(false); return }

    const allKeys = [...DEPT_OPTIONS.map((d) => d.key), ...MODULE_OPTIONS.map((m) => m.key)]
    await sb.schema('core').from('user_feature_access').upsert(
      allKeys.map((key) => ({
        user_id: user.id,
        feature_key: key,
        enabled: editAccess.has(key),
      })),
      { onConflict: 'user_id,feature_key' }
    )

    if (newName && oldName && newName !== oldName && myProfile.company_id) {
      await Promise.all([
        sb.schema('inventory').from('tasks').update({ assignee_name: newName }).eq('company_id', myProfile.company_id).eq('assignee_name', oldName).is('assignee_id', null),
        sb.schema('inventory').from('project_tasks').update({ assignee: newName }).eq('company_id', myProfile.company_id).eq('assignee', oldName),
        sb.schema('inventory').from('issues').update({ assignee: newName }).eq('company_id', myProfile.company_id).eq('assignee', oldName),
      ])
    }

    toast.success('User updated')
    setSaving(false)
    onSaved()
    onClose()
  }

  async function sendReset() {
    if (!user.email) return
    setResettingPw(true)
    const { error } = await supabase.auth.resetPasswordForEmail(user.email, {
      redirectTo: `${window.location.origin}${import.meta.env.BASE_URL}reset-password`,
    })
    if (error) toast.error(error.message)
    else toast.success(`Password reset email sent to ${user.email}`)
    setResettingPw(false)
  }

  async function doRemove() {
    const sb = supabase as any
    const now = new Date().toISOString()
    const { error } = await sb.schema('platform').from('user_profiles').update({ deleted_at: now }).eq('id', user.id)
    if (error) toast.error(error.message)
    else { toast.success('User removed — recoverable for 90 days'); onRemoved(); onClose() }
  }

  return (
    <Modal open onClose={onClose} title={`Manage — ${user.full_name ?? user.email}`}>
      <div className="flex flex-col gap-5">
        <p className="text-[10px] font-mono text-inky/50 dark:text-[#F2F1E6]/40">{user.email}</p>

        {/* Display name */}
        <Input label="Display Name" value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Full name..." />

        {/* Role */}
        <div className="flex flex-col gap-1.5">
          <label className="text-[10px] font-heading text-inky/70 dark:text-[#F2F1E6]/60 uppercase tracking-wide">Role</label>
          {isSelf ? (
            <div className="rounded border border-navy/20 bg-navy/5 dark:bg-[#F2F1E6]/5 px-3 py-2 text-xs font-mono text-inky/60 dark:text-[#F2F1E6]/50">
              {getRoleLabel(user.role)} — cannot change your own role
            </div>
          ) : (
            <div className="flex flex-col gap-2.5 max-h-56 overflow-y-auto pr-1">
              {ROLE_OPTIONS
                .filter((opt) => amDeveloper || opt.value !== ROLES.DEVELOPER)
                .map((opt) => (
                  <label key={opt.value} className="flex items-start gap-2.5 cursor-pointer">
                    <input
                      type="radio"
                      name="manage-role"
                      value={opt.value}
                      checked={editRole === opt.value}
                      onChange={() => setEditRole(opt.value as RoleValue)}
                      className="mt-0.5 accent-sky flex-shrink-0"
                    />
                    <div>
                      <div className="text-xs font-heading text-navy dark:text-[#F2F1E6]">{opt.label}</div>
                      <div className="text-[10px] font-body text-inky/60 dark:text-[#F2F1E6]/50 leading-relaxed">{opt.description}</div>
                    </div>
                  </label>
                ))}
            </div>
          )}
        </div>

        {/* Department / module access — always shown, independent of role */}
        {effectiveRole && (
          <div className="flex flex-col gap-3 border-t border-navy/10 dark:border-[#F2F1E6]/10 pt-4">
            <div className="text-[10px] font-heading text-inky/70 dark:text-[#F2F1E6]/60 uppercase tracking-wide">Department Access</div>
            <div className="grid grid-cols-2 gap-2">
              {DEPT_OPTIONS.map((d) => (
                <label key={d.key} className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={editAccess.has(d.key)} onChange={() => toggleAccess(d.key)} className="accent-sky" />
                  <span className="text-xs font-body text-navy dark:text-[#F2F1E6]">{d.label}</span>
                </label>
              ))}
            </div>
            {activeDepts.some((d) => d.key === 'dept:inventory') && (
              <div className="flex flex-col gap-2 pl-3 border-l border-navy/15 dark:border-[#F2F1E6]/15">
                <div className="text-[10px] font-heading text-inky/60 dark:text-[#F2F1E6]/50 uppercase tracking-wide">Inventory Modules</div>
                {MODULE_OPTIONS.filter((m) => m.dept === 'dept:inventory').map((m) => (
                  <label key={m.key} className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={editAccess.has(m.key)} onChange={() => toggleAccess(m.key)} className="accent-sky" />
                    <span className="text-xs font-body text-navy dark:text-[#F2F1E6]">{m.label}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Name-change warning */}
        {user.full_name && editName.trim() && editName.trim() !== user.full_name && (
          <p className="text-[11px] font-mono text-inky/70 dark:text-[#F2F1E6]/50 bg-navy/5 dark:bg-[#F2F1E6]/5 border border-navy/20 dark:border-[#F2F1E6]/10 rounded px-3 py-2">
            Renaming will also update tasks, project tasks, and issues assigned to this name.
          </p>
        )}

        {/* Actions row */}
        <div className="flex items-center justify-between border-t border-navy/10 dark:border-[#F2F1E6]/10 pt-4">
          <div className="flex gap-2">
            {user.email && (
              <button
                onClick={sendReset}
                disabled={resettingPw}
                className="text-xs font-mono text-inky/70 dark:text-[#F2F1E6]/50 hover:text-navy dark:hover:text-[#F2F1E6] transition-colors disabled:opacity-40"
              >
                {resettingPw ? 'Sending…' : 'Send Password Reset'}
              </button>
            )}
          </div>
          <div className="flex gap-2">
            {!isSelf && (
              <button
                onClick={() => setConfirmRemove(true)}
                className="text-xs font-mono text-red-400 hover:text-red-500 transition-colors"
              >
                Remove User
              </button>
            )}
            <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" loading={saving} onClick={save}>Save</Button>
          </div>
        </div>
      </div>

      {/* Remove confirmation — nested modal */}
      <Modal open={confirmRemove} onClose={() => setConfirmRemove(false)} title="Remove User?">
        <div className="flex flex-col gap-4">
          <p className="text-sm font-body text-navy dark:text-[#F2F1E6]">
            Remove <span className="font-bold">{user.full_name ?? user.email}</span> from this workspace?
          </p>
          <p className="text-xs font-mono text-inky/70 dark:text-[#F2F1E6]/50">
            Their profile will be hidden and access revoked. You can restore them within 90 days from the Removed Users section.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setConfirmRemove(false)}>Cancel</Button>
            <Button variant="danger" size="sm" onClick={doRemove}>Yes, Remove</Button>
          </div>
        </div>
      </Modal>
    </Modal>
  )
}

// ── Main Page ────────────────────────────────────────────────────────────────

export function UsersPage() {
  const { profile: myProfile, setProfile } = useAuthStore()
  const myRole = myProfile?.role ?? ''
  const amDeveloper = isDeveloper(myRole)

  const [users, setUsers] = useState<UserWithAccess[]>([])
  const [removedUsers, setRemovedUsers] = useState<UserWithAccess[]>([])
  const [loading, setLoading] = useState(true)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [manageUser, setManageUser] = useState<UserWithAccess | null>(null)
  const [search, setSearch] = useState('')
  const [showRemoved, setShowRemoved] = useState(false)

  const load = useCallback(async () => {
    if (!myProfile?.company_id) return
    setLoading(true)
    const sb = supabase as any
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()

    const [activeRes, removedRes] = await Promise.all([
      sb.schema('platform').from('user_profiles')
        .select('*').eq('company_id', myProfile.company_id)
        .is('deleted_at', null).order('created_at'),
      sb.schema('platform').from('user_profiles')
        .select('*').eq('company_id', myProfile.company_id)
        .not('deleted_at', 'is', null)
        .gte('deleted_at', cutoff)
        .order('deleted_at', { ascending: false }),
    ])

    if (activeRes.error) toast.error('Failed to load users')
    else setUsers(activeRes.data ?? [])
    setRemovedUsers(removedRes.data ?? [])
    setLoading(false)
  }, [myProfile?.company_id])

  useEffect(() => { load() }, [load])

  async function restoreUser(u: UserWithAccess) {
    const { error } = await (supabase as any).schema('platform').from('user_profiles').update({ deleted_at: null }).eq('id', u.id)
    if (error) toast.error(error.message)
    else { toast.success(`${u.full_name ?? u.email} restored`); load() }
  }

  async function hardDelete(u: UserWithAccess) {
    const { error } = await (supabase as any).schema('platform').from('user_profiles').delete().eq('id', u.id)
    if (error) toast.error(error.message)
    else { toast.success('User permanently deleted'); load() }
  }

  const filtered = users.filter((u) => {
    const q = search.toLowerCase()
    return !q || (u.full_name ?? '').toLowerCase().includes(q) || (u.email ?? '').toLowerCase().includes(q)
  })

  const isSelf = (u: Profile) => u.id === myProfile?.id
  const canEdit = (u: Profile) => amDeveloper || !isDeveloper(u.role)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-navy dark:text-[#F2F1E6] tracking-wide uppercase">User Management</h1>
          <p className="text-xs text-inky/70 dark:text-[#F2F1E6]/50 mt-0.5">{users.length} user{users.length !== 1 ? 's' : ''} in your workspace</p>
        </div>
        <Button size="sm" onClick={() => setInviteOpen(true)}>+ Invite User</Button>
      </div>

      <div className="max-w-xs">
        <Input placeholder="Search by name or email..." value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {loading ? (
        <div className="text-xs font-mono text-inky/50 animate-pulse">Loading...</div>
      ) : (
        <div className="rounded border border-navy/15 dark:border-[#F2F1E6]/10 overflow-auto max-h-[calc(100vh-300px)]">
          <table className="w-full text-xs font-body">
            <thead className="sticky top-0">
              <tr className="border-b border-navy/10 dark:border-[#F2F1E6]/10 bg-navy/5 dark:bg-[#F2F1E6]/5">
                {['Name', 'Email', 'Role', 'Joined', 'Actions'].map((h) => (
                  <th key={h} className="text-left px-4 py-2.5 font-heading text-[10px] text-inky/70 dark:text-[#F2F1E6]/50 uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-navy/8 dark:divide-[#F2F1E6]/8">
              {filtered.map((u) => {
                const editable = canEdit(u)
                return (
                  <tr key={u.id} className={editable ? '' : 'opacity-50'}>
                    <td className="px-4 py-2.5 text-navy dark:text-[#F2F1E6]">
                      {u.full_name ?? '—'}
                      {isSelf(u) && <span className="ml-1.5 text-[10px] font-mono text-inky/40 dark:text-[#F2F1E6]/30">(you)</span>}
                    </td>
                    <td className="px-4 py-2.5 text-inky dark:text-[#F2F1E6]/70">{u.email}</td>
                    <td className="px-4 py-2.5"><RoleBadge role={u.role} /></td>
                    <td className="px-4 py-2.5 text-inky/60 dark:text-[#F2F1E6]/40 font-mono">
                      {u.created_at ? format(new Date(u.created_at), 'MMM d, yyyy') : '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      {editable ? (
                        <button
                          onClick={() => setManageUser(u)}
                          className="text-xs font-mono text-sky hover:underline"
                        >
                          Manage
                        </button>
                      ) : (
                        <span className="text-[10px] font-mono text-inky/30 dark:text-[#F2F1E6]/20">Developer locked</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Removed Users section */}
      <div className="border-t border-navy/10 dark:border-[#F2F1E6]/10 pt-4">
        <button
          onClick={() => setShowRemoved((v) => !v)}
          className="flex items-center gap-2 text-xs font-mono text-inky/60 dark:text-[#F2F1E6]/40 hover:text-inky dark:hover:text-[#F2F1E6]/70 transition-colors"
        >
          <svg className={['w-3 h-3 transition-transform', showRemoved ? 'rotate-90' : ''].join(' ')} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          Removed Users ({removedUsers.length}) — restorable within 90 days
        </button>

        {showRemoved && removedUsers.length > 0 && (
          <div className="mt-3 rounded border border-navy/15 dark:border-[#F2F1E6]/10 overflow-auto max-h-[40vh]">
            <table className="w-full text-xs font-body">
              <thead className="sticky top-0">
                <tr className="border-b border-navy/10 dark:border-[#F2F1E6]/10 bg-red-50 dark:bg-red-900/10">
                  {['Name', 'Email', 'Removed', 'Days Left', 'Actions'].map((h) => (
                    <th key={h} className="text-left px-4 py-2 font-heading text-[10px] text-inky/70 dark:text-[#F2F1E6]/50 uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-navy/8 dark:divide-[#F2F1E6]/8">
                {removedUsers.map((u) => {
                  const daysLeft = u.deleted_at ? 90 - differenceInDays(new Date(), new Date(u.deleted_at)) : 90
                  return (
                    <tr key={u.id} className="opacity-70">
                      <td className="px-4 py-2 text-navy dark:text-[#F2F1E6]">{u.full_name ?? '—'}</td>
                      <td className="px-4 py-2 text-inky dark:text-[#F2F1E6]/60">{u.email}</td>
                      <td className="px-4 py-2 text-inky/60 dark:text-[#F2F1E6]/40 font-mono">
                        {u.deleted_at ? format(new Date(u.deleted_at), 'MMM d, yyyy') : '—'}
                      </td>
                      <td className="px-4 py-2 font-mono">
                        <span className={daysLeft <= 7 ? 'text-red-400' : 'text-inky/60 dark:text-[#F2F1E6]/40'}>
                          {daysLeft}d
                        </span>
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex gap-3">
                          <button onClick={() => restoreUser(u)} className="text-sky hover:underline">Restore</button>
                          <button onClick={() => hardDelete(u)} className="text-red-400 hover:underline">Delete Forever</button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {showRemoved && removedUsers.length === 0 && (
          <p className="mt-3 text-xs font-mono text-inky/40 dark:text-[#F2F1E6]/30 italic">No recently removed users.</p>
        )}
      </div>

      <InviteUserModal open={inviteOpen} onClose={() => setInviteOpen(false)} onInvited={load} />

      {manageUser && isAdminOrDeveloper(myProfile?.role) && (
        <ManageUserModal
          user={manageUser}
          myProfile={myProfile!}
          amDeveloper={amDeveloper}
          onClose={() => setManageUser(null)}
          onSaved={() => {
            load()
            if (manageUser.id === myProfile?.id) {
              // refresh own profile
            }
          }}
          onRemoved={load}
        />
      )}
    </div>
  )
}
