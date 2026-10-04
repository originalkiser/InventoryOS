// One big upload (or several, if Droptop's export has to be batched) of count summaries across ANY dates — each row
// keeps its own count date, so one file can cover many weeks. Re-uploading overlapping files is safe: a row whose
// shop + date + count type is already in the system is skipped instead of duplicated.
import { useState } from 'react'
import { FileUploadZone } from '@/components/upload/FileUploadZone'
import { ColumnMapper } from '@/components/upload/ColumnMapper'
import { Card, CardBody } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { useLocations } from '@/hooks/useLocations'
import { SUMMARY_FIELDS, toNumber } from '@/modules/monthend/countsShared'
import type { ColumnMapping, ParsedUpload } from '@/types'
import toast from 'react-hot-toast'

// Weekly counts have no oil_adjustments column; only the shop, date and count type are required here.
const BULK_FIELDS = SUMMARY_FIELDS
  .filter((f) => f.name !== 'oil_adjustments')
  .map((f) => ({ ...f, required: f.name === 'location' || f.name === 'count_date' || f.name === 'count_type' }))
const NUMERIC = ['total_adjustments', 'adjustment_value', 'abs_adjustment_value', 'ending_inventory_cost']
const CHUNK = 500

/** m/d/yyyy, yyyy-mm-dd, or anything Date can read — as a UTC-midnight ISO string (a count has a date, not a time). */
export function parseCountDate(raw: string): string | null {
  const s = (raw ?? '').trim()
  if (!s) return null
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s)
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toISOString()
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s)
  if (m) {
    const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]
    return new Date(Date.UTC(y, +m[1] - 1, +m[2])).toISOString()
  }
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString()
}

export function WeeklyBulkUpload({ companyId, onImported }: { companyId: string; onImported: () => void }) {
  const loc = useLocations()
  const [parsed, setParsed] = useState<ParsedUpload | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  async function importRows(mappings: ColumnMapping[]) {
    if (!parsed) return
    setBusy(true); setResult(null)
    try {
      const col = (name: string) => mappings.find((m) => m.fieldName === name)?.sourceColumn
      const locCol = col('location'), dateCol = col('count_date')
      const batchId = crypto.randomUUID()
      let unresolved = 0, badDate = 0
      const rows: Record<string, unknown>[] = []
      for (const r of parsed.rows) {
        const locId = locCol ? loc.resolveId(r[locCol] ?? '') : null
        if (!locId) { unresolved++; continue }
        const iso = dateCol ? parseCountDate(r[dateCol] ?? '') : null
        if (!iso) { badDate++; continue }
        const out: Record<string, unknown> = { company_id: companyId, upload_batch_id: batchId, location_id: locId, count_date: iso }
        for (const m of mappings) {
          if (m.fieldName === 'location' || m.fieldName === 'count_date') continue
          const raw = r[m.sourceColumn] ?? ''
          if (NUMERIC.includes(m.fieldName)) { const n = toNumber(raw); out[m.fieldName] = n === null ? null : m.invert ? -n : n }
          else out[m.fieldName] = raw || null
        }
        rows.push(out)
      }
      if (rows.length === 0) { setResult(`Nothing to import — ${unresolved} unresolved shop(s), ${badDate} row(s) without a usable date.`); return }

      // What's already in the system for this file's date range (shop + day + count type).
      const dates = rows.map((r) => r.count_date as string).sort()
      const sb = supabase as any
      const existing = new Set<string>()
      for (let from = 0; ; from += 1000) {
        const { data, error } = await sb.schema('inventory').from('weekly_counts').select('location_id, count_date, count_type')
          .eq('company_id', companyId).gte('count_date', dates[0]).lte('count_date', dates[dates.length - 1])
          .order('id', { ascending: true }).range(from, from + 999)
        if (error) throw new Error(error.message)
        for (const e of (data ?? []) as any[]) existing.add(`${e.location_id}|${String(e.count_date).slice(0, 10)}|${String(e.count_type ?? '').toLowerCase()}`)
        if (!data || data.length < 1000) break
      }
      const seen = new Set(existing)
      const fresh = rows.filter((r) => {
        const k = `${r.location_id}|${String(r.count_date).slice(0, 10)}|${String(r.count_type ?? '').toLowerCase()}`
        if (seen.has(k)) return false
        seen.add(k); return true
      })
      for (let i = 0; i < fresh.length; i += CHUNK) {
        const { error } = await sb.schema('inventory').from('weekly_counts').insert(fresh.slice(i, i + CHUNK))
        if (error) throw new Error(error.message)
      }
      const msg = `Imported ${fresh.length} count(s); ${rows.length - fresh.length} already in the system skipped`
        + (unresolved ? `; ${unresolved} row(s) with an unrecognized shop` : '') + (badDate ? `; ${badDate} row(s) without a usable date` : '') + '.'
      setResult(msg); toast.success(`Imported ${fresh.length} counts`)
      setParsed(null)
      onImported()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Import failed')
    } finally { setBusy(false) }
  }

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <div>
          <span className="text-xs font-mono text-navy uppercase tracking-wide">Upload counts (any dates)</span>
          <p className="text-[11px] font-mono text-inky/60 mt-0.5">
            One file with all counts — or several, if Droptop's export has to be split. Each row keeps its own count date, so a
            file can span many weeks. Rows already in the system (same shop, day and count type) are skipped, so overlapping
            files are safe.
          </p>
        </div>
        {!parsed ? (
          <FileUploadZone onParsed={(r) => { setParsed(r); setResult(null) }} />
        ) : (
          <>
            <ColumnMapper
              headers={parsed.headers}
              requiredFields={BULK_FIELDS}
              rememberKey="weekly.bulk_upload"
              previewRows={parsed.rows.slice(0, 5)}
              onConfirm={importRows}
              onCancel={() => setParsed(null)}
            />
            {busy && <p className="text-xs text-inky font-mono">Importing…</p>}
          </>
        )}
        {result && <p className="text-xs font-mono text-navy">{result}</p>}
      </CardBody>
    </Card>
  )
}
