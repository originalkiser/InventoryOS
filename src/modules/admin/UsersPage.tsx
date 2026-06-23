import { useEffect, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { DataTable } from '@/components/shared/DataTable'
import { useTable } from '@/hooks/useTable'
import { Button, Badge, Modal, Select, Input } from '@/components/ui'
import { InviteUserModal } from './InviteUserModal'
import type { Profile } from '@/types'
import { format } from 'date-fns'
import toast from 'react-hot-toast'

const col = createColumnHelper<Profile>()

const COLUMNS = [
  col.accessor('full_name', { header: 'Name', cell: (i) => i.getValue() ?? '—' }),
  col.accessor('email', { header: 'Email', cell: (i) => i.getValue() ?? '—' }),
  col.accessor('role', {
    header: 'Role',
    cell: (i) => (
      <Badge color={i.getValue() === 'admin' ? 'cyan' : 'gray'}>
        {i.getValue()}
      </Badge>
    ),
  }),
  col.accessor('created_at', {
    header: 'Joined',
    cell: (i) => format(new Date(i.getValue()), 'MMM d, yyyy'),
  }),
]

export function UsersPage() {
  const { profile: myProfile, setProfile } = useAuthStore()
  const [users, setUsers] = useState<Profile[]>([])
  const [loading, setLoading] = useState(true)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [editUser, setEditUser] = useState<Profile | null>(null)
  const [editName, setEditName] = useState('')
  const [editRole, setEditRole] = useState<'user' | 'admin'>('user')
  const [editLoading, setEditLoading] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState<Profile | null>(null)

  const { table, globalFilter, setGlobalFilter } = useTable(users, [
    ...COLUMNS,
    col.display({
      id: 'actions',
      header: 'Actions',
      cell: ({ row }) => {
        const u = row.original
        const isSelf = u.id === myProfile?.id
        return (
          <div className="flex gap-2">
            <button
              onClick={() => { setEditUser(u); setEditRole(u.role); setEditName(u.full_name ?? '') }}
              className="text-xs text-inky hover:underline font-mono"
            >
              Edit
            </button>
            {!isSelf && (
              <button
                onClick={() => setDeleteConfirm(u)}
                className="text-xs text-red-400 hover:underline font-mono"
              >
                Remove
              </button>
            )}
          </div>
        )
      },
    }),
  ])

  useEffect(() => {
    if (!myProfile?.company_id) return
    load()
  }, [myProfile?.company_id])

  async function load() {
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
  }

  async function saveUser() {
    if (!editUser) return
    setEditLoading(true)
    const sb = supabase as any
    const newName = editName.trim() || null
    const oldName = editUser.full_name ?? null
    const isSelf = editUser.id === myProfile?.id

    // For the logged-in user: update Supabase Auth metadata first. Some projects
    // have a trigger that syncs auth.users → profiles; doing this first ensures
    // that trigger fires with the new name before we overwrite via PostgREST.
    if (isSelf) {
      await sb.auth.updateUser({ data: { full_name: newName } })
    }

    // Use .select() so we can detect a silent RLS block — Supabase returns HTTP
    // 200 with no error but 0 rows when a policy filters out the target row.
    const { data: updated, error } = await sb
      .schema('platform').from('user_profiles')
      .update({ role: editRole, full_name: newName })
      .eq('id', editUser.id)
      .select('id, full_name, role')

    if (error) {
      toast.error(error.message)
      setEditLoading(false)
      return
    }

    if (!updated || updated.length === 0) {
      // RLS silently blocked the write. Log the fix SQL to the console.
      console.warn(
        '[UsersPage] Profile update blocked by RLS. Run this in your Supabase SQL editor:\n\n' +
        'CREATE POLICY "admins_update_company_profiles" ON profiles\n' +
        'FOR UPDATE TO authenticated\n' +
        'USING (\n' +
        '  auth.uid() = id OR\n' +
        '  EXISTS (\n' +
        '    SELECT 1 FROM profiles p\n' +
        '    WHERE p.id = auth.uid()\n' +
        '      AND p.company_id = profiles.company_id\n' +
        '      AND p.role = \'admin\'\n' +
        '  )\n' +
        ')\n' +
        'WITH CHECK (\n' +
        '  auth.uid() = id OR\n' +
        '  EXISTS (\n' +
        '    SELECT 1 FROM profiles p\n' +
        '    WHERE p.id = auth.uid()\n' +
        '      AND p.company_id = profiles.company_id\n' +
        '      AND p.role = \'admin\'\n' +
        '  )\n' +
        ');'
      )
      toast.error('Update blocked by a database policy — see the browser console for the SQL fix.')
      setEditLoading(false)
      return
    }

    // Cascade free-text name fields in tasks, project_tasks, and issues
    // only when the name actually changed and there was an old name to match on.
    if (newName && oldName && newName !== oldName && myProfile?.company_id) {
      await Promise.all([
        sb.schema('inventory').from('tasks')
          .update({ assignee_name: newName })
          .eq('company_id', myProfile.company_id)
          .eq('assignee_name', oldName)
          .is('assignee_id', null),
        sb.schema('inventory').from('project_tasks')
          .update({ assignee: newName })
          .eq('company_id', myProfile.company_id)
          .eq('assignee', oldName),
        sb.schema('inventory').from('issues')
          .update({ assignee: newName })
          .eq('company_id', myProfile.company_id)
          .eq('assignee', oldName),
      ])
    }

    // Refresh the Zustand store so the sidebar and any cached name updates immediately.
    if (isSelf) {
      setProfile({ ...myProfile!, full_name: newName, role: editRole })
    }

    toast.success('User updated')
    await load()
    setEditLoading(false)
    setEditUser(null)
  }

  async function removeUser() {
    if (!deleteConfirm) return
    const { error } = await (supabase as any)
      .schema('platform').from('user_profiles')
      .delete()
      .eq('id', deleteConfirm.id)
    if (error) toast.error(error.message)
    else { toast.success('User removed from workspace'); await load() }
    setDeleteConfirm(null)
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">User Management</h1>
          <p className="text-xs text-inky mt-0.5">
            {users.length} user{users.length !== 1 ? 's' : ''} in your workspace
          </p>
        </div>
      </div>

      <DataTable
        table={table}
        globalFilter={globalFilter}
        onGlobalFilterChange={setGlobalFilter}
        exportFilename="users.csv"
        exportData={users}
        loading={loading}
        actions={
          <Button size="sm" onClick={() => setInviteOpen(true)}>
            + Invite User
          </Button>
        }
      />

      {/* Invite modal */}
      <InviteUserModal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onInvited={load}
      />

      {/* Edit user modal */}
      <Modal open={!!editUser} onClose={() => setEditUser(null)} title="Edit User">
        <div className="flex flex-col gap-4">
          <p className="text-xs font-mono text-inky">{editUser?.email}</p>
          <Input
            label="Display Name"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            placeholder="Full name..."
          />
          <Select
            label="Role"
            value={editRole}
            onChange={(e) => setEditRole(e.target.value as 'user' | 'admin')}
            options={[
              { value: 'user', label: 'User — standard access' },
              { value: 'admin', label: 'Admin — can manage config & users' },
            ]}
          />
          {editUser?.full_name && editName.trim() && editName.trim() !== editUser.full_name && (
            <p className="text-[11px] font-mono text-inky/70 bg-navy/5 border border-navy/20 rounded px-3 py-2">
              Renaming <span className="text-navy">{editUser.full_name}</span> → <span className="text-navy">{editName.trim()}</span> will also update any tasks, project tasks, and issues assigned to this name.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setEditUser(null)}>Cancel</Button>
            <Button size="sm" loading={editLoading} onClick={saveUser}>Save</Button>
          </div>
        </div>
      </Modal>

      {/* Remove confirmation */}
      <Modal open={!!deleteConfirm} onClose={() => setDeleteConfirm(null)} title="Remove User">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-navy font-mono">
            Remove <span className="text-navy">{deleteConfirm?.full_name ?? deleteConfirm?.email}</span> from this workspace?
          </p>
          <p className="text-xs text-inky font-mono">
            This removes their profile but does not delete their Supabase auth account.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setDeleteConfirm(null)}>Cancel</Button>
            <Button variant="danger" size="sm" onClick={removeUser}>Remove</Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
