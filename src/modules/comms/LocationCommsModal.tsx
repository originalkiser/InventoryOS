import { useEffect, useMemo, useState } from 'react'
import { Modal, Button, Combobox, Select, Input, Toggle } from '@/components/ui'
import type { ComboboxOption } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { useCommsConfig } from './useCommsConfig'
import { isEmailMethod, isResolvedStatus, resolutionNotes, type LocationComm, type CommProduct } from './comms'
import { useExceptionConfig } from '@/modules/exceptions/useExceptionConfig'
import { followUpDate } from '@/modules/exceptions/exceptions'
import { DEFAULT_STATUS, EXCEPTION_STATUSES } from '@/modules/exceptions/exceptions'
import toast from 'react-hot-toast'

interface Props {
  open: boolean
  onClose: () => void
  existing?: Partial<LocationComm> | null
  lockedLocationId?: string | null // prefill (still changeable)
  onSaved: () => void
  onDelete?: (id: string) => void
}

const today = () => new Date().toISOString().split('T')[0]
const num = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: 1 }))

export function LocationCommsModal({ open, onClose, existing, lockedLocationId, onSaved, onDelete }: Props) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const loc = useLocations()
  const { config, addOption } = useCommsConfig()
  const { config: excConfig } = useExceptionConfig()

  const [locationId, setLocationId] = useState('')
  const [commDate, setCommDate] = useState('')
  const [contactMethod, setContactMethod] = useState('')
  const [emailSubject, setEmailSubject] = useState('')
  const [whoContacted, setWhoContacted] = useState('')
  const [commType, setCommType] = useState('')
  const [products, setProducts] = useState<CommProduct[]>([])
  const [actionTaken, setActionTaken] = useState('')
  const [status, setStatus] = useState('')
  const [notes, setNotes] = useState('')
  const [resolution, setResolution] = useState('')
  // Exception branch
  const [reportType, setReportType] = useState('')
  const [issue, setIssue] = useState('')
  const [details, setDetails] = useState('')
  const [response, setResponse] = useState('')
  const [responseDate, setResponseDate] = useState('')
  const [responseNotes, setResponseNotes] = useState('')
  const [followUp, setFollowUp] = useState('')
  // Linked exception's metadata, kept so the update below merges into it
  // instead of replacing it (it also holds impacted_products/bumped_until).
  const [excMetadata, setExcMetadata] = useState<Record<string, unknown>>({})

  const [usage, setUsage] = useState<Record<string, { on_hand: number | null; days: number | null }>>({})
  const [configured, setConfigured] = useState<string[]>([])
  const [addPick, setAddPick] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)

  useEffect(() => {
    if (!open) return
    setLocationId(existing?.location_id ?? lockedLocationId ?? '')
    setCommDate(existing?.comm_date ?? (existing?.id ? '' : today()))
    setContactMethod(existing?.contact_method ?? '')
    setEmailSubject(existing?.email_subject ?? '')
    setWhoContacted(existing?.who_contacted ?? '')
    setCommType(existing?.comm_type ?? '')
    setProducts((existing?.products as CommProduct[]) ?? [])
    setActionTaken(existing?.action_taken ?? '')
    setStatus(existing?.status ?? (existing?.id ? '' : DEFAULT_STATUS))
    setNotes(existing?.notes ?? '')
    setResolution(resolutionNotes(existing))
    setReportType(''); setIssue(''); setDetails(''); setResponse(''); setResponseDate(''); setResponseNotes('')
    setFollowUp(''); setExcMetadata({})
    setDeleteConfirm(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing, open, lockedLocationId])

  // When editing a comm linked to an exception, load that exception's fields.
  useEffect(() => {
    if (!open || !existing?.exception_report_id) return
    ;(supabase as any).schema('inventory').from('exception_reports').select('*').eq('id', existing.exception_report_id).maybeSingle()
      .then(({ data }: any) => {
        if (!data) return
        setReportType(data.report_type ?? ''); setIssue(data.issue ?? ''); setDetails(data.details ?? '')
        setResponse(data.response ?? ''); setResponseDate(data.date_of_shop_action ?? ''); setResponseNotes(data.response_notes ?? '')
        setExcMetadata((data.metadata ?? {}) as Record<string, unknown>)
        setFollowUp(followUpDate(data) ?? '')
      })
  }, [open, existing?.exception_report_id])

  // Load the shop's product usage (on hand + days of supply) and configured products.
  useEffect(() => {
    if (!open || !companyId || !locationId) { setUsage({}); setConfigured([]); return }
    const sb = supabase as any
    Promise.all([
      sb.schema('inventory').from('product_usage').select('product_id, on_hands, days_of_supply').eq('company_id', companyId).eq('location_id', locationId),
      sb.schema('inventory').from('location_order_config').select('product_id').eq('company_id', companyId).eq('location_id', locationId),
    ]).then(([u, c]: any[]) => {
      setUsage(Object.fromEntries((u.data ?? []).map((r: any) => [r.product_id, { on_hand: r.on_hands, days: r.days_of_supply }])))
      setConfigured([...new Set(((c.data ?? []) as any[]).map((r) => r.product_id).filter(Boolean))] as string[])
    })
  }, [open, companyId, locationId])

  const isProductRequest = commType === 'Product Request'
  const isException = commType === 'Exception Reporting'
  const selectedIds = new Set(products.map((p) => p.product_id))

  const nonConfiguredOptions: ComboboxOption[] = useMemo(() =>
    Object.keys(usage).filter((pid) => !configured.includes(pid) && !selectedIds.has(pid)).sort().map((pid) => ({ value: pid, label: pid })),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [usage, configured, products])

  function addProduct(pid: string, isConfigured: boolean) {
    if (!pid || selectedIds.has(pid)) return
    const u = usage[pid]
    setProducts((prev) => [...prev, { product_id: pid, configured: isConfigured, on_hand: u?.on_hand ?? null, days_of_supply: u?.days ?? null, orderable: true, eta: null }])
  }
  const patchProduct = (pid: string, patch: Partial<CommProduct>) => setProducts((prev) => prev.map((p) => (p.product_id === pid ? { ...p, ...patch } : p)))
  const removeProduct = (pid: string) => setProducts((prev) => prev.filter((p) => p.product_id !== pid))

  const mkCreate = (field: 'contactMethods' | 'whoContacted' | 'commTypes' | 'actionTaken') =>
    async (value: string): Promise<ComboboxOption> => { addOption(field, value); return { value, label: value } }

  async function save() {
    if (!companyId) return
    if (!locationId) { toast.error('Pick a shop'); return }
    setSaving(true)
    const sb = supabase as any
    const stamp = { updated_by: profile?.id ?? null, updated_at: new Date().toISOString() }

    // Exception branch → upsert an exception_reports row and link it.
    let exceptionId = existing?.exception_report_id ?? null
    if (isException) {
      const excFields = {
        company_id: companyId, location_id: locationId,
        area_manager: loc.fieldValue(locationId, 'area_manager') || null,
        date_of_finding: commDate || null,
        date_of_shop_action: responseDate || null,
        report_type: reportType || null, issue: issue || null, details: details.trim() || null,
        response: response.trim() || null, response_notes: responseNotes.trim() || null,
        metadata: { ...excMetadata, follow_up_date: followUp || null },
        rd_if_no: loc.fieldValue(locationId, 'regional_director') || loc.fieldValue(locationId, 'director') || null,
        contacted: true, contacted_date: commDate || null,
        status: status || null, last_change_source: 'comms', ...stamp,
      }
      if (exceptionId) {
        const { error } = await sb.schema('inventory').from('exception_reports').update(excFields).eq('id', exceptionId)
        if (error) { toast.error(error.message); setSaving(false); return }
      } else {
        const { data, error } = await sb.schema('inventory').from('exception_reports').insert(excFields).select('id').single()
        if (error) { toast.error(error.message); setSaving(false); return }
        exceptionId = data.id
      }
    }

    const payload = {
      company_id: companyId, location_id: locationId, comm_date: commDate || null,
      contact_method: contactMethod || null,
      email_subject: isEmailMethod(contactMethod) ? (emailSubject.trim() || null) : null,
      who_contacted: whoContacted || null, comm_type: commType || null,
      products: isProductRequest ? products : [],
      action_taken: isProductRequest ? (actionTaken || null) : null,
      exception_report_id: exceptionId, status: status || null, notes: notes.trim() || null,
      metadata: { ...(existing?.metadata ?? {}), resolution_notes: resolution.trim() || null },
      last_change_source: 'manual', ...stamp,
    }
    const { error } = existing?.id
      ? await sb.schema('inventory').from('location_comms').update(payload).eq('id', existing.id)
      : await sb.schema('inventory').from('location_comms').insert(payload)
    if (error) { toast.error(error.message); setSaving(false); return }
    toast.success(existing?.id ? 'Communication updated' : 'Communication logged')
    setSaving(false)
    onSaved()
    onClose()
  }

  const opt = (arr: string[], cur: string) => [...new Set([...arr, ...(cur ? [cur] : [])])].map((v) => ({ value: v, label: v }))
  const statusList = [...new Set([...EXCEPTION_STATUSES, ...(status ? [status] : [])])]

  return (
    <Modal open={open} onClose={onClose} title={existing?.id ? 'Edit Communication' : 'New Communication'} size="lg">
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <Combobox label="Shop *" options={loc.includedOptions} value={locationId} onChange={setLocationId} placeholder="Select shop…" />
        </div>

        <Input label="Date" type="date" value={commDate} onChange={(e) => setCommDate(e.target.value)} />
        <Combobox label="Contact Method" options={opt(config.contactMethods, contactMethod)} value={contactMethod} onChange={setContactMethod} placeholder="Select or add…" allowCreate onCreateOption={mkCreate('contactMethods')} />

        {isEmailMethod(contactMethod) && (
          <div className="col-span-2"><Input label="Email Subject" value={emailSubject} onChange={(e) => setEmailSubject(e.target.value)} /></div>
        )}

        <Combobox label="Who Contacted" options={opt(config.whoContacted, whoContacted)} value={whoContacted} onChange={setWhoContacted} placeholder="Select or add…" allowCreate onCreateOption={mkCreate('whoContacted')} />
        <Combobox label="Communication Type" options={opt(config.commTypes, commType)} value={commType} onChange={setCommType} placeholder="Select or add…" allowCreate onCreateOption={mkCreate('commTypes')} />

        {isProductRequest && (
          <div className="col-span-2 flex flex-col gap-2 rounded-lg border border-navy/20 p-3">
            <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Products Requested</span>
            <div className="flex flex-wrap gap-1.5">
              {configured.length === 0 && <span className="text-[11px] font-mono text-inky/40 italic">No configured products for this shop</span>}
              {configured.map((pid) => (
                <button key={pid} onClick={() => (selectedIds.has(pid) ? removeProduct(pid) : addProduct(pid, true))}
                  className={['px-2 py-1 rounded text-[11px] font-mono border transition-colors', selectedIds.has(pid) ? 'bg-navy text-cream border-navy' : 'bg-cream text-navy border-navy/30 hover:border-navy'].join(' ')}>
                  {pid}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-mono text-inky/60">Non-configured:</span>
              <div className="w-64"><Combobox options={nonConfiguredOptions} value={addPick} onChange={(v) => { addProduct(v, false); setAddPick('') }} placeholder="Add another product…" allowCreate onCreateOption={async (v) => ({ value: v, label: v })} /></div>
            </div>
            {products.length > 0 && (
              <div className="overflow-x-auto rounded border border-navy/20 mt-1">
                <table className="w-full text-xs font-mono">
                  <thead><tr className="bg-cream text-inky uppercase tracking-wide border-b border-navy/20">
                    <th className="text-left px-2 py-1">Product</th><th className="text-right px-2 py-1">On Hand</th><th className="text-right px-2 py-1">Days Supply</th>
                    <th className="text-center px-2 py-1">Orderable</th><th className="text-left px-2 py-1">ETA</th><th className="px-2 py-1"></th>
                  </tr></thead>
                  <tbody>
                    {products.map((p) => (
                      <tr key={p.product_id} className="border-b border-navy/10">
                        <td className="px-2 py-1 text-navy">{p.product_id}{p.configured ? '' : ' *'}</td>
                        <td className="px-2 py-1 text-right text-navy">{num(p.on_hand)}</td>
                        <td className="px-2 py-1 text-right text-navy">{num(p.days_of_supply)}</td>
                        <td className="px-2 py-1 text-center"><input type="checkbox" checked={p.orderable} onChange={(e) => patchProduct(p.product_id, { orderable: e.target.checked })} className="accent-sky" /></td>
                        <td className="px-2 py-1"><input type="date" value={p.eta ?? ''} disabled={!p.orderable} onChange={(e) => patchProduct(p.product_id, { eta: e.target.value || null })} className="bg-cream border border-navy/30 rounded px-1 py-0.5 text-xs" /></td>
                        <td className="px-2 py-1 text-right"><button onClick={() => removeProduct(p.product_id)} className="text-inky/50 hover:text-red-500">×</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="text-[10px] font-mono text-inky/50 px-2 py-1">* non-configured · uncheck Orderable to exclude a product that couldn't be ordered (ETA hides)</p>
              </div>
            )}
            <Combobox label="Action Taken" options={opt(config.actionTaken, actionTaken)} value={actionTaken} onChange={setActionTaken} placeholder="Select or add…" allowCreate onCreateOption={mkCreate('actionTaken')} />
          </div>
        )}

        {isException && (
          <div className="col-span-2 flex flex-col gap-3 rounded-lg border border-navy/20 p-3">
            <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Exception Report (feeds Exception Reporting)</span>
            <div className="grid grid-cols-2 gap-3">
              <Select label="Report Type" value={reportType} onChange={(e) => setReportType(e.target.value)} options={[{ value: '', label: 'Select type…' }, ...excConfig.types.map((t) => ({ value: t, label: t }))]} />
              <Combobox label="ER Issue" options={(excConfig.issues[reportType] ?? []).map((v) => ({ value: v, label: v }))} value={issue} onChange={setIssue} placeholder={reportType ? 'Select…' : 'Pick a type first'} />
            </div>
            <div>
              <label className="text-xs font-heading text-inky uppercase tracking-wide block mb-1">Details</label>
              <textarea value={details} onChange={(e) => setDetails(e.target.value)} rows={2} className="w-full bg-cream border border-navy/40 rounded px-3 py-2 text-sm font-body text-navy focus:outline-none focus:ring-2 focus:ring-sky" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input label="Response from Shop/AM" value={response} onChange={(e) => setResponse(e.target.value)} placeholder="e.g. Yes" />
              <Input label="Response Date" type="date" value={responseDate} onChange={(e) => setResponseDate(e.target.value)} />
              <Input label="Follow-Up Sent" type="date" value={followUp} onChange={(e) => setFollowUp(e.target.value)} />
            </div>
            <div>
              <label className="text-xs font-heading text-inky uppercase tracking-wide block mb-1">Response Notes</label>
              <textarea value={responseNotes} onChange={(e) => setResponseNotes(e.target.value)} rows={2} className="w-full bg-cream border border-navy/40 rounded px-3 py-2 text-sm font-body text-navy focus:outline-none focus:ring-2 focus:ring-sky" />
            </div>
          </div>
        )}

        <div className="col-span-2">
          <label className="text-xs font-heading text-inky uppercase tracking-wide block mb-1">Notes</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="w-full bg-cream border border-navy/40 rounded px-3 py-2 text-sm font-body text-navy focus:outline-none focus:ring-2 focus:ring-sky" placeholder="General notes…" />
        </div>

        <div className="col-span-2">
          <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: '', label: 'Select status…' }, ...statusList.map((s) => ({ value: s, label: s }))]} />
        </div>

        {/* Only asked for once the comm is being closed out — a resolution
            doesn't exist yet while it's still pending. */}
        {isResolvedStatus(status) && (
          <div className="col-span-2">
            <label className="text-xs font-heading text-inky uppercase tracking-wide block mb-1">Resolution Notes</label>
            <textarea value={resolution} onChange={(e) => setResolution(e.target.value)} rows={2}
              className="w-full bg-cream border border-navy/40 rounded px-3 py-2 text-sm font-body text-navy focus:outline-none focus:ring-2 focus:ring-sky"
              placeholder="How was this resolved?" />
          </div>
        )}
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
          <Button size="sm" loading={saving} onClick={save}>{existing?.id ? 'Update' : 'Log'} Communication</Button>
        </div>
      </div>
    </Modal>
  )
}
