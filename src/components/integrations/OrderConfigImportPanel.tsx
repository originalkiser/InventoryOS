import { useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { Button } from '@/components/ui'
import {
  parseXLSXToOrderConfig,
  diffOrderConfig,
  applyOrderConfigImport,
  getUOMThresholds,
  saveUOMThreshold,
} from '@/services/orderConfigService'
import type { ImportDiffRow, UOMThreshold } from '@/types/integrations'

const STATUS_COLOR: Record<ImportDiffRow['status'], string> = {
  new: 'text-green-700 bg-green-50',
  changed: 'text-sky bg-sky/10',
  removed: 'text-red-600 bg-red-50',
  unchanged: 'text-inky/50 bg-transparent',
}

export function OrderConfigImportPanel() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [diff, setDiff] = useState<ImportDiffRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [thresholds, setThresholds] = useState<UOMThreshold[] | null>(null)
  const [showThresholds, setShowThresholds] = useState(false)
  const [editThreshold, setEditThreshold] = useState<UOMThreshold | null>(null)

  async function handleFile(file: File) {
    setLoading(true)
    try {
      const rows = await parseXLSXToOrderConfig(file)
      const d = await diffOrderConfig(rows)
      setDiff(d)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to parse file')
    } finally {
      setLoading(false)
    }
  }

  async function handleApply() {
    if (!diff) return
    setLoading(true)
    try {
      const result = await applyOrderConfigImport(diff)
      toast.success(`Import complete — ${result.added} added, ${result.updated} updated, ${result.skipped} unchanged`)
      if (result.errors.length) toast.error(`${result.errors.length} error(s): ${result.errors[0]}`)
      setDiff(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setLoading(false)
    }
  }

  async function loadThresholds() {
    try {
      const t = await getUOMThresholds()
      setThresholds(t)
      setShowThresholds(true)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load thresholds')
    }
  }

  async function handleSaveThreshold(t: UOMThreshold) {
    try {
      await saveUOMThreshold(t)
      toast.success(`Threshold saved for ${t.uom}`)
      setEditThreshold(null)
      const updated = await getUOMThresholds()
      setThresholds(updated)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    }
  }

  const counts = diff
    ? { new: diff.filter((d) => d.status === 'new').length, changed: diff.filter((d) => d.status === 'changed').length, removed: diff.filter((d) => d.status === 'removed').length }
    : null

  return (
    <div className="flex flex-col gap-6">
      {/* Upload */}
      <div className="border border-inky/20 rounded p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="font-heading text-sm uppercase tracking-wider text-navy">Import from XLSX</h3>
          <Button size="sm" variant="ghost" onClick={loadThresholds} className="text-xs">
            UOM Thresholds
          </Button>
        </div>
        <p className="text-xs font-mono text-inky/70">
          Upload the shared Order Config spreadsheet. Required columns: <span className="font-bold">Product Name</span>, <span className="font-bold">UOM</span>. Optional: SKU, Shop ID.
        </p>
        <div className="flex items-center gap-3">
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
          />
          <Button size="sm" onClick={() => fileRef.current?.click()} disabled={loading}>
            {loading ? 'Parsing…' : 'Choose File'}
          </Button>
          <span className="text-xs font-mono text-inky/50">.xlsx or .xls</span>
        </div>
      </div>

      {/* UOM Thresholds panel */}
      {showThresholds && thresholds && (
        <div className="border border-inky/20 rounded p-4 flex flex-col gap-3">
          <h4 className="font-heading text-xs uppercase tracking-wider text-navy">UOM Thresholds</h4>
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="border-b border-inky/20">
                <th className="text-left py-1 pr-4 text-inky/60 font-normal">UOM</th>
                <th className="text-right py-1 pr-4 text-inky/60 font-normal">Trigger Qty</th>
                <th className="text-right py-1 pr-4 text-inky/60 font-normal">Min Order</th>
                <th className="py-1 text-inky/60 font-normal">Label</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {thresholds.map((t) =>
                editThreshold?.uom === t.uom ? (
                  <ThresholdEditRow key={t.uom} threshold={t} onSave={handleSaveThreshold} onCancel={() => setEditThreshold(null)} />
                ) : (
                  <tr key={t.uom} className="border-b border-inky/10 hover:bg-inky/5">
                    <td className="py-1.5 pr-4 text-navy font-bold">{t.uom}</td>
                    <td className="py-1.5 pr-4 text-right">{t.trigger_qty}</td>
                    <td className="py-1.5 pr-4 text-right">{t.min_order_qty}</td>
                    <td className="py-1.5 text-inky/60">{t.display_label ?? '—'}</td>
                    <td className="py-1.5 pl-2">
                      <button onClick={() => setEditThreshold(t)} className="text-sky text-[10px] hover:underline">edit</button>
                    </td>
                  </tr>
                )
              )}
              {thresholds.length === 0 && (
                <tr><td colSpan={5} className="py-3 text-center text-inky/40">No thresholds configured</td></tr>
              )}
            </tbody>
          </table>
          <Button size="sm" variant="ghost" onClick={() => setEditThreshold({ uom: '', trigger_qty: 0, min_order_qty: 0, display_label: null })}>
            + Add UOM
          </Button>
          {editThreshold && !editThreshold.updated_at && (
            <ThresholdEditRow threshold={editThreshold} onSave={handleSaveThreshold} onCancel={() => setEditThreshold(null)} />
          )}
        </div>
      )}

      {/* Diff preview */}
      {diff && counts && (
        <div className="border border-inky/20 rounded p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex gap-3">
              <span className="text-xs font-mono text-green-700">+{counts.new} new</span>
              <span className="text-xs font-mono text-sky">~{counts.changed} changed</span>
              <span className="text-xs font-mono text-red-600">-{counts.removed} removed</span>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setDiff(null)}>Cancel</Button>
              <Button size="sm" onClick={handleApply} disabled={loading}>
                {loading ? 'Applying…' : 'Apply Import'}
              </Button>
            </div>
          </div>
          <div className="max-h-72 overflow-y-auto">
            <table className="w-full text-xs font-mono">
              <thead className="sticky top-0 bg-cream">
                <tr className="border-b border-inky/20">
                  <th className="text-left py-1 pr-3 text-inky/60 font-normal">Status</th>
                  <th className="text-left py-1 pr-3 text-inky/60 font-normal">Product</th>
                  <th className="text-left py-1 pr-3 text-inky/60 font-normal">UOM</th>
                  <th className="text-left py-1 text-inky/60 font-normal">Shops</th>
                </tr>
              </thead>
              <tbody>
                {diff.filter((d) => d.status !== 'unchanged').map((d, i) => (
                  <tr key={i} className="border-b border-inky/10">
                    <td className="py-1 pr-3">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase ${STATUS_COLOR[d.status]}`}>{d.status}</span>
                    </td>
                    <td className="py-1 pr-3 text-navy">{d.row.product_name}</td>
                    <td className="py-1 pr-3">{d.row.uom}</td>
                    <td className="py-1 text-inky/60">{d.row.shop_ids.join(', ') || '—'}</td>
                  </tr>
                ))}
                {diff.filter((d) => d.status !== 'unchanged').length === 0 && (
                  <tr><td colSpan={4} className="py-3 text-center text-inky/40">No changes detected</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function ThresholdEditRow({
  threshold,
  onSave,
  onCancel,
}: {
  threshold: UOMThreshold
  onSave: (t: UOMThreshold) => void
  onCancel: () => void
}) {
  const [form, setForm] = useState(threshold)
  return (
    <tr className="border-b border-inky/10 bg-sky/5">
      <td className="py-1 pr-4">
        <input
          className="w-16 border border-inky/30 rounded px-1.5 py-0.5 text-xs font-mono bg-cream text-navy"
          value={form.uom}
          onChange={(e) => setForm({ ...form, uom: e.target.value.toLowerCase() })}
          placeholder="uom"
        />
      </td>
      <td className="py-1 pr-4">
        <input
          type="number"
          className="w-16 border border-inky/30 rounded px-1.5 py-0.5 text-xs font-mono bg-cream text-navy text-right"
          value={form.trigger_qty}
          onChange={(e) => setForm({ ...form, trigger_qty: Number(e.target.value) })}
        />
      </td>
      <td className="py-1 pr-4">
        <input
          type="number"
          className="w-16 border border-inky/30 rounded px-1.5 py-0.5 text-xs font-mono bg-cream text-navy text-right"
          value={form.min_order_qty}
          onChange={(e) => setForm({ ...form, min_order_qty: Number(e.target.value) })}
        />
      </td>
      <td className="py-1">
        <input
          className="w-24 border border-inky/30 rounded px-1.5 py-0.5 text-xs font-mono bg-cream text-navy"
          value={form.display_label ?? ''}
          onChange={(e) => setForm({ ...form, display_label: e.target.value || null })}
          placeholder="label"
        />
      </td>
      <td className="py-1 pl-2 flex gap-2">
        <button onClick={() => onSave(form)} className="text-green-700 text-[10px] hover:underline">save</button>
        <button onClick={onCancel} className="text-inky/40 text-[10px] hover:underline">cancel</button>
      </td>
    </tr>
  )
}
