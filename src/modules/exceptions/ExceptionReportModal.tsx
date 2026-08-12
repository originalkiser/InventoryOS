import { useEffect, useMemo, useState } from 'react'
import { Modal, Button, Combobox, Select, Input, Toggle } from '@/components/ui'
import type { ComboboxOption } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { RichTextEditor } from '@/components/shared/RichTextEditor'
import { REPORT_TYPES, DEFAULT_ISSUES, EXCEPTION_STATUSES, type ExceptionReport } from './exceptions'
import toast from 'react-hot-toast'

interface Props {
  open: boolean
  onClose: () => void
  existing?: Partial<ExceptionReport> | null
  // Persistence is owned by the parent so its data/cache reloads consistently.
  // Called with the domain fields (no audit stamps) and the id when editing.
  onSubmit: (fields: Partial<ExceptionReport>, id?: string) => Promise<void>
  onDelete?: (id: string) => void
}

const today = () => new Date().toISOString().split('T')[0]

export function ExceptionReportModal({ open, onClose, existing, onSubmit, onDelete }: Props) {
  const { profile } = useAuthStore()
  const loc = useLocations()
  const companyId = profile?.company_id

  const [customIssues, setCustomIssues] = useState<{ report_type: string; value: string }[]>([])
  const [locationId, setLocationId] = useState('')
  const [areaManager, setAreaManager] = useState('')
  const [dateFinding, setDateFinding] = useState('')
  const [dateAction, setDateAction] = useState('')
  const [reportType, setReportType] = useState('')
  const [issue, setIssue] = useState('')
  const [details, setDetails] = useState('')
  const [contacted, setContacted] = useState(false)
  const [contactedDate, setContactedDate] = useState('')
  const [response, setResponse] = useState('')
  const [rdIfNo, setRdIfNo] = useState('')
  const [responseNotes, setResponseNotes] = useState('')
  const [status, setStatus] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)

  // Load custom issue options on open.
  useEffect(() => {
    if (!open || !companyId) return
    ;(supabase as any).schema('inventory').from('exception_issue_option')
      .select('report_type, value').eq('company_id', companyId)
      .then((r: any) => setCustomIssues((r.data ?? []) as any[]))
  }, [open, companyId])

  // Seed form from `existing` each open.
  useEffect(() => {
    if (!open) return
    setLocationId(existing?.location_id ?? '')
    setAreaManager(existing?.area_manager ?? '')
    setDateFinding(existing?.date_of_finding ?? (existing?.id ? '' : today()))
    setDateAction(existing?.date_of_shop_action ?? '')
    setReportType(existing?.report_type ?? '')
    setIssue(existing?.issue ?? '')
    setDetails(existing?.details ?? '')
    setContacted(!!existing?.contacted)
    setContactedDate(existing?.contacted_date ?? '')
    setResponse(existing?.response ?? '')
    setRdIfNo(existing?.rd_if_no ?? '')
    setResponseNotes(existing?.response_notes ?? '')
    setStatus(existing?.status ?? '')
    setDeleteConfirm(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing, open])

  // Auto-fill area manager from the selected location's metadata (only if empty).
  function onLocationChange(id: string) {
    setLocationId(id)
    if (!areaManager) {
      const am = loc.fieldValue(id, 'area_manager')
      if (am) setAreaManager(am)
    }
  }

  const issueOptions: ComboboxOption[] = useMemo(() => {
    const base = DEFAULT_ISSUES[reportType] ?? []
    const customs = customIssues.filter((c) => c.report_type === reportType).map((c) => c.value)
    const all = [...new Set([...base, ...customs, ...(issue ? [issue] : [])])]
    return all.map((v) => ({ value: v, label: v }))
  }, [reportType, customIssues, issue])

  async function createIssueOption(value: string): Promise<ComboboxOption> {
    if (!companyId || !reportType) return { value, label: value }
    const { error } = await (supabase as any).schema('inventory').from('exception_issue_option')
      .insert({ company_id: companyId, report_type: reportType, value })
    if (error && !String(error.message).includes('duplicate')) toast.error(error.message)
    else setCustomIssues((prev) => [...prev, { report_type: reportType, value }])
    return { value, label: value }
  }

  async function save() {
    if (!companyId) return
    if (!locationId) { toast.error('Pick a shop for this exception'); return }
    setSaving(true)
    const fields: Partial<ExceptionReport> = {
      location_id: locationId,
      area_manager: areaManager.trim() || null,
      date_of_finding: dateFinding || null,
      date_of_shop_action: dateAction || null,
      report_type: reportType || null,
      issue: issue || null,
      details: details || null,
      contacted,
      contacted_date: contactedDate || null,
      response: response.trim() || null,
      rd_if_no: rdIfNo.trim() || null,
      response_notes: responseNotes || null,
      status: status || null,
    }
    try {
      await onSubmit(fields, existing?.id)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={existing?.id ? 'Edit Exception Report' : 'New Exception Report'} size="lg">
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <Combobox label="Shop *" options={loc.options} value={locationId} onChange={onLocationChange} placeholder="Select shop…" />
        </div>

        <Input label="Date of Finding" type="date" value={dateFinding} onChange={(e) => setDateFinding(e.target.value)} />
        <Input label="Area Manager" value={areaManager} onChange={(e) => setAreaManager(e.target.value)} placeholder="Auto-fills from shop" />

        <Select label="Exception Report Type" value={reportType} onChange={(e) => setReportType(e.target.value)}
          options={[{ value: '', label: 'Select type…' }, ...REPORT_TYPES.map((t) => ({ value: t, label: t }))]} />
        <Combobox label="ER Issue" options={issueOptions} value={issue} onChange={setIssue}
          placeholder={reportType ? 'Select or add…' : 'Pick a type first'}
          allowCreate onCreateOption={createIssueOption} />

        <div className="col-span-2">
          <label className="text-xs font-mono text-inky uppercase tracking-wide block mb-1">Details</label>
          <RichTextEditor value={details} onChange={setDetails} placeholder="What was found…" minHeight={80} />
        </div>

        <div className="flex items-end gap-3">
          <Toggle checked={contacted} onChange={setContacted} label="Contacted shop/AM?" color="green" />
        </div>
        <Input label="Contacted Date" type="date" value={contactedDate} onChange={(e) => setContactedDate(e.target.value)} disabled={!contacted} />

        <Input label="Response from Shop/AM" value={response} onChange={(e) => setResponse(e.target.value)} placeholder="e.g. Yes / details" />
        <Input label="Date of Shop Action" type="date" value={dateAction} onChange={(e) => setDateAction(e.target.value)} />

        <div className="col-span-2">
          <Input label="RelaDyne Escalation (if no response)" value={rdIfNo} onChange={(e) => setRdIfNo(e.target.value)} />
        </div>

        <div className="col-span-2">
          <label className="text-xs font-mono text-inky uppercase tracking-wide block mb-1">Response Notes</label>
          <RichTextEditor value={responseNotes} onChange={setResponseNotes} placeholder="Follow-up notes…" minHeight={80} />
        </div>

        <div className="col-span-2">
          <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}
            options={[{ value: '', label: 'Select status…' }, ...EXCEPTION_STATUSES.map((s) => ({ value: s, label: s }))]} />
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 mt-4">
        <div>
          {existing?.id && onDelete && !deleteConfirm && (
            <button onClick={() => setDeleteConfirm(true)} className="text-xs font-mono text-red-400 hover:text-red-600 hover:underline">Delete</button>
          )}
          {existing?.id && onDelete && deleteConfirm && (
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-red-500">Confirm delete?</span>
              <button onClick={() => { onDelete(existing.id!); onClose() }} className="text-xs font-mono text-red-500 font-bold hover:underline">Yes, delete</button>
              <button onClick={() => setDeleteConfirm(false)} className="text-xs font-mono text-inky/60 hover:underline">Cancel</button>
            </div>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" loading={saving} onClick={save}>{existing?.id ? 'Update' : 'Log'} Exception</Button>
        </div>
      </div>
    </Modal>
  )
}
