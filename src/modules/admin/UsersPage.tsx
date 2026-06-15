import { useEffect, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { DataTable } from '@/components/shared/DataTable'
import { useTable } from '@/hooks/useTable'
import { Button, Badge, Modal, Select } from '@/components/ui'
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
  const { profile: myProfile } = useAuthStore()
  const [users, setUsers] = useState<Profile[]>([])
  const [loading, setLoading] = useState(true)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [editUser, setEditUser] = useState<Profile | null>(null)
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
              onClick={() => { setEditUser(u); setEditRole(u.role) }}
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
      .from('profiles')
      .select('*')
      .eq('company_id', myProfile.company_id)
      .order('created_at')
    if (error) toast.error('Failed to load users')
    else setUsers(data ?? [])
    setLoading(false)
  }

  async function saveRole() {
    if (!editUser) return
    setEditLoading(true)
    const { error } = await (supabase as any)
      .from('profiles')
      .update({ role: editRole })
      .eq('id', editUser.id)
    if (error) toast.error(error.message)
    else { toast.success('Role updated'); await load() }
    setEditLoading(false)
    setEditUser(null)
  }

  async function removeUser() {
    if (!deleteConfirm) return
    const { error } = await (supabase as any)
      .from('profiles')
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

      {/* Edit role modal */}
      <Modal open={!!editUser} onClose={() => setEditUser(null)} title="Edit User Role">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-navy font-mono">
            {editUser?.full_name ?? editUser?.email}
          </p>
          <Select
            label="Role"
            value={editRole}
            onChange={(e) => setEditRole(e.target.value as 'user' | 'admin')}
            options={[
              { value: 'user', label: 'User — standard access' },
              { value: 'admin', label: 'Admin — can manage config & users' },
            ]}
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setEditUser(null)}>Cancel</Button>
            <Button size="sm" loading={editLoading} onClick={saveRole}>Save</Button>
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
