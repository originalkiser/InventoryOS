import { useState } from 'react'
import { FileUploadZone } from '@/components/upload/FileUploadZone'
import { ColumnMapper } from '@/components/upload/ColumnMapper'
import { DataSourceLinker } from '@/components/upload/DataSourceLinker'
import { Button, Input, Combobox, Card, CardBody } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { parseProductRows } from '@/lib/additiveProducts'
import { useLocations } from '@/hooks/useLocations'
import { PRODUCT_FIELDS, toNumber, locationOptions } from './countsShared'
import type { Location, ColumnMapping, ParsedUpload, CountUploadBatch } from '@/types'
import { format } from 'date-fns'
import toast from 'react-hot-toast'

type Mode = 'file' | 'live' | 'manual'

interface Props {
  locations: Location[]
  companyId: string
  countMonth: string
  uploadedBy: string | null
  batches: CountUploadBatch[]
  userNames: Record<string, string>
  onChanged: () => void
}

export function ProductDetailUpload({
  locations, companyId, countMonth, uploadedBy, batches, userNames, onChanged,
}: Props) {
  const loc = useLocations()
  const [mode, setMode] = useState<Mode>('file')
  const [parsed, setParsed] = useState<ParsedUpload | null>(null)
  const [fileName, setFileName] = useState('')
  const [importing, setImporting] = useState(false)

  async function importBatch(mappings: ColumnMapping[]) {
    if (!parsed) return
    setImporting(true)
    try {
      // 1. Create the batch row (non-destructive — kept separate from other batches)
      const { data: batch, error: batchErr } = await (supabase as any)
        .from('count_upload_batches')
        .insert({
          company_id: companyId,
          module: 'monthly',
          count_month: countMonth,
          file_name: fileName || 'Upload',
          source_type: 'file',
          uploaded_by: uploadedBy,
          row_count: parsed.totalRowsParsed,
        })
        .select()
        .single()
      if (batchErr) throw batchErr

      // 2. Parse with InverseToggle sign flips applied, resolve locations, insert product rows
      const productRows = parseProductRows(parsed.rows, mappings)
      let unresolved = 0
      const insertRows = productRows.map((p) => {
        const locId = p.location_code ? loc.resolveId(p.location_code) : null
        if (!locId && p.location_code) unresolved++
        return {
          company_id: companyId,
          upload_batch_id: batch.id,
          count_month: countMonth,
          location_id: locId,
          product_id: p.product_id,
          category: p.category || null,
          on_hand: p.on_hand,
          sold: p.sold,
          adjusted: p.adjusted,
          ending_value: p.ending_value,
        }
      })

      const { error: rowsErr } = await (supabase as any)
        .from('monthly_count_products')
        .insert(insertRows)
      if (rowsErr) throw rowsErr

      toast.success(`Added batch: ${insertRows.length} product rows${unresolved ? ` · ${unresolved} unresolved` : ''}`)
      setParsed(null)
      setFileName('')
      onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to import batch')
    } finally {
      setImporting(false)
    }
  }

  async function removeBatch(batch: CountUploadBatch) {
    if (!confirm(`Remove batch "${batch.file_name ?? 'Upload'}"? Its ${batch.row_count} rows will be deleted and totals recomputed.`)) return
    const sb = supabase as any
    const { error: e1 } = await sb.from('monthly_count_products').delete().eq('upload_batch_id', batch.id)
    const { error: e2 } = await sb.from('count_upload_batches').delete().eq('id', batch.id)
    if (e1 || e2) toast.error('Failed to remove batch')
    else {
      toast.success('Batch removed — totals recomputed')
      onChanged()
    }
  }

  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <span className="text-xs font-mono text-inky uppercase tracking-wide">
            Product Detail <span className="text-orange-600">· additive</span>
          </span>
          <ModeSwitch mode={mode} onChange={(m) => { setMode(m); setParsed(null) }} />
        </div>

        {mode === 'file' && (
          !parsed ? (
            <div className="flex flex-col gap-3">
              <div className="rounded border border-navy/20 bg-navy/5 px-4 py-3 flex flex-col gap-2">
                <p className="text-[10px] font-mono text-inky/60 uppercase tracking-widest">Expected columns in your file</p>
                <div className="grid grid-cols-2 gap-x-8 gap-y-1">
                  {PRODUCT_FIELDS.map((f) => (
                    <div key={f.name} className="flex items-center gap-1.5 min-w-0">
                      <span className={['text-[10px] font-mono flex-shrink-0 rounded px-1 py-0.5 leading-tight', f.required === true ? 'bg-navy/20 text-navy' : 'bg-inky/10 text-inky/50'].join(' ')}>
                        {f.required === true ? 'REQ' : 'OPT'}
                      </span>
                      <span className="text-xs font-mono text-navy truncate">{f.label}</span>
                    </div>
                  ))}
                </div>
              </div>
              <FileUploadZone onParsed={(r, file) => { setParsed(r); setFileName(file.name) }} />
            </div>
          ) : (
            <>
              <ColumnMapper
                headers={parsed.headers}
                requiredFields={PRODUCT_FIELDS}
                rememberKey="monthend.products"
                previewRows={parsed.rows.slice(0, 5)}
                onConfirm={importBatch}
                onCancel={() => setParsed(null)}
              />
              {importing && <p className="text-xs text-inky font-mono">Importing batch…</p>}
            </>
          )
        )}

        {mode === 'live' && <DataSourceLinker configType="monthly_count_products" />}

        {mode === 'manual' && (
          <ManualProductForm
            locations={locations}
            companyId={companyId}
            countMonth={countMonth}
            uploadedBy={uploadedBy}
            onSaved={onChanged}
          />
        )}

        {/* Batches loaded this period */}
        <div className="flex flex-col gap-2">
          <span className="text-xs font-mono text-inky uppercase tracking-wide">
            Batches Loaded This Period ({batches.length})
          </span>
          {batches.length === 0 ? (
            <p className="text-xs text-inky/70 font-mono">No product batches uploaded for this period yet.</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {batches.map((b) => (
                <div
                  key={b.id}
                  className="flex items-center justify-between gap-3 px-3 py-2 border border-navy/30 rounded bg-cream"
                >
                  <div className="flex flex-col">
                    <span className="text-xs font-mono text-navy">{b.file_name ?? 'Upload'}</span>
                    <span className="text-[11px] font-mono text-inky">
                      {b.row_count.toLocaleString()} rows
                      {' · '}{b.uploaded_by ? (userNames[b.uploaded_by] ?? 'Unknown') : 'Unknown'}
                      {' · '}{format(new Date(b.created_at), 'MMM d, h:mm a')}
                    </span>
                  </div>
                  <button
                    onClick={() => removeBatch(b)}
                    className="text-xs font-mono text-red-400 hover:text-red-300 border border-red-500/30 rounded px-2 py-1 hover:bg-red-500/10"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  )
}

function ModeSwitch({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  const opts: { value: Mode; label: string }[] = [
    { value: 'file', label: 'File' },
    { value: 'live', label: 'Live Source' },
    { value: 'manual', label: 'Manual' },
  ]
  return (
    <div className="flex rounded border border-navy/30 overflow-hidden">
      {opts.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={[
            'px-3 py-1 text-xs font-mono transition-colors',
            mode === o.value ? 'bg-[#00e5ff]/10 text-inky' : 'text-inky hover:text-navy',
          ].join(' ')}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function ManualProductForm({
  locations, companyId, countMonth, uploadedBy, onSaved,
}: { locations: Location[]; companyId: string; countMonth: string; uploadedBy: string | null; onSaved: () => void }) {
  const [locationId, setLocationId] = useState('')
  const [productId, setProductId] = useState('')
  const [onHand, setOnHand] = useState('')
  const [sold, setSold] = useState('')
  const [adjusted, setAdjusted] = useState('')
  const [endingValue, setEndingValue] = useState('')
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!locationId) { toast.error('Location is required'); return }
    if (!productId.trim()) { toast.error('Product is required'); return }
    setSaving(true)
    const sb = supabase as any
    const { data: batch, error: batchErr } = await sb
      .from('count_upload_batches')
      .insert({
        company_id: companyId,
        module: 'monthly',
        count_month: countMonth,
        file_name: 'Manual entry',
        source_type: 'file',
        uploaded_by: uploadedBy,
        row_count: 1,
      })
      .select()
      .single()
    if (batchErr) { setSaving(false); toast.error(batchErr.message); return }

    const { error } = await sb.from('monthly_count_products').insert({
      company_id: companyId,
      upload_batch_id: batch.id,
      count_month: countMonth,
      location_id: locationId,
      product_id: productId.trim(),
      on_hand: toNumber(onHand),
      sold: toNumber(sold),
      adjusted: toNumber(adjusted),
      ending_value: toNumber(endingValue),
    })
    setSaving(false)
    if (error) toast.error(error.message)
    else {
      toast.success('Product row added as a new batch')
      setProductId(''); setOnHand(''); setSold(''); setAdjusted(''); setEndingValue('')
      onSaved()
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <Combobox
          label="Location *"
          options={locationOptions(locations)}
          value={locationId}
          onChange={(v) => setLocationId(v)}
          placeholder="Select location"
        />
        <Input label="Product *" value={productId} onChange={(e) => setProductId(e.target.value)} />
        <Input label="On Hand" value={onHand} onChange={(e) => setOnHand(e.target.value)} />
        <Input label="Sold" value={sold} onChange={(e) => setSold(e.target.value)} />
        <Input label="Adjusted" value={adjusted} onChange={(e) => setAdjusted(e.target.value)} />
        <Input label="Ending Value" value={endingValue} onChange={(e) => setEndingValue(e.target.value)} />
      </div>
      <div className="flex justify-end">
        <Button size="sm" loading={saving} onClick={save}>Add Product Row</Button>
      </div>
    </div>
  )
}
