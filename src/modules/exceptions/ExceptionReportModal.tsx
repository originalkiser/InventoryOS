import { useEffect, useMemo, useState } from 'react'
import { Modal, Button, Combobox, Select, Input, Toggle } from '@/components/ui'
import type { ComboboxOption } from '@/components/ui'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { useExceptionConfig } from './useExceptionConfig'
import { RESPONSE_OPTIONS, impactedProducts, followUpDate, type ExceptionReport } from './exceptions'
import { ImpactedProductsPicker } from './ImpactedProductsPicker'
import toast from 'react-hot-toast'

interface Props {
  open: boolean
  onClose: () => void
  existing?: Partial<ExceptionReport> | null
  // Persistence is owned by the parent so its data/cache reloads consistently.
  onSubmit: (fields: Partial<ExceptionReport>, id?: string) => Promise<void>
  onDelete?: (id: string) => void
}

const today = () => new Date().toISOString().split('T')[0]
const stripHtml = (s: string | null | undefined) => (s ? s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '')

export function ExceptionReportModal({ open, onClose, existing, onSubmit, onDelete }: Props) {
  const { profile } = useAuthStore()
  const loc = useLocations()
  const { config, save: saveConfig } = useExceptionConfig()

  const [locationId, setLocationId] = useState('')
  const [areaManager, setAreaManager] = useState('')
  const [dateFinding, setDateFinding] = useState('')
  const [dateAction, setDateAction] = useState('')
  const [reportType, setReportType] = useState('')
  const [issue, setIssue] = useState('')
  const [details, setDetails] = useState('')
  const [contacted, setContacted] = useState(false)
  const [contactedDate, setContactedDate] = useState('')
  const [followUp, setFollowUp] = useState('')
  const [response, setResponse] = useState('')
  const [rdIfNo, setRdIfNo] = useState('')
  const [responseNotes, setResponseNotes] = useState('')
  const [status, setStatus] = useState('')
  const [products, setProducts] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)

  useEffect(() => {
    if (!open) return
    setLocationId(existing?.location_id ?? '')
    setAreaManager(existing?.area_manager ?? '')
    setDateFinding(existing?.date_of_finding ?? (existing?.id ? '' : today()))
    setDateAction(existing?.date_of_shop_action ?? '')
    setReportType(existing?.report_type ?? '')
    setIssue(existing?.issue ?? '')
    setDetails(stripHtml(existing?.details))
    setContacted(!!existing?.contacted)
    setContactedDate(existing?.contacted_date ?? '')
    setFollowUp(followUpDate(existing) ?? '')
    setResponse(existing?.response ?? '')
    setRdIfNo(existing?.rd_if_no ?? '')
    setResponseNotes(stripHtml(existing?.response_notes))
    setStatus(existing?.status ?? (existing?.id ? '' : (config.statuses[0] ?? '')))
    setProducts(impactedProducts(existing))
    setDeleteConfirm(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing, open])

  // Auto-fill area manager + regional director from the location's metadata (only if empty).
  function onLocationChange(id: string) {
    setLocationId(id)
    if (!areaManager) { const am = loc.fieldValue(id, 'area_manager'); if (am) setAreaManager(am) }
    if (!rdIfNo) { const rd = loc.fieldValue(id, 'regional_director') || loc.fieldValue(id, 'director'); if (rd) setRdIfNo(rd) }
  }

  const issueOptions: ComboboxOption[] = useMemo(() => {
    const base = config.issues[reportType] ?? []
    const all = [...new Set([...base, ...(issue ? [issue] : [])])]
    return all.map((v) => ({ value: v, label: v }))
  }, [config.issues, reportType, issue])

  // "Add to list" — append a new issue option for this type and persist to config.
  async function createIssueOption(value: string): Promise<ComboboxOption> {
    if (reportType) {
      const cur = config.issues[reportType] ?? []
      if (!cur.includes(value)) saveConfig({ ...config, issues: { ...config.issues, [reportType]: [...cur, value] } })
    }
    return { value, label: value }
  }

  async function save() {
    if (!locationId) { toast.error('Pick a shop for this exception'); return }
    setSaving(true)
    const fields: Partial<ExceptionReport> = {
      location_id: locationId,
      area_manager: areaManager.trim() || null,
      date_of_finding: dateFinding || null,
      date_of_shop_action: dateAction || null,
      report_type: reportType || null,
      issue: issue || null,
      details: details.trim() || null,
      contacted,
      contacted_date: contactedDate || null,
      response: response.trim() || null,
      rd_if_no: rdIfNo.trim() || null,
      response_notes: responseNotes.trim() || null,
      status: status || null,
      metadata: { ...(existing?.metadata ?? {}), impacted_products: products, follow_up_date: followUp || null },
    }
    try {
      await onSubmit(fields, existing?.id)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const typeOptions = [{ value: '', label: 'Select type…' }, ...config.types.map((t) => ({ value: t, label: t }))]
  const statusList = [...new Set([...config.statuses, ...(status ? [status] : [])])]

  return (
    <Modal open={open} onClose={onClose} title={existing?.id ? 'Edit Exception Report' : 'New Exception Report'} size="lg">
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <Combobox label="Shop *" options={loc.includedOptions} value={locationId} onChange={onLocationChange} placeholder="Select shop…" />
        </div>

        <Input label="Date of Finding" type="date" value={dateFinding} onChange={(e) => setDateFinding(e.target.value)} />
        <Input label="Area Manager" value={areaManager} onChange={(e) => setAreaManager(e.target.value)} placeholder="Auto-fills from shop" />

        <Select label="Exception Report Type" value={reportType} onChange={(e) => setReportType(e.target.value)} options={typeOptions} />
        <Combobox label="ER Issue" options={issueOptions} value={issue} onChange={setIssue}
          placeholder={reportType ? 'Select or add…' : 'Pick a type first'} allowCreate onCreateOption={createIssueOption} />

        <div className="col-span-2 rounded-lg border border-navy/20 p-3">
          <ImpactedProductsPicker companyId={profile?.company_id ?? null} locationId={locationId} selected={products} onChange={setProducts} />
        </div>

        <div className="col-span-2">
          <label className="text-xs font-heading text-inky uppercase tracking-wide block mb-1">Details</label>
          <textarea value={details} onChange={(e) => setDetails(e.target.value)} rows={3}
            className="w-full bg-cream border border-navy/40 rounded px-3 py-2 text-sm font-body text-navy focus:outline-none focus:ring-2 focus:ring-sky"
            placeholder="What was found…" />
        </div>

        <div className="flex items-end gap-3">
          <Toggle checked={contacted} onChange={setContacted} label="Contacted shop/AM?" color="green" />
        </div>
        <Input label="Contacted Date" type="date" value={contactedDate} onChange={(e) => setContactedDate(e.target.value)} disabled={!contacted} />

        <div className="col-span-2">
          <Input label="Follow-Up Date" type="date" value={followUp} onChange={(e) => setFollowUp(e.target.value)} />
          <p className="text-[10px] font-mono text-inky/50 mt-0.5">When to check back. Turns red in the table once the date passes and the report is still open.</p>
        </div>

        <Select label="Response from Shop/AM" value={response} onChange={(e) => setResponse(e.target.value)}
          options={[{ value: '', label: 'No response yet' }, ...RESPONSE_OPTIONS.map((r) => ({ value: r, label: r }))]} />
        <Input label="Response Date" type="date" value={dateAction} onChange={(e) => setDateAction(e.target.value)} />

        <div className="col-span-2">
          <Input label="Regional Director (if no response)" value={rdIfNo} onChange={(e) => setRdIfNo(e.target.value)} placeholder="Auto-fills from shop" />
        </div>

        <div className="col-span-2">
          <label className="text-xs font-heading text-inky uppercase tracking-wide block mb-1">Response Notes</label>
          <textarea value={responseNotes} onChange={(e) => setResponseNotes(e.target.value)} rows={3}
            className="w-full bg-cream border border-navy/40 rounded px-3 py-2 text-sm font-body text-navy focus:outline-none focus:ring-2 focus:ring-sky"
            placeholder="Follow-up notes…" />
        </div>

        <div className="col-span-2">
          <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}
            options={[{ value: '', label: 'Select status…' }, ...statusList.map((s) => ({ value: s, label: s }))]} />
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
