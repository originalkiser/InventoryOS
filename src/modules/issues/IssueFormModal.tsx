import { useEffect, useState } from 'react'
import { Modal, Button, Combobox, Input } from '@/components/ui'
import { AssigneeComboInput } from '@/components/shared/AssigneeComboInput'
import { VisibilitySelector, type VisibilityValue, type SlimUser } from '@/components/shared/VisibilitySelector'
import { RichTextEditor } from '@/components/shared/RichTextEditor'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { isAdminOrDeveloper } from '@/lib/roles'
import type { Issue, Location, IssueCategory, IssueStatus, Profile } from '@/types'
import type { ComboboxOption } from '@/components/ui'
import toast from 'react-hot-toast'

interface IssueFormModalProps {
  open: boolean
  onClose: () => void
  existing?: Partial<Issue> | null
  onSaved: () => void
}

export function IssueFormModal({ open, onClose, existing, onSaved }: IssueFormModalProps) {
  const { profile } = useAuthStore()
  const [locations, setLocations] = useState<ComboboxOption[]>([])
  const [categories, setCategories] = useState<ComboboxOption[]>([])
  const [statuses, setStatuses] = useState<ComboboxOption[]>([])
  const [orgProfiles, setOrgProfiles] = useState<Profile[]>([])

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

  const [visibility, setVisibility] = useState<VisibilityValue>((existing as any)?.visibility ?? 'department')
  const [participants, setParticipants] = useState<SlimUser[]>([])
  const [specificUsers, setSpecificUsers] = useState<SlimUser[]>([])

  const companyId = profile?.company_id

  const isResolved = statuses.find((s) => s.value === statusId)?.label?.toLowerCase().includes('resolved')

  useEffect(() => {
    if (!companyId || !open) return
    loadOptions()
  }, [companyId, open])

  useEffect(() => {
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
    setParticipants([])
    setSpecificUsers([])
  }, [existing])

  async function loadOptions() {
    const [locs, cats, stats, profs] = await Promise.all([
      (supabase as any).schema('core').from('locations').select('id, name').eq('company_id', companyId!).eq('active', true),
      (supabase as any).schema('inventory').from('issue_categories').select('id, name').eq('company_id', companyId!),
      (supabase as any).schema('inventory').from('issue_statuses').select('id, name').eq('company_id', companyId!),
      (supabase as any).schema('platform').from('user_profiles').select('id, full_name, email').eq('company_id', companyId!).order('full_name'),
    ])
    setLocations((locs.data ?? []).map((l: Location) => ({ value: l.id, label: l.name })))
    setCategories((cats.data ?? []).map((c: IssueCategory) => ({ value: c.id, label: c.name })))
    setStatuses((stats.data ?? []).map((s: IssueStatus) => ({ value: s.id, label: s.name })))
    setOrgProfiles((profs.data ?? []) as Profile[])
  }

  async function createCategory(name: string): Promise<ComboboxOption> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any)
      .schema('inventory').from('issue_categories')
      .insert({ company_id: companyId!, name })
      .select()
      .single()
    if (error) throw error
    const opt = { value: data.id, label: data.name }
    setCategories((prev) => [...prev, opt])
    return opt
  }

  async function createStatus(name: string): Promise<ComboboxOption> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any)
      .schema('inventory').from('issue_statuses')
      .insert({ company_id: companyId!, name })
      .select()
      .single()
    if (error) throw error
    const opt = { value: data.id, label: data.name }
    setStatuses((prev) => [...prev, opt])
    return opt
  }

  async function save() {
    if (!companyId) return
    if (!title.trim() && !locationId) {
      toast.error('Add a title (or pick a location) for the issue')
      return
    }
    setSaving(true)
    const payload: Record<string, unknown> = {
      company_id: companyId,
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
      visibility: visibility,
    }
    // Only stamp the creator on insert — editing must not reassign it.
    if (!existing?.id) payload.created_by = profile?.id ?? null

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as any
    const { error } = existing?.id
      ? await sb.schema('inventory').from('issues').update(payload).eq('id', existing.id)
      : await sb.schema('inventory').from('issues').insert(payload)

    if (error) toast.error(error.message)
    else {
      toast.success(existing?.id ? 'Issue updated' : 'Issue created')
      onSaved()
      onClose()
    }
    setSaving(false)
  }

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
        <Combobox label="Location (optional)" options={locations} value={locationId}
          onChange={(v) => setLocationId(v)} placeholder="None — general issue" />

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

        {isResolved && (
          <Input label="Resolved Date" type="date" value={resolvedDate}
            onChange={(e) => setResolvedDate(e.target.value)} />
        )}

        <div className="col-span-2">
          <label className="text-xs font-mono text-inky uppercase tracking-wide block mb-1">
            Issue Notes
          </label>
          <RichTextEditor
            value={issueNotes}
            onChange={setIssueNotes}
            placeholder="Details, observations, context…"
            minHeight={100}
          />
        </div>

        <div className="col-span-2">
          <label className="text-xs font-mono text-inky uppercase tracking-wide block mb-1">
            Resolution Notes
          </label>
          <RichTextEditor
            value={notes}
            onChange={setNotes}
            placeholder="Resolution details…"
            minHeight={100}
          />
        </div>

        <div className="col-span-2">
          <VisibilitySelector
            value={visibility}
            onChange={setVisibility}
            participants={participants}
            onParticipantsChange={setParticipants}
            specificUsers={specificUsers}
            onSpecificUsersChange={setSpecificUsers}
            allUsers={orgProfiles.map((p) => ({ id: p.id, full_name: p.full_name, email: p.email ?? '' }))}
            departmentName={(profile as any)?.department ?? null}
            departments={
              isAdminOrDeveloper(profile?.role)
                ? [...new Set(orgProfiles.map((p) => (p as any).department).filter(Boolean) as string[])]
                : (profile as any)?.department ? [(profile as any).department] : undefined
            }
            label="Issue Visibility"
          />
        </div>
      </div>

      <div className="flex justify-end gap-2 mt-4">
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button size="sm" loading={saving} onClick={save}>
          {existing?.id ? 'Update' : 'Create'} Issue
        </Button>
      </div>
    </Modal>
  )
}
