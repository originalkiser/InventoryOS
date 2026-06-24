import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { loadFormWithFields } from '@/hooks/useForms'
import { useAuthStore } from '@/stores/authStore'
import { Button, Badge } from '@/components/ui'
import { downloadAssignmentTemplate } from '@/lib/formImportTemplate'
import * as XLSX from 'xlsx'
import type { FormDefinition, FormAssignment, AssignmentRule } from '@/types/forms'
import type { Profile } from '@/types'
import { format, isPast, parseISO } from 'date-fns'
import toast from 'react-hot-toast'

const sb = supabase as any

const DEPARTMENTS = ['Inventory', 'Operations', 'Finance', 'Accounting', 'Marketing', 'HR']

interface AssignmentRow extends FormAssignment {
  profile?: Profile
  location?: { id: string; name: string }
}

interface BulkRow {
  id: string
  email: string
  dueDate: string
  notes: string
  resolvedProfile: Profile | null
  selected: boolean
}

type DrawerType = 'assignment' | 'rule' | null

// ── Rule Builder Drawer ───────────────────────────────────────────────────────

function RuleDrawer({
  formId, profile, editRule, profiles, locations, onSaved, onClose,
}: {
  formId: string
  profile: any
  editRule: AssignmentRule | null
  profiles: Profile[]
  locations: { id: string; name: string }[]
  onSaved: (rule: AssignmentRule) => void
  onClose: () => void
}) {
  const [ruleName, setRuleName] = useState(editRule?.rule_name ?? '')
  const [ruleType, setRuleType] = useState<AssignmentRule['rule_type']>(editRule?.rule_type ?? 'interval')
  const [intervalUnit, setIntervalUnit] = useState<string>(editRule?.interval_unit ?? 'month')
  const [intervalValue, setIntervalValue] = useState(String(editRule?.interval_value ?? 1))
  const [intervalStart, setIntervalStart] = useState(editRule?.interval_start_date ?? '')
  const [setDates, setSetDates] = useState<string[]>(editRule?.set_dates ?? [])
  const [newDate, setNewDate] = useState('')
  const [assignToType, setAssignToType] = useState<AssignmentRule['assign_to_type']>(editRule?.assign_to_type ?? 'users')
  const [selectedUsers, setSelectedUsers] = useState<string[]>(editRule?.assign_to_users ?? [])
  const [selectedLocations, setSelectedLocations] = useState<string[]>(editRule?.assign_to_locations ?? [])
  const [deptName, setDeptName] = useState(editRule?.assign_to_department ?? '')
  const [dueOffset, setDueOffset] = useState(String(editRule?.due_offset_days ?? 7))
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!ruleName.trim()) { toast.error('Rule name required'); return }
    setSaving(true)
    const payload = {
      form_id: formId,
      rule_name: ruleName.trim(),
      rule_type: ruleType,
      interval_unit: ruleType === 'interval' ? intervalUnit : null,
      interval_value: ruleType === 'interval' ? Number(intervalValue) : null,
      interval_start_date: ruleType === 'interval' ? (intervalStart || null) : null,
      set_dates: ruleType === 'set_dates' ? setDates : null,
      assign_to_type: assignToType,
      assign_to_users: assignToType === 'users' ? selectedUsers : null,
      assign_to_locations: assignToType === 'locations' ? selectedLocations : null,
      assign_to_department: assignToType === 'department' ? deptName : null,
      due_offset_days: Number(dueOffset),
      is_active: true,
      created_by: profile?.id,
    }
    if (editRule) {
      const { data, error } = await sb.schema('forms').from('assignment_rules')
        .update({ ...payload, updated_at: new Date().toISOString() })
        .eq('id', editRule.id).select().single()
      setSaving(false)
      if (error) { toast.error(error.message); return }
      onSaved(data as AssignmentRule)
    } else {
      const { data, error } = await sb.schema('forms').from('assignment_rules')
        .insert(payload).select().single()
      setSaving(false)
      if (error) { toast.error(error.message); return }
      onSaved(data as AssignmentRule)
    }
    toast.success(editRule ? 'Rule updated' : 'Rule created')
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-navy/60 backdrop-blur-sm">
      <div className="w-full max-w-lg bg-cream rounded-t-2xl sm:rounded-lg border border-navy/30 shadow-2xl flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-navy/20 flex-shrink-0">
          <h3 className="text-sm font-heading font-bold text-navy uppercase tracking-wide">
            {editRule ? 'Edit' : 'New'} Assignment Rule
          </h3>
          <button onClick={onClose} className="text-inky/50 hover:text-navy">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-mono text-inky uppercase tracking-wide">Rule Name</label>
            <input value={ruleName} onChange={(e) => setRuleName(e.target.value)}
              placeholder="e.g. Monthly Compliance Check"
              className="rounded border border-navy/30 bg-cream px-2 py-1.5 text-xs font-mono text-navy focus:border-[#00e5ff] focus:outline-none" />
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-[10px] font-mono text-inky uppercase tracking-wide">Schedule Type</label>
            {(['interval', 'set_dates'] as const).map((t) => (
              <label key={t} className="flex items-start gap-2 cursor-pointer">
                <input type="radio" name="ruleType" value={t} checked={ruleType === t}
                  onChange={() => setRuleType(t)} className="mt-0.5 accent-navy" />
                <div className="flex-1">
                  <div className="text-xs font-mono text-navy">
                    {t === 'interval' ? 'Recurring Interval' : 'Specific Dates'}
                  </div>
                  {ruleType === t && t === 'interval' && (
                    <div className="flex flex-wrap items-center gap-2 mt-2">
                      <span className="text-xs font-mono text-inky">Every</span>
                      <input type="number" value={intervalValue} onChange={(e) => setIntervalValue(e.target.value)} min={1}
                        className="w-14 rounded border border-navy/30 bg-cream px-1.5 py-1 text-xs font-mono text-navy focus:border-[#00e5ff] focus:outline-none" />
                      <select value={intervalUnit} onChange={(e) => setIntervalUnit(e.target.value)}
                        className="rounded border border-navy/30 bg-cream px-1.5 py-1 text-xs font-mono text-navy focus:border-[#00e5ff] focus:outline-none">
                        {['day', 'week', 'month', 'quarter', 'year'].map((u) => <option key={u} value={u}>{u}</option>)}
                      </select>
                      <span className="text-xs font-mono text-inky">starting</span>
                      <input type="date" value={intervalStart} onChange={(e) => setIntervalStart(e.target.value)}
                        className="rounded border border-navy/30 bg-cream px-1.5 py-1 text-xs font-mono text-navy focus:border-[#00e5ff] focus:outline-none" />
                    </div>
                  )}
                  {ruleType === t && t === 'set_dates' && (
                    <div className="mt-2 flex flex-col gap-2">
                      <div className="flex items-center gap-2">
                        <input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)}
                          className="rounded border border-navy/30 bg-cream px-1.5 py-1 text-xs font-mono text-navy focus:border-[#00e5ff] focus:outline-none" />
                        <button onClick={() => {
                          if (newDate) { setSetDates((p) => [...new Set([...p, newDate])].sort()); setNewDate('') }
                        }} className="text-xs font-mono border border-navy/20 rounded px-2 py-1 text-inky hover:border-navy/40">
                          + Add
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {setDates.map((d) => (
                          <span key={d} className="flex items-center gap-1 text-[10px] font-mono bg-navy/5 border border-navy/20 rounded px-1.5 py-0.5">
                            {format(new Date(d + 'T00:00'), 'MMM d, yyyy')}
                            <button onClick={() => setSetDates((p) => p.filter((x) => x !== d))}
                              className="text-inky/40 hover:text-red-500 ml-0.5">✕</button>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </label>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <label className="text-[10px] font-mono text-inky uppercase tracking-wide whitespace-nowrap">Due offset</label>
            <input type="number" value={dueOffset} onChange={(e) => setDueOffset(e.target.value)} min={0}
              className="w-14 rounded border border-navy/30 bg-cream px-1.5 py-1 text-xs font-mono text-navy focus:border-[#00e5ff] focus:outline-none" />
            <span className="text-xs font-mono text-inky">days after assignment</span>
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-[10px] font-mono text-inky uppercase tracking-wide">Assign To</label>
            <div className="flex gap-2">
              {(['users', 'locations', 'department'] as const).map((t) => (
                <button key={t} onClick={() => setAssignToType(t)}
                  className={[
                    'px-2.5 py-1 rounded border text-xs font-mono',
                    assignToType === t ? 'bg-navy text-cream border-navy' : 'border-navy/20 text-inky hover:border-navy/40',
                  ].join(' ')}>
                  {t === 'users' ? 'Users' : t === 'locations' ? 'Locations' : 'Department'}
                </button>
              ))}
            </div>
            {assignToType === 'users' && (
              <div className="flex flex-col gap-1 max-h-40 overflow-y-auto border border-navy/10 rounded p-2 bg-cream">
                {profiles.map((p) => (
                  <label key={p.id} className="flex items-center gap-2 cursor-pointer py-0.5">
                    <input type="checkbox" checked={selectedUsers.includes(p.id)} className="accent-navy"
                      onChange={(e) => setSelectedUsers((prev) =>
                        e.target.checked ? [...prev, p.id] : prev.filter((id) => id !== p.id))} />
                    <span className="text-xs font-mono text-navy">{p.full_name ?? p.email}</span>
                  </label>
                ))}
              </div>
            )}
            {assignToType === 'locations' && (
              <div className="flex flex-col gap-1 max-h-40 overflow-y-auto border border-navy/10 rounded p-2 bg-cream">
                {locations.map((l) => (
                  <label key={l.id} className="flex items-center gap-2 cursor-pointer py-0.5">
                    <input type="checkbox" checked={selectedLocations.includes(l.id)} className="accent-navy"
                      onChange={(e) => setSelectedLocations((prev) =>
                        e.target.checked ? [...prev, l.id] : prev.filter((id) => id !== l.id))} />
                    <span className="text-xs font-mono text-navy">{l.name}</span>
                  </label>
                ))}
              </div>
            )}
            {assignToType === 'department' && (
              <select value={deptName} onChange={(e) => setDeptName(e.target.value)}
                className="rounded border border-navy/30 bg-cream px-2 py-1.5 text-xs font-mono text-navy focus:border-[#00e5ff] focus:outline-none">
                <option value="">Select department…</option>
                {DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-navy/20 flex-shrink-0">
          <button onClick={onClose} className="text-xs font-mono border border-navy/20 rounded px-3 py-1.5 text-inky hover:border-navy/40">Cancel</button>
          <button onClick={save} disabled={saving}
            className="text-xs font-mono bg-navy text-cream rounded px-4 py-1.5 hover:bg-inky disabled:opacity-40">
            {saving ? 'Saving…' : 'Save Rule'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Bulk Import Modal ─────────────────────────────────────────────────────────

function BulkImportModal({
  formId, profile, profiles, onImported, onClose,
}: {
  formId: string
  profile: any
  profiles: Profile[]
  onImported: (count: number) => void
  onClose: () => void
}) {
  const [rows, setRows] = useState<BulkRow[]>([])
  const [importing, setImporting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  async function handleFile(file: File) {
    const buffer = await file.arrayBuffer()
    const wb = XLSX.read(buffer, { type: 'array' })
    const ws = wb.Sheets[wb.SheetNames[0]]
    const data: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
    const parsed: BulkRow[] = data.slice(1)
      .filter((r) => r[0])
      .map((row) => {
        const email = String(row[0] ?? '').trim().toLowerCase()
        const dueDate = String(row[1] ?? '').trim()
        const notes = String(row[3] ?? '').trim()
        const resolved = profiles.find((p) => p.email?.toLowerCase() === email) ?? null
        return { id: crypto.randomUUID(), email, dueDate, notes, resolvedProfile: resolved, selected: !!resolved }
      })
    setRows(parsed)
  }

  async function doImport() {
    const toImport = rows.filter((r) => r.selected && r.resolvedProfile)
    if (!toImport.length) { toast.error('No valid rows selected'); return }
    setImporting(true)
    const { error } = await sb.schema('forms').from('assignments').insert(
      toImport.map((r) => ({
        form_id: formId,
        assigned_to: r.resolvedProfile!.id,
        due_date: r.dueDate || null,
        assigned_by: profile?.id,
      }))
    )
    setImporting(false)
    if (error) { toast.error(error.message); return }
    onImported(toImport.length)
    toast.success(`${toImport.length} assignment${toImport.length !== 1 ? 's' : ''} created`)
  }

  const selectedCount = rows.filter((r) => r.selected && r.resolvedProfile).length

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy/60 backdrop-blur-sm">
      <div className="w-full max-w-xl bg-cream rounded-lg border border-navy/30 shadow-2xl flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-navy/20 flex-shrink-0">
          <h3 className="text-sm font-heading font-bold text-navy uppercase tracking-wide">Import Assignments</h3>
          <button onClick={onClose} className="text-inky/50 hover:text-navy">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-4">
          {rows.length === 0 ? (
            <div className="flex flex-col gap-3">
              <div onClick={() => fileRef.current?.click()}
                className="border-2 border-dashed border-navy/20 rounded-lg px-6 py-10 flex flex-col items-center gap-2 cursor-pointer hover:border-navy/40 transition-colors">
                <span className="text-2xl">📊</span>
                <span className="text-sm font-mono text-inky">Upload XLSX or CSV</span>
                <span className="text-xs font-mono text-inky/50 text-center">
                  Columns: Email, Due Date (YYYY-MM-DD), Location (optional), Notes (optional)
                </span>
              </div>
              <input ref={fileRef} type="file" accept=".xlsx,.csv" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
              <button onClick={downloadAssignmentTemplate}
                className="self-start text-xs font-mono border border-navy/20 rounded px-3 py-1.5 text-inky hover:border-navy/40">
                ↓ Download Template
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {rows.map((row) => (
                <div key={row.id}
                  className={[
                    'flex items-center gap-2 rounded border px-3 py-2',
                    !row.resolvedProfile ? 'border-amber-300 bg-amber-50/30' : 'border-navy/15 bg-cream',
                  ].join(' ')}>
                  <input type="checkbox" checked={row.selected} disabled={!row.resolvedProfile}
                    onChange={(e) => setRows((p) => p.map((r) => r.id === row.id ? { ...r, selected: e.target.checked } : r))}
                    className="accent-navy flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-mono text-navy truncate">
                      {row.resolvedProfile?.full_name ?? row.email}
                    </div>
                    <div className={['text-[10px] font-mono', !row.resolvedProfile ? 'text-amber-700' : 'text-inky/50'].join(' ')}>
                      {!row.resolvedProfile ? `⚠ Not found: ${row.email}` : row.email}
                      {row.dueDate && ` · Due ${row.dueDate}`}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {rows.length > 0 && (
          <div className="flex items-center justify-between px-6 py-4 border-t border-navy/20 flex-shrink-0">
            <button onClick={() => setRows([])}
              className="text-xs font-mono border border-navy/20 rounded px-3 py-1.5 text-inky hover:border-navy/40">Clear</button>
            <div className="flex gap-2">
              <button onClick={onClose}
                className="text-xs font-mono border border-navy/20 rounded px-3 py-1.5 text-inky hover:border-navy/40">Cancel</button>
              <button onClick={doImport} disabled={importing || selectedCount === 0}
                className="text-xs font-mono bg-navy text-cream rounded px-4 py-1.5 hover:bg-inky disabled:opacity-40">
                {importing ? 'Importing…' : `Confirm Import (${selectedCount})`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export function FormAssignmentsPage() {
  const { formId } = useParams<{ formId: string }>()
  const navigate = useNavigate()
  const { profile: myProfile } = useAuthStore()

  const [form, setForm] = useState<FormDefinition | null>(null)
  const [assignments, setAssignments] = useState<AssignmentRow[]>([])
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([])
  const [rules, setRules] = useState<AssignmentRule[]>([])
  const [rulesOpen, setRulesOpen] = useState(false)
  const [loading, setLoading] = useState(true)

  const [drawerType, setDrawerType] = useState<DrawerType>(null)
  const [editingRule, setEditingRule] = useState<AssignmentRule | null>(null)
  const [bulkOpen, setBulkOpen] = useState(false)

  // Assign drawer fields
  const [assignTo, setAssignTo] = useState<'user' | 'location'>('user')
  const [selectedUser, setSelectedUser] = useState('')
  const [selectedLocation, setSelectedLocation] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!formId || !myProfile?.company_id) return
    ;(async () => {
      const res = await loadFormWithFields(formId)
      if (res) setForm(res.form)

      const [asgRes, profRes, locRes, rulesRes] = await Promise.all([
        sb.schema('forms').from('assignments').select('*').eq('form_id', formId).order('created_at', { ascending: false }),
        sb.schema('platform').from('user_profiles').select('id, full_name, email').eq('company_id', myProfile.company_id).order('full_name'),
        sb.schema('core').from('locations').select('id, name').eq('company_id', myProfile.company_id).eq('active', true).order('name'),
        sb.schema('forms').from('assignment_rules').select('*').eq('form_id', formId).order('created_at'),
      ])

      const profs: Profile[] = profRes.data ?? []
      const locs: { id: string; name: string }[] = locRes.data ?? []
      setProfiles(profs)
      setLocations(locs)
      setRules(rulesRes.data ?? [])
      setAssignments(
        (asgRes.data ?? []).map((a: any) => ({
          ...a,
          profile: profs.find((p) => p.id === a.assigned_to),
          location: locs.find((l) => l.id === a.assigned_to_location),
        }))
      )
      setLoading(false)
    })()
  }, [formId, myProfile?.company_id])

  async function saveAssignment() {
    if (!formId || !myProfile?.id) return
    if (assignTo === 'user' && !selectedUser) { toast.error('Select a user'); return }
    if (assignTo === 'location' && !selectedLocation) { toast.error('Select a location'); return }
    setSaving(true)
    const { data, error } = await sb.schema('forms').from('assignments').insert({
      form_id: formId,
      assigned_to: assignTo === 'user' ? selectedUser : null,
      assigned_to_location: assignTo === 'location' ? selectedLocation : null,
      due_date: dueDate || null,
      assigned_by: myProfile.id,
    }).select().single()
    setSaving(false)
    if (error) { toast.error(error.message); return }
    setAssignments((p) => [{
      ...data,
      profile: profiles.find((pr) => pr.id === data.assigned_to),
      location: locations.find((l) => l.id === data.assigned_to_location),
    }, ...p])
    setDrawerType(null)
    setSelectedUser(''); setSelectedLocation(''); setDueDate('')
    toast.success('Assignment created')
  }

  async function deleteAssignment(id: string) {
    await sb.schema('forms').from('assignments').delete().eq('id', id)
    setAssignments((p) => p.filter((a) => a.id !== id))
    toast.success('Assignment removed')
  }

  async function deleteRule(id: string) {
    if (!confirm('Delete this rule?')) return
    await sb.schema('forms').from('assignment_rules').delete().eq('id', id)
    setRules((p) => p.filter((r) => r.id !== id))
    toast.success('Rule deleted')
  }

  async function toggleRule(rule: AssignmentRule) {
    await sb.schema('forms').from('assignment_rules').update({ is_active: !rule.is_active }).eq('id', rule.id)
    setRules((p) => p.map((r) => r.id === rule.id ? { ...r, is_active: !r.is_active } : r))
  }

  function assignmentStatus(a: AssignmentRow): { label: string; color: 'green' | 'red' | 'amber' | 'gray' } {
    if (a.is_completed) return { label: 'Completed', color: 'green' }
    if (a.due_date && isPast(parseISO(a.due_date + 'T23:59:59'))) return { label: 'Overdue', color: 'red' }
    if (a.due_date) return { label: 'Pending', color: 'amber' }
    return { label: 'No Due Date', color: 'gray' }
  }

  function ruleDesc(rule: AssignmentRule): string {
    if (rule.rule_type === 'interval') return `Every ${rule.interval_value} ${rule.interval_unit}`
    if (rule.rule_type === 'set_dates') return `${(rule.set_dates ?? []).length} date${(rule.set_dates ?? []).length !== 1 ? 's' : ''}`
    return 'File import (one-time)'
  }

  async function reloadAssignments() {
    if (!formId) return
    const { data } = await sb.schema('forms').from('assignments').select('*').eq('form_id', formId).order('created_at', { ascending: false })
    setAssignments(
      (data ?? []).map((a: any) => ({
        ...a,
        profile: profiles.find((p) => p.id === a.assigned_to),
        location: locations.find((l) => l.id === a.assigned_to_location),
      }))
    )
  }

  if (loading) return <div className="py-8 text-xs font-mono text-inky animate-pulse">Loading…</div>
  if (!form) return <div className="py-8 text-xs font-mono text-inky">Form not found.</div>

  const activeRuleCount = rules.filter((r) => r.is_active).length

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={() => navigate('/forms')} className="text-xs font-mono text-inky hover:text-navy">← Forms</button>
        <h1 className="flex-1 text-sm font-heading font-bold text-navy truncate">{form.title} — Assignments</h1>
        <button onClick={() => setBulkOpen(true)}
          className="text-xs font-mono border border-navy/20 rounded px-3 py-1.5 text-inky hover:border-navy/40">
          Import Assignments
        </button>
        <Button size="sm" onClick={() => setDrawerType('assignment')}>+ Assign Form</Button>
      </div>

      {/* Assignments list */}
      {assignments.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded border border-dashed border-navy/30 py-12">
          <p className="text-sm font-mono text-inky">No assignments yet</p>
          <Button size="sm" onClick={() => setDrawerType('assignment')}>+ Assign Form</Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {assignments.map((a) => {
            const { label, color } = assignmentStatus(a)
            return (
              <div key={a.id} className="flex items-center gap-3 rounded border border-navy/20 bg-cream px-4 py-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-heading text-navy">
                    {a.profile?.full_name ?? a.location?.name ?? 'Unknown'}
                  </div>
                  <div className="text-[10px] font-mono text-inky/50">
                    {a.due_date ? `Due: ${format(parseISO(a.due_date), 'MMM d, yyyy')}` : 'No due date'}
                    {a.completed_at && ` · Completed ${format(new Date(a.completed_at), 'MMM d, yyyy')}`}
                  </div>
                </div>
                <Badge color={color}>{label}</Badge>
                <button onClick={() => deleteAssignment(a.id)}
                  className="text-xs font-mono text-inky/40 hover:text-red-500 flex-shrink-0">✕</button>
              </div>
            )
          })}
        </div>
      )}

      {/* Assignment Rules section */}
      <div className="border border-navy/20 rounded overflow-hidden">
        <div className="flex items-center bg-cream">
          <button
            onClick={() => setRulesOpen((v) => !v)}
            className="flex-1 flex items-center gap-2 px-4 py-3 hover:bg-navy/5 transition-colors text-left">
            <span className="text-[10px] text-inky/40">{rulesOpen ? '▼' : '▶'}</span>
            <span className="text-xs font-mono text-navy font-semibold uppercase tracking-wide">Assignment Rules</span>
            {activeRuleCount > 0 && (
              <span className="text-[10px] font-mono text-amber-600 ml-1">({activeRuleCount} active)</span>
            )}
          </button>
          <button
            onClick={() => { setEditingRule(null); setDrawerType('rule') }}
            className="flex-shrink-0 text-xs font-mono border border-navy/20 rounded px-2.5 py-1 mr-3 text-inky hover:border-navy/40">
            + New Rule
          </button>
        </div>

        {rulesOpen && (
          <div className="border-t border-navy/10 p-4 flex flex-col gap-2">
            {rules.length === 0 ? (
              <p className="text-xs font-mono text-inky/60 text-center py-4">
                No rules — assignments fire manually only.
              </p>
            ) : (
              rules.map((rule) => (
                <div key={rule.id} className="flex items-start gap-3 rounded border border-navy/15 bg-cream px-4 py-3">
                  <span className="text-base mt-0.5 flex-shrink-0">📅</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-heading text-navy">{rule.rule_name}</span>
                      {!rule.is_active && <Badge color="gray">Paused</Badge>}
                    </div>
                    <div className="text-[10px] font-mono text-inky/60 mt-0.5">
                      {ruleDesc(rule)} · due {rule.due_offset_days}d after · {rule.assign_to_type}
                    </div>
                  </div>
                  <div className="flex gap-1 flex-shrink-0">
                    <button onClick={() => { setEditingRule(rule); setDrawerType('rule') }}
                      className="text-xs font-mono border border-navy/20 rounded px-2 py-0.5 text-inky hover:border-navy/40">Edit</button>
                    <button onClick={() => toggleRule(rule)}
                      className="text-xs font-mono border border-navy/20 rounded px-2 py-0.5 text-inky hover:border-navy/40">
                      {rule.is_active ? 'Pause' : 'Resume'}
                    </button>
                    <button onClick={() => deleteRule(rule.id)}
                      className="text-xs font-mono border border-red-200 rounded px-2 py-0.5 text-red-500 hover:border-red-400">Delete</button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Assign Form Drawer */}
      {drawerType === 'assignment' && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-navy/60 backdrop-blur-sm">
          <div className="w-full max-w-md bg-cream rounded-t-2xl sm:rounded-lg border border-navy/30 shadow-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-heading font-bold text-navy uppercase tracking-wide">Assign Form</h3>
              <button onClick={() => setDrawerType(null)} className="text-inky/50 hover:text-navy">✕</button>
            </div>
            <div className="flex gap-2">
              {(['user', 'location'] as const).map((t) => (
                <button key={t} onClick={() => setAssignTo(t)}
                  className={[
                    'flex-1 py-1.5 rounded border text-xs font-mono',
                    assignTo === t ? 'bg-navy text-cream border-navy' : 'border-navy/20 text-inky hover:border-navy/40',
                  ].join(' ')}>
                  {t === 'user' ? 'User' : 'Location'}
                </button>
              ))}
            </div>
            {assignTo === 'user' ? (
              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-mono text-inky uppercase tracking-wide">Assign To</label>
                <select value={selectedUser} onChange={(e) => setSelectedUser(e.target.value)}
                  className="rounded border border-navy/30 bg-cream px-2 py-1.5 text-xs font-mono text-navy focus:border-[#00e5ff] focus:outline-none">
                  <option value="">Select user…</option>
                  {profiles.map((p) => <option key={p.id} value={p.id}>{p.full_name ?? p.email}</option>)}
                </select>
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-mono text-inky uppercase tracking-wide">Location</label>
                <select value={selectedLocation} onChange={(e) => setSelectedLocation(e.target.value)}
                  className="rounded border border-navy/30 bg-cream px-2 py-1.5 text-xs font-mono text-navy focus:border-[#00e5ff] focus:outline-none">
                  <option value="">Select location…</option>
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>
            )}
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-mono text-inky uppercase tracking-wide">Due Date (optional)</label>
              <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)}
                className="rounded border border-navy/30 bg-cream px-2 py-1.5 text-xs font-mono text-navy focus:border-[#00e5ff] focus:outline-none" />
            </div>
            <div className="flex justify-end gap-2 pt-1 border-t border-navy/10">
              <button onClick={() => setDrawerType(null)}
                className="text-xs font-mono border border-navy/20 rounded px-3 py-1.5 text-inky hover:border-navy/40">Cancel</button>
              <button onClick={saveAssignment} disabled={saving}
                className="text-xs font-mono bg-navy text-cream rounded px-4 py-1.5 hover:bg-inky disabled:opacity-40">
                {saving ? 'Saving…' : 'Assign'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rule Builder Drawer */}
      {drawerType === 'rule' && formId && myProfile && (
        <RuleDrawer
          formId={formId}
          profile={myProfile}
          editRule={editingRule}
          profiles={profiles}
          locations={locations}
          onSaved={(rule) => {
            setRules((p) => p.find((r) => r.id === rule.id)
              ? p.map((r) => r.id === rule.id ? rule : r)
              : [...p, rule])
            setDrawerType(null)
            setEditingRule(null)
            setRulesOpen(true)
          }}
          onClose={() => { setDrawerType(null); setEditingRule(null) }}
        />
      )}

      {/* Bulk Import Modal */}
      {bulkOpen && formId && (
        <BulkImportModal
          formId={formId}
          profile={myProfile}
          profiles={profiles}
          onImported={() => { setBulkOpen(false); reloadAssignments() }}
          onClose={() => setBulkOpen(false)}
        />
      )}
    </div>
  )
}
