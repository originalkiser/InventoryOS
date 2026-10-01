// Monthly upload for RelaDyne's 3 separate spreadsheet exports — direct ask
// 2026-09-30. Each file is independent (upload whichever ones you have this
// month) and goes through mmrParsers.ts's own per-file parsing, then an
// upsert that silently skips rows already in the system (see migration
// 20260930by's header comment) — re-uploading an already-loaded month is a
// safe no-op, not a duplicate or an overwrite.
import { useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import toast from 'react-hot-toast'
import { Button, Input, Modal } from '@/components/ui'
import { ClearTableButton } from '@/components/config/ClearTableButton'
import {
  parseVolumeDataWorkbook, parseItemFillStatsWorkbook, parseOtifSheets, parseVolumeCommitment,
  peekItemFillStatsMonths, peekOtifMonths, defaultYearsForMonths,
} from './mmrParsers'
import { useMmrUpload } from './useMmrData'

async function readWorkbook(file: File): Promise<XLSX.WorkBook> {
  const buf = await file.arrayBuffer()
  return XLSX.read(buf, { type: 'array' })
}

// Direct ask 2026-10-01: a trailing report genuinely spans a year boundary
// (e.g. Sep '25 through Aug '26), so a single "reporting year" field applied
// to the WHOLE file silently mis-tagged whichever months fell on the other
// side of it. This replaces that with a per-month review step — the months
// actually found in the file, each with its own editable year (seeded with
// a reasonable guess from defaultYearsForMonths, not assumed correct).
function MonthYearReview({ months, years, onChange }: { months: string[]; years: number[]; onChange: (i: number, y: number) => void }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
      {months.map((m, i) => (
        <label key={`${m}-${i}`} className="flex items-center justify-between gap-2 text-[10px] font-mono text-inky/70 border border-navy/15 rounded px-2 py-1">
          {m}
          <Input type="number" min={2020} max={2100} value={years[i]} onChange={(e) => onChange(i, Number(e.target.value) || years[i])} className="w-16" />
        </label>
      ))}
    </div>
  )
}

function DropZone({ onFile, label }: { onFile: (file: File) => void; label: string }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) onFile(f) }}
      onClick={() => inputRef.current?.click()}
      className={[
        'flex flex-col items-center justify-center p-4 border-2 border-dashed rounded cursor-pointer transition-colors min-h-[72px] text-center',
        dragging ? 'border-sky bg-sky/20' : 'border-navy/30 hover:border-sky/60 hover:bg-sky/10',
      ].join(' ')}
    >
      <input ref={inputRef} type="file" accept=".xlsx,.xls" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = '' }} />
      <span className="text-[11px] font-mono text-inky">{label}</span>
    </div>
  )
}

export function MmrUploadModal({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: () => void }) {
  const upload = useMmrUpload()
  const currentYear = new Date().getFullYear()
  const [busy, setBusy] = useState<string | null>(null)
  const [summaries, setSummaries] = useState<Record<string, string>>({})

  // ── Product Gallons — no year involved at all, direct upload. ───────────
  async function handleVolumeFile(file: File) {
    setBusy('volume')
    try {
      const wb = await readWorkbook(file)
      const rows = parseVolumeDataWorkbook(wb)
      if (!rows.length) { toast.error('No rows found in StricklandData sheet — is this the right file?'); return }
      const added = await upload.uploadVolumeData(rows)
      setSummaries((s) => ({ ...s, volume: `${file.name}: ${rows.length.toLocaleString()} rows read, ${added.toLocaleString()} new` }))
      toast.success(`Product Gallons: ${added.toLocaleString()} new row(s) added`)
      onImported()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to import')
    } finally {
      setBusy(null)
    }
  }

  // ── Item Fill Trend Data — stage the file, review/edit a year per month
  // block, then import. ────────────────────────────────────────────────────
  const [fillStaged, setFillStaged] = useState<{ file: File; wb: XLSX.WorkBook; months: string[]; years: number[] } | null>(null)

  async function stageItemFillFile(file: File) {
    const wb = await readWorkbook(file)
    const months = peekItemFillStatsMonths(wb)
    if (!months.length) { toast.error('No month blocks found in the Export sheet — is this the right file?'); return }
    setFillStaged({ file, wb, months, years: defaultYearsForMonths(months, currentYear) })
  }

  async function confirmItemFillImport() {
    if (!fillStaged) return
    setBusy('fill')
    try {
      const rows = parseItemFillStatsWorkbook(fillStaged.wb, fillStaged.years)
      const added = await upload.uploadItemFillStats(rows)
      setSummaries((s) => ({ ...s, fill: `${fillStaged.file.name}: ${rows.length.toLocaleString()} rows read, ${added.toLocaleString()} new` }))
      toast.success(`Item Fill Trend: ${added.toLocaleString()} new row(s) added`)
      onImported()
      setFillStaged(null)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to import')
    } finally {
      setBusy(null)
    }
  }

  // ── MMR Workbook — same stage/review/import flow for the OTIF sheets'
  // month axis. Volume Summary's own commitment rows carry their own Year
  // column already, so they need no review step and import immediately
  // alongside whatever OTIF years are confirmed. ──────────────────────────
  const [mmrStaged, setMmrStaged] = useState<{ file: File; wb: XLSX.WorkBook; months: string[]; years: number[] } | null>(null)

  async function stageMmrFile(file: File) {
    const wb = await readWorkbook(file)
    const months = peekOtifMonths(wb)
    if (!months.length) {
      // No OTIF sheets found — still try Volume Summary alone, which needs
      // no year review since its rows carry their own Year column.
      await importMmr(wb, file, [])
      return
    }
    setMmrStaged({ file, wb, months, years: defaultYearsForMonths(months, currentYear) })
  }

  async function importMmr(wb: XLSX.WorkBook, file: File, years: number[]) {
    setBusy('mmr')
    try {
      const otif = parseOtifSheets(wb, years)
      const commitment = parseVolumeCommitment(wb)
      if (!otif.length && !commitment.length) { toast.error('No OTIF or Volume Summary rows found — is this the right file?'); return }
      const [otifAdded, commitAdded] = await Promise.all([
        upload.uploadOtifStats(otif),
        upload.uploadCommitment(commitment),
      ])
      setSummaries((s) => ({ ...s, mmr: `${file.name}: ${otifAdded} new OTIF row(s), ${commitAdded} new commitment row(s)` }))
      toast.success(`MMR workbook: ${otifAdded + commitAdded} new row(s) added`)
      onImported()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to import')
    } finally {
      setBusy(null)
    }
  }

  async function confirmMmrImport() {
    if (!mmrStaged) return
    await importMmr(mmrStaged.wb, mmrStaged.file, mmrStaged.years)
    setMmrStaged(null)
  }

  return (
    <Modal open={open} onClose={onClose} title="Upload Monthly Data" size="lg">
      <div className="flex flex-col gap-3">
        <p className="text-[11px] font-mono text-inky/60">
          Upload whichever of these you have this month — each is independent. Rows already in the system (same
          shop/product/month, or same stat/month) are skipped, never overwritten, so re-uploading a month you've
          already loaded is always safe.
        </p>

        <div className="rounded border border-navy/15 p-3 flex flex-col gap-2">
          <div>
            <div className="text-xs font-mono font-bold text-navy uppercase tracking-wide">Product Gallons</div>
            <div className="text-[10px] font-mono text-inky/60 mt-0.5">
              The workbook with a 'StricklandData' sheet — gallons/revenue by shop and product, month already included in the file.
            </div>
          </div>
          <DropZone label={busy === 'volume' ? 'Parsing…' : 'Drop .xlsx here, or click to browse'} onFile={handleVolumeFile} />
          {summaries.volume && <div className="text-[10px] font-mono text-navy">{summaries.volume}</div>}
        </div>

        <div className="rounded border border-navy/15 p-3 flex flex-col gap-2">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-xs font-mono font-bold text-navy uppercase tracking-wide">Item Fill Trend Data</div>
              <div className="text-[10px] font-mono text-inky/60 mt-0.5">
                The 'Export' sheet with side-by-side month blocks of Order Count/Fill Count/Item Fill %.
              </div>
            </div>
            <ClearTableButton
              label="Clear"
              clearAll={async () => { await upload.clearItemFillStats(); onImported(); toast.success('Item Fill Trend data cleared') }}
              description="This permanently deletes every Item Fill Trend row for your workspace — use this before re-uploading with corrected years."
            />
          </div>
          {fillStaged ? (
            <>
              <p className="text-[10px] font-mono text-inky/60">
                Confirm (or correct) the year for each month block found in {fillStaged.file.name}:
              </p>
              <MonthYearReview months={fillStaged.months} years={fillStaged.years}
                onChange={(i, y) => setFillStaged((s) => s && { ...s, years: s.years.map((yr, idx) => (idx === i ? y : yr)) })} />
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="secondary" onClick={() => setFillStaged(null)}>Choose a different file</Button>
                <Button size="sm" loading={busy === 'fill'} onClick={confirmItemFillImport}>Import</Button>
              </div>
            </>
          ) : (
            <DropZone label={busy === 'fill' ? 'Parsing…' : 'Drop .xlsx here, or click to browse'} onFile={stageItemFillFile} />
          )}
          {summaries.fill && <div className="text-[10px] font-mono text-navy">{summaries.fill}</div>}
        </div>

        <div className="rounded border border-navy/15 p-3 flex flex-col gap-2">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-xs font-mono font-bold text-navy uppercase tracking-wide">MMR Workbook</div>
              <div className="text-[10px] font-mono text-inky/60 mt-0.5">
                The workbook with the 4 'OTIF 90' sheets and the Volume Summary tab's own commitment table.
              </div>
            </div>
            <ClearTableButton
              label="Clear OTIF"
              clearAll={async () => { await upload.clearOtifStats(); onImported(); toast.success('OTIF data cleared') }}
              description="This permanently deletes every OTIF row for your workspace — use this before re-uploading with corrected years. Volume Summary/commitment data is untouched (it reads its own year from the source sheet, so it was never affected)."
            />
          </div>
          {mmrStaged ? (
            <>
              <p className="text-[10px] font-mono text-inky/60">
                Confirm (or correct) the year for each OTIF month found in {mmrStaged.file.name} — Volume Summary's own
                commitment rows already carry their own year and need no review.
              </p>
              <MonthYearReview months={mmrStaged.months} years={mmrStaged.years}
                onChange={(i, y) => setMmrStaged((s) => s && { ...s, years: s.years.map((yr, idx) => (idx === i ? y : yr)) })} />
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="secondary" onClick={() => setMmrStaged(null)}>Choose a different file</Button>
                <Button size="sm" loading={busy === 'mmr'} onClick={confirmMmrImport}>Import</Button>
              </div>
            </>
          ) : (
            <DropZone label={busy === 'mmr' ? 'Parsing…' : 'Drop .xlsx here, or click to browse'} onFile={stageMmrFile} />
          )}
          {summaries.mmr && <div className="text-[10px] font-mono text-navy">{summaries.mmr}</div>}
        </div>

        <div className="flex justify-end pt-1">
          <Button size="sm" variant="secondary" onClick={onClose}>Done</Button>
        </div>
      </div>
    </Modal>
  )
}
