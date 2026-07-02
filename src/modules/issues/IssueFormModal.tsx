import { useEffect, useState } from 'react'
import { Modal, Button, Combobox, Input } from '@/components/ui'
import { AssigneeComboInput } from '@/components/shared/AssigneeComboInput'
import { VisibilitySelector, type VisibilityValue, type SlimUser } from '@/components/shared/VisibilitySelector'
import { RichTextEditor } from '@/components/shared/RichTextEditor'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import type { Issue, Location, IssueCategory, IssueStatus, Profile, Department } from '@/types'
import type { ComboboxOption } from '@/components/ui'
import toast from 'react-hot-toast'

const PERSONAL_VALUE = '__personal__'

interface IssueFormModalProps {
  open: boolean
  onClose: () => void
  existing?: Partial<Issue> | null
  onSaved: () => void
  onDelete?: (id: string) => void
  defaultDepartmentId?: string
  departments?: Department[]
}

export function IssueFormModal({ open, onClose, existing, onSaved, onDelete, defaultDepartmentId, departments: deptsProp }: IssueFormModalProps) {
  const { profile } = useAuthStore()
  const [locations, setLocations] = useState<ComboboxOption[]>([])
  const [categories, setCategories] = useState<ComboboxOption[]>([])
  const [statuses, setStatuses] = useState<ComboboxOption[]>([])
  const [orgProfiles, setOrgProfiles] = useState<Profile[]>([])
  const [deptOptions, setDeptOptions] = useState<ComboboxOption[]>([])

  const resolveInitialDept = () => {
    if (existing?.department_id) return existing.department_id
    if (existing && 'department_id' in existing && existing.department_id === null) return PERSONAL_VALUE
    if (defaultDepartmentId === PERSONAL_VALUE) return PERSONAL_VALUE
    return defaultDepartmentId ?? ''
  }

  const [deptId, setDeptId] = useState(resolveInitialDept)
  const [title, setTitle] = useState(existing?.title ?? '')
  const [locationId, setLocationId] = useState(existing?.location_id ?? '')
  const [categoryId, setCategoryId] = useState(existing?.category_id ?? '')
  const [statusId, setStatusId] = useState(existing?.status_id ?? '')
  const [startDate, setStartDate] = useState(existing?.start_date ?? '')
  const [targetDate, setTargetDate] = useState(existing?.target_resolution_date ?? '')
  const [resolvedDate, setResolvedDate] = useState(existing?.resolved_date ?? '')
  const [vendor, setVendor] = useState(existing?.vendor ?? '')
  const [assignee, setAssignee] = useState(existing?.assignee ?? '')
  const [issueNotes, setIssueNotes] = useState(existing?.issue_notes ?? '')
  const [notes, setNotes] = useState(existing?.resolution_notes ?? '')
  const [saving, setSaving] = useState(false)
  const [sharedDeptIds, setSharedDeptIds] = useState<string[]>((existing as any)?.shared_department_ids ?? [])
  const [deleteConfirm, setDeleteConfirm] = useState(false)

  const [visibility, setVisibility] = useState<VisibilityValue>((existing as any)?.visibility ?? 'department')
  const [participants, setParticipants] = useState<SlimUser[]>([])
  const [specificUsers, setSpecificUsers] = useState<SlimUser[]>([])

  const companyId = profile?.company_id

  // Auto-set resolved date when status changes to resolved (only if not already set)
  useEffect(() => {
    if (!statusId || !statuses.length) return
    const statusName = statuses.find(s => s.value === statusId)?.label ?? ''
    if (statusName.toLowerCase().includes('resolved') && !resolvedDate) {
      setResolvedDate(new Date().toISOString().split('T')[0])
    }
  // resolvedDate intentionally excluded — only auto-set on status change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusId, statuses])

  useEffect(() => {
    if (!companyId || !open) return
    loadOptions()
  }, [companyId, open])

  useEffect(() => {
    if (!open) return
    const initDept = resolveInitialDept()
    setDeptId(initDept)
    setTitle(existing?.title ?? '')
    setLocationId(existing?.location_id ?? '')
    setCategoryId(existing?.category_id ?? '')
    setStatusId(existing?.status_id ?? '')
    setStartDate(existing?.start_date ?? '')
    setTargetDate(existing?.target_resolution_date ?? '')
    setResolvedDate(existing?.resolved_date ?? '')
    setVendor(existing?.vendor ?? '')
    setAssignee(existing?.assignee ?? '')
    setIssueNotes(existing?.issue_notes ?? '')
    setNotes(existing?.resolution_notes ?? '')
    setVisibility((existing as any)?.visibility ?? 'department')
    setSharedDeptIds((existing as any)?.shared_department_ids ?? [])
    setParticipants([])
    setSpecificUsers([])
    setDeleteConfirm(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing, open])

  async function loadOptions() {
    const sb = supabase as any
    const [locs, cats, stats, profs, depts, memberships] = await Promise.all([
      sb.schema('core').from('locations').select('id, name, shop_city').eq('company_id', companyId!).order('name'),
      sb.schema('inventory').from('issue_categories').select('id, name').eq('company_id', companyId!),
      sb.schema('inventory').from('issue_statuses').select('id, name').eq('company_id', companyId!),
      sb.schema('platform').from('user_profiles').select('id, full_name, email').eq('company_id', companyId!).is('deleted_at', null).order('full_name'),
      sb.schema('platform').from('departments').select('id, name').eq('company_id', companyId!),
      sb.schema('platform').from('user_department_memberships').select('user_id, department_id').eq('company_id', companyId!),
    ])
    setLocations((locs.data ?? []).map((l: any) => ({ value: l.id, label: l.shop_city ?? l.name })))
    setCategories((cats.data ?? []).map((c: IssueCategory) => ({ value: c.id, label: c.name })))
    setStatuses((stats.data ?? []).map((s: IssueStatus) => ({ value: s.id, label: s.name })))

    // Build dept id → name lookup, then user id → dept names[] for VisibilitySelector
    const deptNameById: Record<string, string> = Object.fromEntries(
      (depts.data ?? []).map((d: any) => [d.id, d.name])
    )
    const userDeptNames: Record<string, string[]> = {}
    for (const m of (memberships.data ?? [])) {
      const name = deptNameById[m.department_id]
      if (!name) continue
      if (!userDeptNames[m.user_id]) userDeptNames[m.user_id] = []
      userDeptNames[m.user_id].push(name)
    }
    setOrgProfiles((profs.data ?? []).map((p: any) => ({ ...p, departments: userDeptNames[p.id] ?? [] })) as Profile[])

    if (deptsProp?.length) {
      setDeptOptions(deptsProp.map((d) => ({ value: d.id, label: d.name })))
    } else {
      const { data: depts } = await sb.schema('platform').from('departments')
        .select('id, name, sort_order').eq('company_id', companyId!).order('sort_order')
      setDeptOptions((depts ?? []).map((d: any) => ({ value: d.id, label: d.name })))
    }
  }

  // All dept options including "Personal" at the top
  const allDeptOptions: ComboboxOption[] = [
    { value: PERSONAL_VALUE, label: '🔒 Personal (private)' },
    ...deptOptions,
  ]

  const isPersonal = deptId === PERSONAL_VALUE

  async function createCategory(name: string): Promise<ComboboxOption> {
    const { data, error } = await (supabase as any)
      .schema('inventory').from('issue_categories')
      .insert({ company_id: companyId!, name })
      .select().single()
    if (error) throw error
    const opt = { value: data.id, label: data.name }
    setCategories((prev) => [...prev, opt])
    return opt
  }

  async function createStatus(name: string): Promise<ComboboxOption> {
    const { data, error } = await (supabase as any)
      .schema('inventory').from('issue_statuses')
      .insert({ company_id: companyId!, name })
      .select().single()
    if (error) throw error
    const opt = { value: data.id, label: data.name }
    setStatuses((prev) => [...prev, opt])
    return opt
  }

  function toggleSharedDept(id: string) {
    setSharedDeptIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  async function save() {
    if (!companyId) return
    if (!deptId) { toast.error('Select a department for this issue'); return }
    if (!title.trim() && !locationId) {
      toast.error('Add a title (or pick a location) for the issue')
      return
    }
    setSaving(true)

    // Core payload — all columns that are guaranteed to exist in production
    const corePayload: Record<string, unknown> = {
      company_id: companyId,
      department_id: isPersonal ? null : deptId,
      title: title.trim() || null,
      location_id: locationId || null,
      category_id: categoryId || null,
      status_id: statusId || null,
      start_date: startDate || null,
      target_resolution_date: targetDate || null,
      resolved_date: resolvedDate || null,
      vendor: vendor.trim() || null,
      assignee: assignee.trim() || null,
      issue_notes: issueNotes || null,
      resolution_notes: notes || null,
      visibility: isPersonal ? 'private' : visibility,
    }
    if (!existing?.id) corePayload.created_by = profile?.id ?? null

    const sb = supabase as any
    const { error } = existing?.id
      ? await sb.schema('platform').from('issues').update(corePayload).eq('id', existing.id)
      : await sb.schema('platform').from('issues').insert(corePayload)

    if (error) { toast.error(error.message); setSaving(false); return }

    // Best-effort: shared_department_ids may be missing if migration not yet applied
    const sharedPayload = { shared_department_ids: isPersonal ? [] : sharedDeptIds }
    if (existing?.id) {
      sb.schema('platform').from('issues').update(sharedPayload).eq('id', existing.id).then(() => {})
    } else {
      // For inserts we'd need the new row id — skip best-effort on insert for now
    }

    toast.success(existing?.id ? 'Issue updated' : 'Issue created')
    onSaved()
    onClose()
    setSaving(false)
  }

  const ownerDeptLabel = isPersonal ? null : deptOptions.find((d) => d.value === deptId)?.label ?? null
  const otherDepts = deptOptions.filter(d => d.value !== deptId)

  return (
    <Modal open={open} onClose={onClose} title={existing?.id ? 'Edit Issue' : 'New Issue'} size="lg">
      <div className="mb-4">
        <Input
          label="Title / Summary"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Walk-in freezer running warm — or just a quick note"
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <Combobox label="Department" options={allDeptOptions} value={deptId}
            onChange={(v) => {
              setDeptId(v)
              if (v === PERSONAL_VALUE) setVisibility('private')
            }}
            placeholder="Select department…" />
        </div>

        {!isPersonal && (
          <Combobox label="Location (optional)" options={locations} value={locationId}
            onChange={(v) => setLocationId(v)} placeholder="None — general issue" />
        )}

        <Combobox label="Category" options={categories} value={categoryId}
          onChange={(v) => setCategoryId(v)} placeholder="Select or create..."
          allowCreate onCreateOption={createCategory} />

        <Combobox label="Status" options={statuses} value={statusId}
          onChange={(v) => setStatusId(v)} placeholder="Select or create..."
          allowCreate onCreateOption={createStatus} />

        <Input label="Start Date" type="date" value={startDate}
          onChange={(e) => setStartDate(e.target.value)} />

        <Input label="Target Resolution" type="date" value={targetDate}
          onChange={(e) => setTargetDate(e.target.value)} />

        <Input label="Vendor" value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Vendor name" />

        <AssigneeComboInput
          label="Assignee"
          value={assignee}
          profiles={orgProfiles}
          onChange={setAssignee}
          placeholder="Unassigned"
        />

        <Input label="Resolved Date" type="date" value={resolvedDate}
          onChange={(e) => setResolvedDate(e.target.value)} />

        <div className="col-span-2">
          <label className="text-xs font-mono text-inky uppercase tracking-wide block mb-1">Issue Notes</label>
          <RichTextEditor value={issueNotes} onChange={setIssueNotes} placeholder="Details, observations, context…" minHeight={100} />
        </div>

        <div className="col-span-2">
          <label className="text-xs font-mono text-inky uppercase tracking-wide block mb-1">Resolution Notes</label>
          <RichTextEditor value={notes} onChange={setNotes} placeholder="Resolution details…" minHeight={100} />
        </div>

        {!isPersonal && otherDepts.length > 0 && (
          <div className="col-span-2">
            <label className="text-xs font-mono text-inky uppercase tracking-wide block mb-1.5">
              Share with other departments (optional)
            </label>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {otherDepts.map(d => (
                <label key={d.value} className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={sharedDeptIds.includes(d.value)}
                    onChange={() => toggleSharedDept(d.value)}
                    className="accent-inky" />
                  <span className="text-xs font-mono text-navy">{d.label}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {!isPersonal && (
          <div className="col-span-2">
            <VisibilitySelector
              value={visibility}
              onChange={setVisibility}
              participants={participants}
              onParticipantsChange={setParticipants}
              specificUsers={specificUsers}
              onSpecificUsersChange={setSpecificUsers}
              allUsers={orgProfiles.map((p) => ({ id: p.id, full_name: p.full_name, email: p.email ?? '', departments: (p as any).departments ?? [] }))}
              departmentName={ownerDeptLabel}
              departments={deptOptions.map((d) => d.label)}
              label="Issue Visibility"
            />
          </div>
        )}

        {isPersonal && (
          <div className="col-span-2 flex items-center gap-2 rounded bg-navy/5 px-3 py-2">
            <span className="text-xs font-mono text-inky/70">🔒 Personal issues are only visible to you.</span>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 mt-4">
        <div>
          {existing?.id && !deleteConfirm && (
            <button
              onClick={() => setDeleteConfirm(true)}
              className="text-xs font-mono text-red-400 hover:text-red-600 hover:underline"
            >
              Delete issue
            </button>
          )}
          {existing?.id && deleteConfirm && (
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-red-500">Confirm delete?</span>
              <button onClick={() => { onDelete?.(existing.id!); onClose() }} className="text-xs font-mono text-red-500 font-bold hover:underline">Yes, delete</button>
              <button onClick={() => setDeleteConfirm(false)} className="text-xs font-mono text-inky/60 hover:underline">Cancel</button>
            </div>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" loading={saving} onClick={save}>
            {existing?.id ? 'Update' : 'Create'} Issue
          </Button>
        </div>
      </div>
    </Modal>
  )
}
