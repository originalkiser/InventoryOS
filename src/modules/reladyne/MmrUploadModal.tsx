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
import {
  parseVolumeDataWorkbook, parseItemFillStatsWorkbook, parseOtifSheets, parseVolumeCommitment,
} from './mmrParsers'
import { useMmrUpload } from './useMmrData'

async function readWorkbook(file: File): Promise<XLSX.WorkBook> {
  const buf = await file.arrayBuffer()
  return XLSX.read(buf, { type: 'array' })
}

function UploadSlot({
  title, description, needsYear, year, onYearChange, onFile, lastSummary, loading,
}: {
  title: string
  description: string
  needsYear: boolean
  year: number
  onYearChange: (y: number) => void
  onFile: (file: File) => void
  lastSummary: string | null
  loading: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  return (
    <div className="rounded border border-navy/15 p-3 flex flex-col gap-2">
      <div>
        <div className="text-xs font-mono font-bold text-navy uppercase tracking-wide">{title}</div>
        <div className="text-[10px] font-mono text-inky/60 mt-0.5">{description}</div>
      </div>
      {needsYear && (
        <label className="flex items-center gap-2 text-[10px] font-mono text-inky/70">
          Reporting year (this file's month labels have no year of their own)
          <Input type="number" min={2020} max={2100} value={year} onChange={(e) => onYearChange(Number(e.target.value) || year)} className="w-20" />
        </label>
      )}
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
        <span className="text-[11px] font-mono text-inky">{loading ? 'Parsing…' : 'Drop .xlsx here, or click to browse'}</span>
      </div>
      {lastSummary && <div className="text-[10px] font-mono text-navy">{lastSummary}</div>}
    </div>
  )
}

export function MmrUploadModal({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: () => void }) {
  const upload = useMmrUpload()
  const currentYear = new Date().getFullYear()
  const [fillYear, setFillYear] = useState(currentYear)
  const [mmrYear, setMmrYear] = useState(currentYear)
  const [busy, setBusy] = useState<string | null>(null)
  const [summaries, setSummaries] = useState<Record<string, string>>({})

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

  async function handleItemFillFile(file: File) {
    setBusy('fill')
    try {
      const wb = await readWorkbook(file)
      const rows = parseItemFillStatsWorkbook(wb, fillYear)
      if (!rows.length) { toast.error('No rows found in the Export sheet — is this the right file?'); return }
      const added = await upload.uploadItemFillStats(rows)
      setSummaries((s) => ({ ...s, fill: `${file.name}: ${rows.length.toLocaleString()} rows read, ${added.toLocaleString()} new` }))
      toast.success(`Item Fill Trend: ${added.toLocaleString()} new row(s) added`)
      onImported()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to import')
    } finally {
      setBusy(null)
    }
  }

  async function handleMmrFile(file: File) {
    setBusy('mmr')
    try {
      const wb = await readWorkbook(file)
      const otif = parseOtifSheets(wb, mmrYear)
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

  return (
    <Modal open={open} onClose={onClose} title="Upload Monthly Data" size="lg">
      <div className="flex flex-col gap-3">
        <p className="text-[11px] font-mono text-inky/60">
          Upload whichever of these you have this month — each is independent. Rows already in the system (same
          shop/product/month, or same stat/month) are skipped, never overwritten, so re-uploading a month you've
          already loaded is always safe.
        </p>
        <UploadSlot
          title="Product Gallons"
          description="The workbook with a 'StricklandData' sheet — gallons/revenue by shop and product, month already included in the file."
          needsYear={false} year={currentYear} onYearChange={() => {}}
          onFile={handleVolumeFile} lastSummary={summaries.volume ?? null} loading={busy === 'volume'}
        />
        <UploadSlot
          title="Item Fill Trend Data"
          description="The 'Export' sheet with side-by-side month blocks of Order Count/Fill Count/Item Fill %."
          needsYear year={fillYear} onYearChange={setFillYear}
          onFile={handleItemFillFile} lastSummary={summaries.fill ?? null} loading={busy === 'fill'}
        />
        <UploadSlot
          title="MMR Workbook"
          description="The workbook with the 4 'OTIF 90' sheets and the Volume Summary tab's own commitment table."
          needsYear year={mmrYear} onYearChange={setMmrYear}
          onFile={handleMmrFile} lastSummary={summaries.mmr ?? null} loading={busy === 'mmr'}
        />
        <div className="flex justify-end pt-1">
          <Button size="sm" variant="secondary" onClick={onClose}>Done</Button>
        </div>
      </div>
    </Modal>
  )
}
