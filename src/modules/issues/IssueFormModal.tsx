import { useEffect, useState } from 'react'
import { Modal, Button, Combobox, Input } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import type { Issue, Location, IssueCategory, IssueStatus } from '@/types'
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

  const [title, setTitle] = useState(existing?.title ?? '')
  const [locationId, setLocationId] = useState(existing?.location_id ?? '')
  const [categoryId, setCategoryId] = useState(existing?.category_id ?? '')
  const [statusId, setStatusId] = useState(existing?.status_id ?? '')
  const [startDate, setStartDate] = useState(existing?.start_date ?? '')
  const [targetDate, setTargetDate] = useState(existing?.target_resolution_date ?? '')
  const [resolvedDate, setResolvedDate] = useState(existing?.resolved_date ?? '')
  const [notes, setNotes] = useState(existing?.resolution_notes ?? '')
  const [saving, setSaving] = useState(false)

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
    setNotes(existing?.resolution_notes ?? '')
  }, [existing])

  async function loadOptions() {
    const [locs, cats, stats] = await Promise.all([
      supabase.from('locations').select('id, name').eq('company_id', companyId!).eq('active', true),
      supabase.from('issue_categories').select('id, name').eq('company_id', companyId!),
      supabase.from('issue_statuses').select('id, name').eq('company_id', companyId!),
    ])
    setLocations((locs.data ?? []).map((l: Location) => ({ value: l.id, label: l.name })))
    setCategories((cats.data ?? []).map((c: IssueCategory) => ({ value: c.id, label: c.name })))
    setStatuses((stats.data ?? []).map((s: IssueStatus) => ({ value: s.id, label: s.name })))
  }

  async function createCategory(name: string): Promise<ComboboxOption> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any)
      .from('issue_categories')
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
      .from('issue_statuses')
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
    const payload = {
      company_id: companyId,
      title: title.trim() || null,
      location_id: locationId || null,
      category_id: categoryId || null,
      status_id: statusId || null,
      start_date: startDate || null,
      target_resolution_date: targetDate || null,
      resolved_date: resolvedDate || null,
      resolution_notes: notes || null,
      created_by: profile?.id ?? null,
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as any
    const { error } = existing?.id
      ? await sb.from('issues').update(payload).eq('id', existing.id)
      : await sb.from('issues').insert(payload)

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

        {isResolved && (
          <Input label="Resolved Date" type="date" value={resolvedDate}
            onChange={(e) => setResolvedDate(e.target.value)} />
        )}

        <div className={isResolved ? 'col-span-2' : 'col-span-2'}>
          <label className="text-xs font-mono text-gray-400 uppercase tracking-wide block mb-1">
            Resolution Notes
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            className="w-full bg-[#0f1117] border border-[#2a2d3e] rounded px-3 py-2 text-sm font-mono text-white placeholder-gray-600 focus:outline-none focus:border-[#00e5ff] resize-none"
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
