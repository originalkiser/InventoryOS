import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { Button, Modal, Input } from '@/components/ui'
import { InviteUserModal } from './InviteUserModal'
import { ROLES, ROLE_OPTIONS, getRoleLabel, isDeveloper } from '@/lib/roles'
import type { Profile } from '@/types'
import { format } from 'date-fns'
import toast from 'react-hot-toast'

type RoleValue = typeof ROLES[keyof typeof ROLES] | 'admin' | 'user'

const ROLE_BADGE_COLOR: Record<string, string> = {
  developer: 'bg-purple-100 text-purple-800',
  administrator: 'bg-cyan-100 text-cyan-800',
  admin: 'bg-cyan-100 text-cyan-800',
  director: 'bg-blue-100 text-blue-800',
  area_manager: 'bg-sky/20 text-navy',
  department_user: 'bg-navy/10 text-inky',
  user: 'bg-navy/10 text-inky',
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
}

function RoleBadge({ role }: { role: string | null | undefined }) {
  const cls = ROLE_BADGE_COLOR[role ?? ''] ?? 'bg-navy/10 text-inky'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono ${cls}`}>
      {getRoleLabel(role)}
    </span>
  )
}

export function UsersPage() {
  const { profile: myProfile, setProfile } = useAuthStore()
  const myRole = myProfile?.role ?? ''
  const amDeveloper = isDeveloper(myRole)

  const [users, setUsers] = useState<UserWithAccess[]>([])
  const [loading, setLoading] = useState(true)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [editUser, setEditUser] = useState<UserWithAccess | null>(null)
  const [editName, setEditName] = useState('')
  const [editRole, setEditRole] = useState<RoleValue>(ROLES.DEPARTMENT_USER)
  const [editAccess, setEditAccess] = useState<Set<string>>(new Set())
  const [editLoading, setEditLoading] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState<Profile | null>(null)
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    if (!myProfile?.company_id) return
    setLoading(true)
    const { data, error } = await (supabase as any)
      .schema('platform').from('user_profiles')
      .select('*')
      .eq('company_id', myProfile.company_id)
      .order('created_at')
    if (error) toast.error('Failed to load users')
    else setUsers(data ?? [])
    setLoading(false)
  }, [myProfile?.company_id])

  useEffect(() => { load() }, [load])

  async function openEdit(u: UserWithAccess) {
    setEditUser(u)
    setEditName(u.full_name ?? '')
    setEditRole((u.role as RoleValue) ?? ROLES.DEPARTMENT_USER)
    const sb = supabase as any
    const { data } = await sb.schema('core').from('user_feature_access')
      .select('feature_key').eq('user_id', u.id).eq('enabled', true)
    setEditAccess(new Set((data ?? []).map((r: any) => r.feature_key as string)))
  }

  function toggleAccess(key: string) {
    setEditAccess((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
        // deselecting a dept → also deselect its modules
        MODULE_OPTIONS.filter((m) => m.dept === key).forEach((m) => next.delete(m.key))
      } else {
        next.add(key)
        // selecting a dept → auto-select all its modules
        MODULE_OPTIONS.filter((m) => m.dept === key).forEach((m) => next.add(m.key))
      }
      return next
    })
  }

  async function saveUser() {
    if (!editUser) return
    setEditLoading(true)
    const sb = supabase as any
    const newName = editName.trim() || null
    const oldName = editUser.full_name ?? null
    const isSelf = editUser.id === myProfile?.id
    const roleToSave = isSelf ? (editUser.role as RoleValue) : editRole

    if (isSelf) await sb.auth.updateUser({ data: { full_name: newName } })

    const { data: updated, error } = await sb
      .schema('platform').from('user_profiles')
      .update({ role: roleToSave, full_name: newName })
      .eq('id', editUser.id)
      .select('id, full_name, role')

    if (error) { toast.error(error.message); setEditLoading(false); return }
    if (!updated || updated.length === 0) {
      toast.error('Update blocked — check database RLS policies.')
      setEditLoading(false)
      return
    }

    const allKeys = [...DEPT_OPTIONS.map((d) => d.key), ...MODULE_OPTIONS.map((m) => m.key)]
    await sb.schema('core').from('user_feature_access').upsert(
      allKeys.map((key) => ({
        user_id: editUser.id,
        company_id: myProfile!.company_id,
        feature_key: key,
        enabled: editAccess.has(key),
      })),
      { onConflict: 'user_id,feature_key' }
    )

    if (newName && oldName && newName !== oldName && myProfile?.company_id) {
      await Promise.all([
        sb.schema('inventory').from('tasks').update({ assignee_name: newName }).eq('company_id', myProfile.company_id).eq('assignee_name', oldName).is('assignee_id', null),
        sb.schema('inventory').from('project_tasks').update({ assignee: newName }).eq('company_id', myProfile.company_id).eq('assignee', oldName),
        sb.schema('inventory').from('issues').update({ assignee: newName }).eq('company_id', myProfile.company_id).eq('assignee', oldName),
      ])
    }

    if (isSelf) setProfile({ ...myProfile!, full_name: newName, role: roleToSave as any })
    toast.success('User updated')
    await load()
    setEditLoading(false)
    setEditUser(null)
  }

  async function removeUser() {
    if (!deleteConfirm) return
    const { error } = await (supabase as any).schema('platform').from('user_profiles').delete().eq('id', deleteConfirm.id)
    if (error) toast.error(error.message)
    else { toast.success('User removed'); await load() }
    setDeleteConfirm(null)
  }

  async function sendPasswordReset(email: string) {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}${import.meta.env.BASE_URL}reset-password`,
    })
    if (error) toast.error(error.message)
    else toast.success(`Password reset email sent to ${email}`)
  }

  const filtered = users.filter((u) => {
    const q = search.toLowerCase()
    return !q || (u.full_name ?? '').toLowerCase().includes(q) || (u.email ?? '').toLowerCase().includes(q)
  })

  const isSelf = (u: Profile) => u.id === myProfile?.id
  const canEdit = (u: Profile) => amDeveloper || !isDeveloper(u.role)
  const needsAccessConfig = (role: RoleValue) =>
    ([ROLES.DEPARTMENT_USER, ROLES.AREA_MANAGER, ROLES.DIRECTOR] as string[]).includes(role)
  const activeDepts = DEPT_OPTIONS.filter((d) => editAccess.has(d.key))

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-navy dark:text-cream tracking-wide uppercase">User Management</h1>
          <p className="text-xs text-inky mt-0.5">{users.length} user{users.length !== 1 ? 's' : ''} in your workspace</p>
        </div>
        <Button size="sm" onClick={() => setInviteOpen(true)}>+ Invite User</Button>
      </div>

      <div className="max-w-xs">
        <Input placeholder="Search by name or email..." value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {loading ? (
        <div className="text-xs font-mono text-inky/50 animate-pulse">Loading...</div>
      ) : (
        <div className="rounded border border-navy/15 overflow-hidden">
          <table className="w-full text-xs font-body">
            <thead>
              <tr className="border-b border-navy/10 dark:border-[#F2F1E6]/10 bg-navy/5 dark:bg-[#F2F1E6]/5">
                {['Name', 'Email', 'Role', 'Joined', 'Actions'].map((h) => (
                  <th key={h} className="text-left px-4 py-2.5 font-heading text-[10px] text-inky uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-navy/8 dark:divide-[#F2F1E6]/8">
              {filtered.map((u) => {
                const editable = canEdit(u)
                return (
                  <tr key={u.id} className={editable ? '' : 'opacity-50'}>
                    <td className="px-4 py-2.5 text-navy dark:text-cream">
                      {u.full_name ?? '—'}
                      {isSelf(u) && <span className="ml-1.5 text-[10px] font-mono text-inky/40">(you)</span>}
                    </td>
                    <td className="px-4 py-2.5 text-inky dark:text-[#F2F1E6]/70">{u.email}</td>
                    <td className="px-4 py-2.5"><RoleBadge role={u.role} /></td>
                    <td className="px-4 py-2.5 text-inky/60 dark:text-[#F2F1E6]/50 font-mono">
                      {u.created_at ? format(new Date(u.created_at), 'MMM d, yyyy') : '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      {editable ? (
                        <div className="flex gap-3">
                          <button onClick={() => openEdit(u)} className="text-inky hover:underline">Edit</button>
                          {u.email && (
                            <button onClick={() => sendPasswordReset(u.email!)} className="text-inky/60 hover:underline">Reset PW</button>
                          )}
                          {!isSelf(u) && (
                            <button onClick={() => setDeleteConfirm(u)} className="text-red-400 hover:underline">Remove</button>
                          )}
                        </div>
                      ) : (
                        <span className="text-[10px] font-mono text-inky/30">Developer locked</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <InviteUserModal open={inviteOpen} onClose={() => setInviteOpen(false)} onInvited={load} />

      <Modal open={!!editUser} onClose={() => setEditUser(null)} title="Edit User">
        {editUser && (
          <div className="flex flex-col gap-5">
            <p className="text-[10px] font-mono text-inky/50">{editUser.email}</p>

            <Input label="Display Name" value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Full name..." />

            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-heading text-inky uppercase tracking-wide">Role</label>
              {isSelf(editUser) ? (
                <div className="rounded border border-navy/20 bg-navy/5 px-3 py-2 text-xs font-mono text-inky/60">
                  {getRoleLabel(editUser.role)} cannot change your own role
                </div>
              ) : (
                <div className="flex flex-col gap-2.5 max-h-64 overflow-y-auto pr-1">
                  {ROLE_OPTIONS
                    .filter((opt) => amDeveloper || opt.value !== ROLES.DEVELOPER)
                    .map((opt) => (
                      <label key={opt.value} className="flex items-start gap-2.5 cursor-pointer">
                        <input
                          type="radio"
                          name="edit-role"
                          value={opt.value}
                          checked={editRole === opt.value}
                          onChange={() => setEditRole(opt.value as RoleValue)}
                          className="mt-0.5 accent-navy flex-shrink-0"
                        />
                        <div>
                          <div className="text-xs font-heading text-navy dark:text-cream">{opt.label}</div>
                          <div className="text-[10px] font-body text-inky/60 leading-relaxed">{opt.description}</div>
                        </div>
                      </label>
                    ))}
                </div>
              )}
            </div>

            {needsAccessConfig(isSelf(editUser) ? (editUser.role as RoleValue) : editRole) && (
              <div className="flex flex-col gap-3 border-t border-navy/10 pt-4">
                <div className="text-[10px] font-heading text-inky uppercase tracking-wide">Department Access</div>
                <div className="grid grid-cols-2 gap-2">
                  {DEPT_OPTIONS.map((d) => (
                    <label key={d.key} className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={editAccess.has(d.key)} onChange={() => toggleAccess(d.key)} className="accent-navy" />
                      <span className="text-xs font-body text-navy dark:text-cream">{d.label}</span>
                    </label>
                  ))}
                </div>
                {activeDepts.some((d) => d.key === 'dept:inventory') && (
                  <div className="flex flex-col gap-2 pl-3 border-l border-navy/15">
                    <div className="text-[10px] font-heading text-inky/60 uppercase tracking-wide">Inventory Modules</div>
                    {MODULE_OPTIONS.filter((m) => m.dept === 'dept:inventory').map((m) => (
                      <label key={m.key} className="flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" checked={editAccess.has(m.key)} onChange={() => toggleAccess(m.key)} className="accent-navy" />
                        <span className="text-xs font-body text-navy dark:text-cream">{m.label}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}

            {editUser.full_name && editName.trim() && editName.trim() !== editUser.full_name && (
              <p className="text-[11px] font-mono text-inky/70 bg-navy/5 border border-navy/20 rounded px-3 py-2">
                Renaming {editUser.full_name} to {editName.trim()} will also update tasks, project tasks, and issues assigned to this name.
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setEditUser(null)}>Cancel</Button>
              <Button size="sm" loading={editLoading} onClick={saveUser}>Save</Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={!!deleteConfirm} onClose={() => setDeleteConfirm(null)} title="Remove User">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-navy font-mono">
            Remove {deleteConfirm?.full_name ?? deleteConfirm?.email} from this workspace?
          </p>
          <p className="text-xs text-inky font-mono">This removes their profile but does not delete their auth account.</p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setDeleteConfirm(null)}>Cancel</Button>
            <Button variant="danger" size="sm" onClick={removeUser}>Remove</Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
