// Expected Oil Balance upload (2026-09-22 request) — Finance's own modeled
// ending balance for oil this period (starting balance + bills - sold),
// one row per shop. Feeds the "Expected Oil Balance" recount rule below,
// which compares this against a LIVE current on-hand oil value (see
// get_current_oil_on_hand_value's own migration comment) and flags a shop
// whose actual value comes in meaningfully lower than expected — the
// signal Finance actually cares about, since bills lag and a shop should
// normally show HIGHER than the model, not lower.
//
// A plain replace-per-(shop, period) value, not an additive batch log like
// Product Detail — re-uploading the same period overwrites what was there.
import { useState } from 'react'
import { FileUploadZone } from '@/components/upload/FileUploadZone'
import { ColumnMapper } from '@/components/upload/ColumnMapper'
import { Card, CardBody, Combobox, Input, Button } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { useLocations } from '@/hooks/useLocations'
import { mappedValue } from '@/lib/columnTransform'
import { EXPECTED_OIL_FIELDS, toNumber } from './countsShared'
import type { Location, ColumnMapping, ParsedUpload } from '@/types'
import toast from 'react-hot-toast'

interface Props {
  companyId: string
  countMonth: string
  uploadedBy: string | null
  onChanged: () => void
}

export function ExpectedOilBalanceUpload({ companyId, countMonth, uploadedBy, onChanged }: Props) {
  const loc = useLocations()
  const [parsed, setParsed] = useState<ParsedUpload | null>(null)
  const [importing, setImporting] = useState(false)
  const [manualLocationId, setManualLocationId] = useState('')
  const [manualBalance, setManualBalance] = useState('')
  const [manualSaving, setManualSaving] = useState(false)

  async function importBatch(mappings: ColumnMapping[]) {
    if (!parsed) return
    setImporting(true)
    try {
      let unresolved = 0
      const rows = parsed.rows.map((r) => {
        const locRaw = mappings.find((m) => m.fieldName === 'location') ? mappedValue(r, mappings.find((m) => m.fieldName === 'location')!, mappings) : ''
        const balRaw = mappings.find((m) => m.fieldName === 'expected_balance') ? mappedValue(r, mappings.find((m) => m.fieldName === 'expected_balance')!, mappings) : ''
        const locationId = locRaw ? loc.resolveId(locRaw) : null
        if (!locationId && locRaw) unresolved++
        return { location_id: locationId, expected_balance: toNumber(balRaw) }
      }).filter((r): r is { location_id: string; expected_balance: number } => !!r.location_id && r.expected_balance != null)

      if (rows.length === 0) { toast.error('No resolvable rows in this file'); return }

      const payload = rows.map((r) => ({
        company_id: companyId, location_id: r.location_id, count_month: countMonth,
        expected_balance: r.expected_balance, uploaded_by: uploadedBy, uploaded_at: new Date().toISOString(),
      }))
      const { error } = await (supabase as any).schema('inventory').from('expected_oil_balances')
        .upsert(payload, { onConflict: 'company_id,location_id,count_month' })
      if (error) throw error

      toast.success(`Saved ${rows.length} expected balance${rows.length === 1 ? '' : 's'}${unresolved ? ` · ${unresolved} unresolved` : ''}`)
      setParsed(null)
      onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to import expected balances')
    } finally {
      setImporting(false)
    }
  }

  async function saveManual() {
    if (!manualLocationId) { toast.error('Location is required'); return }
    const bal = toNumber(manualBalance)
    if (bal == null) { toast.error('Expected balance is required'); return }
    setManualSaving(true)
    const { error } = await (supabase as any).schema('inventory').from('expected_oil_balances')
      .upsert({
        company_id: companyId, location_id: manualLocationId, count_month: countMonth,
        expected_balance: bal, uploaded_by: uploadedBy, uploaded_at: new Date().toISOString(),
      }, { onConflict: 'company_id,location_id,count_month' })
    setManualSaving(false)
    if (error) { toast.error(error.message); return }
    toast.success('Expected balance saved')
    setManualLocationId(''); setManualBalance('')
    onChanged()
  }

  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        <div>
          <span className="text-xs font-mono text-navy uppercase tracking-wide">Expected Oil Balance</span>
          <p className="text-[11px] font-mono text-inky/60 mt-0.5">
            One row per shop — Finance's modeled ending oil balance for this period. Re-uploading replaces a shop's
            existing value for this period.
          </p>
        </div>

        {!parsed ? (
          <div className="flex flex-col gap-3">
            <FileUploadZone onParsed={(r) => setParsed(r)} label="Drop a CSV or Excel file here, or click to browse" />
            <div className="flex items-end gap-2">
              <Combobox label="Location" options={loc.options} value={manualLocationId} onChange={setManualLocationId} placeholder="Select shop…" />
              <Input label="Expected Balance ($)" type="number" value={manualBalance} onChange={(e) => setManualBalance(e.target.value)} />
              <Button size="sm" loading={manualSaving} onClick={saveManual}>Save</Button>
            </div>
          </div>
        ) : (
          <ColumnMapper
            headers={parsed.headers}
            requiredFields={EXPECTED_OIL_FIELDS}
            rememberKey="monthend.expected_oil_balance"
            previewRows={parsed.rows.slice(0, 5)}
            onConfirm={importBatch}
            onCancel={() => setParsed(null)}
          />
        )}
        {importing && <p className="text-xs text-inky font-mono">Importing…</p>}
      </CardBody>
    </Card>
  )
}
