import { useState, useEffect } from 'react'

export type VisibilityValue = 'private' | 'department' | 'attendees' | 'specific_users'

export interface SlimUser {
  id: string
  full_name: string | null
  email: string
  department?: string | null
}

const VISIBILITY_OPTIONS: { value: VisibilityValue; icon: string; label: string; desc: string }[] = [
  { value: 'private',        icon: '🔒', label: 'Private',        desc: 'Only visible to you' },
  { value: 'department',     icon: '🏢', label: 'Department',     desc: 'Visible to your department' },
  { value: 'attendees',      icon: '🤝', label: 'Attendees',      desc: 'Visible to tagged participants' },
  { value: 'specific_users', icon: '👥', label: 'Specific Users', desc: 'You choose who can see this' },
]

interface Props {
  value: VisibilityValue
  onChange: (v: VisibilityValue) => void
  participants: SlimUser[]
  onParticipantsChange: (users: SlimUser[]) => void
  specificUsers: SlimUser[]
  onSpecificUsersChange: (users: SlimUser[]) => void
  allUsers: SlimUser[]
  departmentName?: string | null
  /** Available departments for this user (admin = all, others = own only).
   *  If provided and length === 1, auto-selects department visibility. */
  departments?: string[]
  onDepartmentChange?: (dept: string) => void
  label?: string
  disabled?: boolean
}

function UserSearch({ allUsers, excludeIds, onAdd }: {
  allUsers: SlimUser[]
  excludeIds: Set<string>
  onAdd: (u: SlimUser) => void
}) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const filtered = allUsers.filter(
    (u) => !excludeIds.has(u.id) &&
    (u.full_name?.toLowerCase().includes(q.toLowerCase()) || u.email.toLowerCase().includes(q.toLowerCase()))
  ).slice(0, 8)

  return (
    <div className="relative">
      <input
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        placeholder="Search by name or email…"
        className="w-full rounded border border-navy/30 bg-cream px-2 py-1.5 text-xs font-mono text-navy placeholder-inky/50 focus:border-sky focus:outline-none"
      />
      {open && q.length > 0 && filtered.length > 0 && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute z-50 mt-1 w-full rounded border border-navy/20 bg-cream shadow-lg py-0.5">
            {filtered.map((u) => (
              <button
                key={u.id}
                onClick={() => { onAdd(u); setQ(''); setOpen(false) }}
                className="flex w-full items-center gap-2 px-2 py-1.5 text-xs font-mono text-navy hover:bg-navy/5 text-left"
              >
                <span className="font-medium">{u.full_name ?? u.email}</span>
                {u.full_name && <span className="text-inky/50">{u.email}</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

export function VisibilitySelector({
  value, onChange,
  participants, onParticipantsChange,
  specificUsers, onSpecificUsersChange,
  allUsers,
  departmentName,
  departments,
  onDepartmentChange,
  label = 'Visibility',
  disabled = false,
}: Props) {
  const [selectedDept, setSelectedDept] = useState<string>(
    departmentName ?? departments?.[0] ?? ''
  )

  // Auto-select department visibility when only one dept is available
  useEffect(() => {
    if (departments?.length === 1 && value === 'private') {
      onChange('department')
      setSelectedDept(departments[0])
      onDepartmentChange?.(departments[0])
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [departments?.length])

  // Resolve the display dept name: prefer selectedDept, fall back to departmentName
  const effectiveDeptName = selectedDept || departmentName

  return (
    <div className={['flex flex-col gap-2', disabled ? 'opacity-50 pointer-events-none' : ''].join(' ')}>
      {label && (
        <label className="text-xs font-mono text-inky uppercase tracking-wide">{label}</label>
      )}

      {/* Four-option picker */}
      <div className="flex flex-col gap-1">
        {VISIBILITY_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            title={opt.desc}
            className={[
              'flex items-center gap-2 px-2.5 py-1.5 rounded border text-xs font-mono transition-colors text-left',
              value === opt.value
                ? 'border-sky/60 bg-sky/10 text-navy'
                : 'border-navy/20 bg-cream text-inky hover:border-navy/40',
            ].join(' ')}
          >
            <span>{opt.icon}</span>
            <span>{opt.label}</span>
          </button>
        ))}
      </div>

      {/* Context below the picker */}
      {value === 'private' && (
        <p className="text-[10px] font-mono text-inky/60">Only visible to you.</p>
      )}

      {value === 'department' && (
        <div className="flex flex-col gap-1.5">
          {departments && departments.length > 1 && (
            <select
              value={selectedDept}
              onChange={(e) => {
                setSelectedDept(e.target.value)
                onDepartmentChange?.(e.target.value)
              }}
              className="rounded border border-navy/20 bg-cream text-xs font-mono text-navy px-2 py-1 focus:border-sky focus:outline-none"
            >
              <option value="">Select department…</option>
              {departments.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          )}
          {(() => {
            const deptMembers = allUsers.filter(
              (u) => effectiveDeptName && u.department === effectiveDeptName
            )
            if (!effectiveDeptName || deptMembers.length === 0) {
              return (
                <p className="text-[10px] font-mono text-inky/60">
                  Visible to all members of {effectiveDeptName ? <strong>{effectiveDeptName}</strong> : 'your department'}.
                </p>
              )
            }
            return (
              <>
                <p className="text-[10px] font-mono text-inky/60">
                  Shared with <strong>{effectiveDeptName}</strong> — remove anyone to switch to specific users:
                </p>
                <ul className="flex flex-col gap-0.5">
                  {deptMembers.map((u) => (
                    <li key={u.id} className="flex items-center justify-between gap-2 rounded bg-navy/5 px-2 py-1">
                      <span className="text-xs font-mono text-navy">{u.full_name ?? u.email}</span>
                      <button
                        onClick={() => {
                          const remaining = deptMembers.filter((m) => m.id !== u.id)
                          onChange('specific_users')
                          onSpecificUsersChange(remaining)
                        }}
                        className="text-[10px] text-inky/40 hover:text-[#C0392B] transition-colors flex-shrink-0"
                        title="Remove from share list"
                      >✕</button>
                    </li>
                  ))}
                </ul>
              </>
            )
          })()}
        </div>
      )}

      {value === 'attendees' && (
        <div className="flex flex-col gap-1.5">
          {participants.length > 0 && (
            <ul className="flex flex-col gap-0.5">
              {participants.map((u) => (
                <li key={u.id} className="flex items-center justify-between gap-2 rounded bg-navy/5 px-2 py-1">
                  <span className="text-xs font-mono text-navy">{u.full_name ?? u.email}</span>
                  <button
                    onClick={() => onParticipantsChange(participants.filter((p) => p.id !== u.id))}
                    className="text-[10px] text-inky/40 hover:text-red-500 transition-colors"
                  >✕</button>
                </li>
              ))}
            </ul>
          )}
          <UserSearch
            allUsers={allUsers}
            excludeIds={new Set(participants.map((p) => p.id))}
            onAdd={(u) => onParticipantsChange([...participants, u])}
          />
          {participants.length === 0 && (
            <p className="text-[10px] font-mono text-inky/50">Add participants to share this item.</p>
          )}
        </div>
      )}

      {value === 'specific_users' && (
        <div className="flex flex-col gap-1.5">
          {specificUsers.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {specificUsers.map((u) => (
                <span key={u.id} className="flex items-center gap-1 rounded-full bg-navy/10 px-2 py-0.5 text-[10px] font-mono text-navy">
                  {u.full_name ?? u.email}
                  <button
                    onClick={() => onSpecificUsersChange(specificUsers.filter((s) => s.id !== u.id))}
                    className="text-inky/40 hover:text-red-500 ml-0.5"
                  >✕</button>
                </span>
              ))}
            </div>
          )}
          <UserSearch
            allUsers={allUsers}
            excludeIds={new Set(specificUsers.map((u) => u.id))}
            onAdd={(u) => onSpecificUsersChange([...specificUsers, u])}
          />
          {specificUsers.length === 0 && (
            <p className="text-[10px] font-mono text-inky/50">Search to add specific users.</p>
          )}
        </div>
      )}
    </div>
  )
}
