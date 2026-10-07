// Public, no-login Tank Calculator for one shop (reached through that shop's share link, /tanks/:slug). Shops save each
// tank's shape and dimensions once (then locked/greyed until Edit is clicked) and from then on only type the filled depth.
// Logging a count compares it with the tank monitor, shows the variance and asks the shop to confirm anything unexpected.
// All data goes through SECURITY DEFINER RPCs keyed by the slug (migration 20261004b).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import * as RGL from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import { GripVertical, LayoutGrid, Pencil, Plus, RotateCcw } from 'lucide-react'
import toast from 'react-hot-toast'
import { supabase } from '@/lib/supabase'
import { Button, HoverTip, Modal, SbLoader } from '@/components/ui'
import { sanitizeDecimalInput } from '@/lib/decimalInput'
import { MEASURE_HEIGHT_HELP, SHAPES, SHAPE_ORDER, depthKey, dimsComplete, tankQuarts, type TankDims, type TankShape } from './tankMath'
import { TankShapeSvg } from './TankShapeSvg'
import { AREAS, HOLD_REASON_LABEL, type ShareShop, type ShopTank, type TankArea, type TankEval, type TankGrid } from './tankTypes'

/** Default for the company setting (Tank Calculator Links → Settings): a count more than this many quarts from the tank monitor is "off". */
const DEFAULT_VARIANCE_ALLOWANCE_QTS = 100

// Free-form tank grid — the same react-grid-layout setup Location Lookup uses (see the interop note there: `import * as RGL`
// doesn't give the real class under Vite, it's stashed at `.default`).
const ReactGridLayout = RGL.WidthProvider((RGL as unknown as { default: typeof RGL }).default)
const GRID_COLS = 12
const GRID_ROW_HEIGHT = 28
const GRID_MARGIN: [number, number] = [10, 10]
const DEFAULT_W = 3 // four to a row until the shop rearranges them
const DEFAULT_H = 13 // a set-up tank's card; one still waiting for its type/dimensions is shorter (below)
const DEFAULT_H_SETUP = 8
const MIN_W = 2
const MIN_H = 6

/** Saved positions where there are some; tanks not placed yet go four-wide underneath whatever's already there. */
function layoutFor(list: ShopTank[]): RGL.Layout[] {
  const placed = list.filter((t) => t.grid)
  let bottom = 0
  for (const t of placed) bottom = Math.max(bottom, t.grid!.y + t.grid!.h)
  let n = 0
  return list.map((t) => {
    const g = t.grid
    if (g) return { i: t.id, x: g.x, y: g.y, w: g.w, h: g.h, minW: MIN_W, minH: MIN_H }
    const i = n++
    const ready = !!t.shape && dimsComplete(t.shape, t.dims)
    return { i: t.id, x: (i % 4) * DEFAULT_W, y: bottom + Math.floor(i / 4) * DEFAULT_H, w: DEFAULT_W, h: ready ? DEFAULT_H : DEFAULT_H_SETUP, minW: MIN_W, minH: MIN_H }
  })
}
const gridKey = (g: TankGrid | null) => (g ? `${g.x},${g.y},${g.w},${g.h}` : '')
function useIsNarrow() {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 639px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 639px)')
    const on = () => setNarrow(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return narrow
}

const sb = () => supabase as any
const fmt = (v: number | null | undefined, d = 1) => (v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: d }))
const fmtDims = (t: { shape: TankShape | null; dims: TankDims }) => (t.shape ? SHAPES[t.shape]?.dims.map((d) => fmt(t.dims[d.key], 1)).join(' × ') + ' in' : '')
const ORANGE = 'border-[#E67E22] bg-[#E67E22]/10'

function ago(iso: string | null): string {
  if (!iso) return ''
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  if (mins < 60) return `${mins} min ago`
  if (mins < 48 * 60) return `${Math.round(mins / 60)} hr ago`
  return `${Math.round(mins / 1440)} days ago`
}

// Add to Home Screen has to reopen THIS shop's tank page, not the site root — same trick as the Menu Board pages.
function useHomeScreenManifest(title: string) {
  useEffect(() => {
    const origin = window.location.origin
    const path = window.location.pathname
    const manifest = {
      name: title, short_name: 'Tank Calculator', id: path, start_url: origin + path, scope: origin + '/',
      display: 'standalone', theme_color: '#002745', background_color: '#002745',
      icons: [
        { src: origin + '/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
        { src: origin + '/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
      ],
    }
    let link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')
    const previous = link?.href ?? null
    if (!link) { link = document.createElement('link'); link.rel = 'manifest'; document.head.appendChild(link) }
    link.href = 'data:application/manifest+json,' + encodeURIComponent(JSON.stringify(manifest))
    const setMeta = (name: string, content: string) => {
      let m = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)
      if (!m) { m = document.createElement('meta'); m.name = name; document.head.appendChild(m) }
      m.content = content
    }
    setMeta('apple-mobile-web-app-capable', 'yes')
    setMeta('mobile-web-app-capable', 'yes')
    setMeta('apple-mobile-web-app-title', 'Tank Calculator')
    return () => { if (previous && link) link.href = previous }
  }, [title])
}

/** The shop's own label for a tank. (Tanks pre-loaded from a monitor used to store the monitor's product text here — that isn't a label.) */
const shopLabelOf = (t: ShopTank): string | null => {
  const l = (t.product_label ?? '').trim()
  if (!l) return null
  const mon = (t.monitor?.product_id ?? t.monitor_product ?? '').trim().toLowerCase()
  return mon && l.toLowerCase() === mon ? null : l
}

const isAlarm = (a: string | null | undefined) => !!a && !/^(ok|normal|none|clear)$/i.test(a.trim())

/** "Monitor: 33.2 in · 666 qts (5 hr ago)" — what the tank monitor itself says, inches first. */
function monitorLine(tank: ShopTank, preview?: TankEval | null): string | null {
  const m = tank.monitor
  const qts = preview?.monitor_qts ?? (m?.on_hand_gal != null ? m.on_hand_gal * 4 : null)
  const readAt = preview?.monitor_read_at ?? m?.read_at ?? null
  if (m?.level_in == null && qts == null) return null
  return `Monitor: ${m?.level_in != null ? `${fmt(m.level_in, 1)} in` : ''}${m?.level_in != null && qts != null ? ' · ' : ''}${qts != null ? `${fmt(qts, 1)} qts` : ''}${readAt ? ` (${ago(readAt)})` : ''}`
}

/** Card top: our internal product id (or the tank's own name) with the serial across from it, then alarm / low-battery call-outs. */
function CardHeader({ tank, editingLayout, onEdit }: { tank: ShopTank; editingLayout: boolean; onEdit: () => void }) {
  const m = tank.monitor
  const serial = tank.monitor_serial ?? m?.serial ?? null
  const alarm = m && isAlarm(m.alarm) ? m.alarm : null
  const lowBattery = m?.battery_pct != null && m.battery_pct < 25
  // The monitor's own product text appears once, under the id it maps to — never repeated elsewhere on the card.
  const monitorText = tank.internal_product ? (m?.product_id ?? tank.monitor_product) : null
  const label = shopLabelOf(tank)
  return (
    <div className="flex flex-col gap-0.5 flex-shrink-0">
      <div className="flex items-start justify-between gap-1.5">
        <div className="flex items-start gap-1 min-w-0">
          {editingLayout && <span title="Drag to move" className="tank-drag-handle mt-0.5 p-0.5 text-navy/60 hover:text-navy cursor-grab touch-none"><GripVertical className="w-4 h-4" /></span>}
          <div className="text-sm font-heading font-bold text-navy truncate min-w-0" title={tank.internal_product ?? tank.name}>
            {tank.internal_product ? <><span className="font-normal text-navy/75">Product ID: </span>{tank.internal_product}</> : tank.name}
          </div>
        </div>
        <div className="flex flex-col items-end flex-shrink-0">
          <button type="button" onClick={onEdit} title="Dimensions & details" className="p-1 -m-0.5 rounded text-navy/75 hover:text-navy hover:bg-navy/10"><Pencil className="w-3.5 h-3.5" /></button>
          {serial && <span className="text-[10px] font-mono text-navy/75 leading-tight mt-0.5 whitespace-nowrap">S/N <strong className="text-navy">{serial}</strong></span>}
        </div>
      </div>
      {monitorText && <div className="text-[10px] font-mono text-navy/75 truncate" title={monitorText}>{monitorText}</div>}
      {label && <div className="text-[10px] font-mono text-navy/90 truncate" title={label}>“{label}”</div>}
      {alarm && <div className="text-[10px] font-mono font-bold text-[#C0392B] truncate" title={alarm}>Alarm: {alarm}</div>}
      {lowBattery && <div className="text-[10px] font-mono font-bold text-[#C0392B]">Battery low: {fmt(m!.battery_pct, 0)}%</div>}
    </div>
  )
}

// The monitor's identity and reading, for the setup window (the card itself shows these in its own layout).
function MonitorSummary({ tank }: { tank: ShopTank }) {
  const m = tank.monitor
  const serial = tank.monitor_serial ?? m?.serial ?? null
  const cap = m?.total_capacity_gal ?? (tank.monitor_capacity_qts ? tank.monitor_capacity_qts / 4 : null)
  const height = m?.height_in ?? tank.monitor_height_in
  const line = monitorLine(tank)
  return (
    <div className="text-[11px] font-mono text-navy/80 leading-snug flex flex-col gap-px">
      {serial && <div><span className="text-navy/60">S/N</span> <strong className="text-navy">{serial}</strong>{tank.internal_product ? <> · <span className="text-navy/60">Product ID</span> <strong className="text-navy">{tank.internal_product}</strong></> : null}</div>}
      {(m?.product_id ?? tank.monitor_product) && <div>Monitor product: {m?.product_id ?? tank.monitor_product}</div>}
      {line && <div>{line}</div>}
      {(cap != null || height) && <div>Monitor capacity {cap != null ? `${fmt(cap, 0)} gal` : '—'}{height ? ` · ${fmt(height, 0)} in tall` : ''}</div>}
      {m?.note && <div>Note: {m.note}</div>}
    </div>
  )
}

// ── Add / edit a tank ───────────────────────────────────────────────────────────────────────────────────────────

function TankModal({ open, onClose, slug, tank, defaultArea, onSaved, onDeleted }: {
  open: boolean; onClose: () => void; slug: string; tank: ShopTank | null; defaultArea: TankArea
  onSaved: () => void; onDeleted: () => void
}) {
  const isNew = !tank
  // A tank with a monitor is named by the monitor (its product text, plus the #serial tail when two tanks share a product) — not editable.
  const nameLocked = !!tank?.monitor
  const monitorName = tank ? (tank.source === 'monitor' ? tank.name : tank.monitor?.product_id ?? tank.name) : ''
  const [name, setName] = useState('')
  const [product, setProduct] = useState('')
  const [area, setArea] = useState<TankArea>(defaultArea)
  const [shape, setShape] = useState<TankShape | ''>('rectangle')
  const [dims, setDims] = useState<Record<string, string>>({})
  const [serial, setSerial] = useState('')
  const [unlocked, setUnlocked] = useState(true)
  const [saving, setSaving] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  // What the window opened with — anything that differs is outlined in orange and listed for confirmation on Save.
  const [init, setInit] = useState<{ name: string; label: string; area: TankArea; shape: TankShape | ''; serial: string; dims: Record<string, number> } | null>(null)

  useEffect(() => {
    if (!open) return
    setConfirmOpen(false)
    if (tank) {
      const nm = nameLocked ? monitorName : tank.name
      const dm = Object.fromEntries(Object.entries(tank.dims ?? {}).map(([k, v]) => [k, String(v)]))
      setName(nm); setProduct(shopLabelOf(tank) ?? ''); setArea(tank.area); setShape(tank.shape ?? ''); setSerial(tank.monitor_serial ?? '')
      setDims(dm)
      setUnlocked(!tank.shape || !dimsComplete(tank.shape, tank.dims)) // dimensions already set -> greyed out until Edit is clicked
      setInit({ name: tank.name, label: shopLabelOf(tank) ?? '', area: tank.area, shape: tank.shape ?? '', serial: tank.monitor_serial ?? '', dims: Object.fromEntries(Object.entries(tank.dims ?? {}).map(([k, v]) => [k, Number(v)])) })
    } else {
      setName(''); setProduct(''); setArea(defaultArea); setShape('rectangle'); setDims({}); setSerial(''); setUnlocked(true); setInit(null)
    }
  }, [open, tank, defaultArea]) // eslint-disable-line react-hooks/exhaustive-deps

  const numDims: TankDims = useMemo(() => Object.fromEntries(Object.entries(dims).map(([k, v]) => [k, Number(v)])), [dims])
  const complete = !!shape && dimsComplete(shape, numDims)
  const cap = complete && shape ? tankQuarts(shape, numDims, 1e9) : null
  const def = shape ? SHAPES[shape] : null
  // A tank pre-loaded from its monitor knows its capacity and inside height; picking a shape pre-fills that depth.
  function pickShape(s: TankShape | '') {
    setShape(s)
    if (s && tank?.monitor_height_in) {
      const k = depthKey(s)
      setDims((p) => (p[k] ? p : { ...p, [k]: String(tank.monitor_height_in) }))
    }
  }

  // Edits to an existing tank, field by field (a new tank has nothing to compare with).
  const changed = {
    name: !!init && (nameLocked ? monitorName : name.trim()) !== init.name,
    label: !!init && product.trim() !== init.label,
    area: !!init && area !== init.area,
    serial: !!init && serial.trim() !== init.serial,
    shape: !!init && shape !== init.shape,
  }
  const dimChanged = (k: string) => !!init && (Number(dims[k]) || 0) !== (init.dims[k] ?? 0)
  const changeList: { what: string; from: string; to: string }[] = []
  if (init) {
    const show = (v: string) => v || '(none)'
    if (changed.name) changeList.push({ what: 'Tank name', from: show(init.name), to: show(nameLocked ? monitorName : name.trim()) })
    if (changed.label) changeList.push({ what: 'Optional label', from: show(init.label), to: show(product.trim()) })
    if (changed.area) changeList.push({ what: 'Where is it?', from: AREAS.find((a) => a.key === init.area)?.label ?? init.area, to: AREAS.find((a) => a.key === area)?.label ?? area })
    if (changed.serial) changeList.push({ what: 'Tank monitor serial number', from: show(init.serial), to: show(serial.trim()) })
    if (changed.shape) changeList.push({ what: 'Tank type', from: init.shape ? SHAPES[init.shape]?.label ?? init.shape : '(not set up yet)', to: shape ? SHAPES[shape].label : '(none)' })
    for (const d of def?.dims ?? []) if (dimChanged(d.key)) changeList.push({ what: d.label, from: init.dims[d.key] != null ? fmt(init.dims[d.key], 2) : '(not set)', to: dims[d.key] ? fmt(Number(dims[d.key]), 2) : '(none)' })
  }
  const outline = (isChanged: boolean) => (isChanged ? 'border-[#E67E22] ring-2 ring-[#E67E22]/40' : '')

  /** Save tank: an edit to an existing tank first lists what changed and waits for the shop to confirm. */
  function requestSave() {
    if (!name.trim()) { toast.error('Give the tank a name'); return }
    if (!shape || !def) { toast.error('Choose the tank type'); return }
    if (!complete) { toast.error('Fill in every dimension'); return }
    if (init) {
      if (changeList.length === 0) { onClose(); return }
      setConfirmOpen(true)
      return
    }
    void save()
  }

  async function save() {
    if (!name.trim()) { toast.error('Give the tank a name'); return }
    if (!shape || !def) { toast.error('Choose the tank type'); return }
    if (!complete) { toast.error('Fill in every dimension'); return }
    setConfirmOpen(false)
    setSaving(true)
    const keep: Record<string, number> = {}
    for (const d of def.dims) keep[d.key] = Number(dims[d.key])
    const { error } = await sb().rpc('tank_share_upsert', {
      p_slug: slug,
      p_tank: { id: tank?.id ?? null, name: (nameLocked ? monitorName : name).trim(), product_label: product.trim() || null, area, shape, dims: keep, capacity_qts: cap?.capacityQuarts ?? null, monitor_serial: serial.trim() || null },
    })
    setSaving(false)
    if (error) { toast.error(error.message); return }
    toast.success(isNew ? 'Tank added' : 'Tank saved')
    onSaved(); onClose()
  }

  async function remove() {
    if (!tank || !window.confirm(`Remove "${tank.name}" from this shop? Its past counts stay on record.`)) return
    const { error } = await sb().rpc('tank_share_delete', { p_slug: slug, p_tank_id: tank.id })
    if (error) { toast.error(error.message); return }
    onDeleted(); onClose()
  }

  const dimsChanged = !!tank && !!tank.shape && !!def && (tank.shape !== shape || JSON.stringify(Object.fromEntries(def.dims.map((d) => [d.key, Number(dims[d.key])]))) !== JSON.stringify(Object.fromEntries(SHAPES[tank.shape].dims.map((d) => [d.key, Number(tank.dims[d.key])]))))
  const lockCls = unlocked ? '' : 'opacity-60 bg-navy/10 cursor-not-allowed'
  // 16px on a phone (anything smaller makes iOS zoom the page when a field is focused).
  const inputCls = 'w-full rounded border border-navy/30 bg-cream px-2.5 py-2 text-base sm:text-sm font-mono text-navy focus:outline-none focus:border-sky'

  return (
    <Modal open={open} onClose={onClose} title={isNew ? 'Add a tank' : `Tank — ${tank?.name}`} size="lg">
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="flex flex-col gap-0.5 text-[11px] font-mono text-navy/75">Tank name
            <input className={`${inputCls} ${nameLocked ? 'opacity-60 bg-navy/10 cursor-not-allowed ' : ''}${outline(changed.name)}`} value={nameLocked ? monitorName : name} disabled={nameLocked}
              onChange={(e) => setName(e.target.value)} placeholder="e.g. 5W-30 bulk" />
            {nameLocked && <span className="text-[10px] text-navy/60">Named by the tank monitor — it can't be changed here.</span>}
          </label>
          <label className="flex flex-col gap-0.5 text-[11px] font-mono text-navy/75">Optional Label
            <input className={`${inputCls} ${outline(changed.label)}`} value={product} onChange={(e) => setProduct(e.target.value)} placeholder="Your own name for this tank, if you want one" />
          </label>
          <label className="flex flex-col gap-0.5 text-[11px] font-mono text-navy/75">Where is it?
            <select className={`${inputCls} ${outline(changed.area)}`} value={area} onChange={(e) => setArea(e.target.value as TankArea)}>
              {AREAS.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-0.5 text-[11px] font-mono text-navy/75">Tank monitor serial number
            <input className={`${inputCls} ${outline(changed.serial)}`} value={serial} onChange={(e) => setSerial(e.target.value)} placeholder="Leave blank if there's no monitor" inputMode="numeric" />
          </label>
        </div>

        <div className="rounded border border-navy/25 p-3 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Shape &amp; dimensions</span>
            {!isNew && !unlocked && <Button size="sm" variant="secondary" onClick={() => setUnlocked(true)}><Pencil className="w-3.5 h-3.5 mr-1" />Edit dimensions</Button>}
            {!isNew && unlocked && complete && <span className="text-[10px] font-mono text-[#E67E22]">Editing — Save to lock them again</span>}
          </div>
          {tank?.monitor_serial && (
            <div className="rounded border border-navy/20 px-2 py-1.5 flex flex-col gap-1">
              <MonitorSummary tank={tank} />
              <p className="text-[10px] font-mono text-navy/60">Use the monitor as a check on what you measure.</p>
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-[140px_1fr] gap-3 items-start">
            {shape ? <TankShapeSvg shape={shape} fill={0.45} className="w-full max-w-[160px] text-navy" />
              : <div className={`w-full max-w-[160px] h-20 rounded border-2 border-dashed grid place-items-center text-2xl text-[#E67E22] ${ORANGE}`}>?</div>}
            <div className="flex flex-col gap-2">
              <label className="flex flex-col gap-0.5 text-[11px] font-mono text-navy/75">Tank type
                <select className={`${inputCls} ${!shape ? ORANGE : lockCls} ${outline(changed.shape)}`} disabled={!unlocked} value={shape} onChange={(e) => pickShape(e.target.value as TankShape | '')}>
                  {!shape && <option value="">Choose the tank type…</option>}
                  {(shape && !SHAPE_ORDER.includes(shape) ? [shape, ...SHAPE_ORDER] : SHAPE_ORDER).map((s) => <option key={s} value={s}>{SHAPES[s].label}</option>)}
                </select>
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {(def?.dims ?? []).map((d) => (
                  <label key={d.key} className="flex flex-col gap-0.5 text-[11px] font-mono text-navy/75">{d.label}
                    <input className={`${inputCls} ${unlocked && !dims[d.key] ? ORANGE : lockCls} ${outline(dimChanged(d.key))}`} disabled={!unlocked} inputMode="decimal" value={dims[d.key] ?? ''}
                      onChange={(e) => setDims((p) => ({ ...p, [d.key]: sanitizeDecimalInput(e.target.value) }))} />
                    {d.hint && <span className="text-[10px] text-navy/60">{d.hint}</span>}
                    {shape && d.key === depthKey(shape) && <span className="text-[10px] text-navy/75 leading-snug">{MEASURE_HEIGHT_HELP}</span>}
                  </label>
                ))}
              </div>
              {cap && <p className="text-xs font-mono text-navy">Holds about <strong>{fmt(cap.capacityQuarts / 4, 1)} gal</strong> ({fmt(cap.capacityQuarts, 0)} qts) when full — {fmt(cap.maxDepth, 1)} in deep inside.
                {tank?.monitor_capacity_qts && Math.abs(cap.capacityQuarts - tank.monitor_capacity_qts) / tank.monitor_capacity_qts > 0.1
                  ? <span className="text-[#E67E22]"> The tank monitor says {fmt(tank.monitor_capacity_qts / 4, 0)} gal — worth a second look at the measurements.</span> : null}</p>}
            </div>
          </div>
          {dimsChanged && unlocked && <p className="text-[11px] font-mono text-[#E67E22]">Changing the dimensions resets this tank's baseline variance.</p>}
        </div>

        <div className="flex items-center justify-between gap-2">
          {!isNew ? <button type="button" onClick={() => void remove()} className="text-xs font-mono text-[#C0392B] hover:underline">Remove tank</button> : <span />}
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button size="sm" loading={saving} onClick={requestSave}>Save tank</Button>
          </div>
        </div>
      </div>
      <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Keep these changes?" size="md">
        <div className="flex flex-col gap-3">
          <p className="text-sm font-body text-navy">You changed {changeList.length === 1 ? 'one thing' : `${changeList.length} things`} on this tank. Check them, then confirm you want to keep them.</p>
          <ul className="flex flex-col gap-1.5">
            {changeList.map((c) => (
              <li key={c.what} className="rounded border border-[#E67E22] ring-1 ring-[#E67E22]/30 px-2.5 py-1.5 text-xs font-mono text-navy">
                <div className="text-[10px] uppercase tracking-wide text-navy/60">{c.what}</div>
                <div><span className="text-navy/60 line-through">{c.from}</span> <span className="text-navy/60">→</span> <strong>{c.to}</strong></div>
              </li>
            ))}
          </ul>
          {dimsChanged && <p className="text-[11px] font-mono text-[#E67E22]">New dimensions reset this tank's baseline variance (you can undo that from the first count you log).</p>}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setConfirmOpen(false)}>Go back</Button>
            <Button size="sm" loading={saving} onClick={() => void save()}>Yes, keep these changes</Button>
          </div>
        </div>
      </Modal>
    </Modal>
  )
}

/** Hover callout on the tank drawing: what each color means. */
function TankLegend({ monitor, allowance }: { monitor: boolean; allowance: number }) {
  const Row = ({ swatch, title, text }: { swatch: React.ReactNode; title: string; text: string }) => (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 w-6 flex-shrink-0 flex justify-center">{swatch}</span>
      <div><div className="text-[11px] font-mono font-bold">{title}</div><div className="text-[10px] font-mono text-[#F2F1E6]/80 leading-snug">{text}</div></div>
    </div>
  )
  return (
    <div className="flex flex-col gap-2 w-60">
      <div className="text-[10px] font-mono uppercase tracking-wide text-[#B7E0DE]">What the drawing shows</div>
      <Row swatch={<span className="inline-block w-5 h-3 rounded-sm" style={{ background: '#B7E0DE' }} />} title="Light blue" text="The oil level — what you measured once you enter a depth (otherwise the last logged count)." />
      <Row swatch={<span className="inline-block w-5 border-t-2 border-dashed" style={{ borderColor: '#F2F1E6' }} />} title="Dashed line" text={monitor ? 'Where the tank monitor says the level is right now.' : 'Where the tank monitor says the level is — shown after you enter a depth.'} />
      <Row swatch={<span className="inline-block w-5 h-3 rounded-sm" style={{ background: '#C0392B' }} />} title="Red" text={`The gap between your measurement and the monitor, shown when they're more than ${fmt(allowance, 0)} qts apart.`} />
    </div>
  )
}

// ── One tank: depth in, quarts out, log the count ───────────────────────────────────────────────────────────────────

function TankCard({ tank, slug, onEdit, onChanged, editingLayout, allowance }: {
  tank: ShopTank; slug: string; onEdit: () => void; onChanged: () => void; editingLayout: boolean; allowance: number
}) {
  const [depthText, setDepthText] = useState('')
  const depth = Number(depthText)
  const ready = !!tank.shape && dimsComplete(tank.shape, tank.dims)
  const calc = useMemo(() => (ready && tank.shape && depth > 0 ? tankQuarts(tank.shape, tank.dims, depth) : null), [ready, depth, tank.shape, tank.dims])
  const maxDepth = useMemo(() => (ready && tank.shape ? tankQuarts(tank.shape, tank.dims, 1e9).maxDepth : 0), [ready, tank.shape, tank.dims])
  const over = depth > maxDepth
  const [preview, setPreview] = useState<TankEval | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [result, setResult] = useState<TankEval | null>(null)

  // Live comparison with the tank monitor as the depth is typed.
  const seq = useRef(0)
  useEffect(() => {
    setPreview(null)
    if (!tank.monitor_serial || !calc || over) return
    const mine = ++seq.current
    const t = window.setTimeout(async () => {
      const { data } = await sb().rpc('tank_share_preview', { p_slug: slug, p_tank_id: tank.id, p_depth: depth, p_volume_qts: calc.quarts })
      if (mine === seq.current && data && !data.error) setPreview(data as TankEval)
    }, 500)
    return () => window.clearTimeout(t)
  }, [depth, calc, over, tank.id, tank.monitor_serial, slug])

  async function log(confirmed: boolean) {
    if (!calc || over) return
    setBusy(true)
    const { data, error } = await sb().rpc('tank_share_log', { p_slug: slug, p_tank_id: tank.id, p_depth: depth, p_volume_qts: calc.quarts, p_confirmed: confirmed })
    setBusy(false)
    if (error) { toast.error(error.message); return }
    const r = data as TankEval
    if (r.error === 'confirmation_required') { setPreview(r); setConfirmOpen(true); return }
    setConfirmOpen(false)
    setResult(r); setDepthText('')
    onChanged()
  }

  async function undo() {
    if (!result?.log_id) return
    const { data, error } = await sb().rpc('tank_share_undo_baseline', { p_slug: slug, p_log_id: result.log_id })
    if (error || data?.error) { toast.error(error?.message ?? 'Nothing to undo'); return }
    toast.success('Baseline restored')
    setResult({ ...result, new_baseline: false }); onChanged()
  }

  const pctFull = calc ? Math.min(1, calc.quarts / Math.max(1, calc.capacityQuarts)) : tank.last_log && tank.capacity_qts ? Math.min(1, tank.last_log.volume_qts / tank.capacity_qts) : 0
  const v = preview?.online ? preview.variance_qts : null
  const overAllowance = v != null && Math.abs(v) > allowance
  // Where the monitor says the level is, as a share of this tank's inside depth — drawn once a depth has been entered.
  const m = tank.monitor
  const monitorFill = calc && !over
    ? (m?.level_in != null && maxDepth > 0 ? m.level_in / maxDepth : preview?.monitor_qts != null ? preview.monitor_qts / Math.max(1, calc.capacityQuarts) : null)
    : null
  const mLine = monitorLine(tank, calc && !over ? preview : null)

  return (
    <div className={`rounded-lg border p-2.5 flex flex-col gap-1.5 min-w-0 h-full overflow-y-auto ${ready ? 'border-navy/30 bg-cream' : 'border-[#E67E22] bg-[#E67E22]/10'} ${editingLayout ? 'ring-2 ring-sky' : ''}`}>
      <CardHeader tank={tank} editingLayout={editingLayout} onEdit={onEdit} />

      {!ready ? (
        <>
          <div className="flex-1 min-h-[2rem] grid place-items-center text-4xl text-[#E67E22] leading-none select-none">?</div>
          <div className="flex flex-col gap-0.5 flex-shrink-0">
            <div className="text-[11px] font-mono text-[#E67E22] leading-snug"><strong>Needs a tank type and dimensions.</strong></div>
            {mLine && <div className="text-[10px] font-mono text-navy/80 leading-snug">{mLine}</div>}
            {(m?.total_capacity_gal != null || tank.monitor_capacity_qts) && (
              <div className="text-[10px] font-mono text-navy/80 leading-snug">Monitor capacity {fmt(m?.total_capacity_gal ?? (tank.monitor_capacity_qts ?? 0) / 4, 0)} gal{(m?.height_in ?? tank.monitor_height_in) ? ` · ${fmt((m?.height_in ?? tank.monitor_height_in) as number, 0)} in tall` : ''}</div>
            )}
          </div>
          <Button size="sm" className="w-full flex-shrink-0" onClick={onEdit}>Set up this tank</Button>
        </>
      ) : (
        <>
          <HoverTip className="flex-1 min-h-[3.5rem] w-full items-center justify-center" placement="top" content={<TankLegend monitor={monitorFill != null} allowance={allowance} />}>
            <TankShapeSvg shape={tank.shape as TankShape} fill={pctFull} monitorFill={monitorFill} overAllowance={overAllowance} className="w-full h-full max-h-[15rem] text-navy" />
          </HoverTip>
          <div className="flex flex-col gap-0.5 flex-shrink-0">
            {calc && !over && (
              <div className="text-xs font-mono text-navy">
                <strong>{fmt(calc.quarts, 1)} qts</strong> <span className="text-navy/75">({fmt(calc.quarts / 4, 1)} gal · {fmt(pctFull * 100, 0)}%)</span>
              </div>
            )}
            {mLine && <div className="text-[10px] font-mono text-navy/80 leading-snug">{mLine}{calc && !over && preview?.sales_adjust_qts ? `, less ~${fmt(preview.sales_adjust_qts, 1)} sold since` : ''}</div>}
            {calc && !over && preview?.monitor_found && !preview.online && <div className="text-[10px] font-mono text-navy/75 leading-snug">The tank monitor hasn't reported lately, so there's nothing to compare with.</div>}
            {calc && !over && v != null && (
              <div className="text-[11px] font-mono text-navy leading-snug">
                Variance <strong className={overAllowance ? 'text-[#C0392B]' : 'text-navy'}>{`${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt(Math.abs(v), 1)} qts`}</strong>
                {overAllowance && <span className="text-[#C0392B]"> — over the {fmt(allowance, 0)} qt allowance</span>}
              </div>
            )}
            <div className="text-[10px] font-mono text-navy/75 leading-snug">
              {`${fmtDims(tank)} · ${fmt((tank.capacity_qts ?? 0) / 4, 0)} gal`}
              {tank.last_log && !calc && <div>Last: {fmt(tank.last_log.depth_in)} in · {fmt(tank.last_log.volume_qts, 0)} qts · {ago(tank.last_log.logged_at)}{tank.last_log.status === 'held' ? ' · held' : ''}</div>}
            </div>
            {result && (
              <div className={`rounded border px-2 py-1.5 mt-1 text-[11px] font-mono leading-snug ${result.status === 'held' ? 'border-[#E67E22]/60 bg-[#E67E22]/10' : 'border-[#2ECC71]/60 bg-[#2ECC71]/10'} text-navy`}>
                {result.status === 'held' ? (
                  <>Saved, but held for review before it's used for variance tracking: {(result.hold_reasons ?? []).map((r) => HOLD_REASON_LABEL[r] ?? r).join('; ')}.</>
                ) : (
                  <>Count logged.</>
                )}
                {result.new_baseline && (
                  <div className="mt-1">A new baseline variance of {fmt(result.variance_qts, 1)} qts has been set for this tank.
                    <button type="button" onClick={() => void undo()} className="ml-2 underline font-bold">Undo</button></div>
                )}
              </div>
            )}
          </div>

          {/* locked to the bottom of the card */}
          <div className="flex flex-col gap-1.5 flex-shrink-0 pt-1">
            <label className="flex flex-col gap-0.5 text-[10px] font-mono text-navy/75">Filled depth (inches)
              <input value={depthText} inputMode="decimal" onChange={(e) => { setDepthText(sanitizeDecimalInput(e.target.value)); setResult(null) }}
                className={`w-full rounded border px-2.5 py-2 text-base font-mono text-navy bg-cream focus:outline-none ${over ? 'border-[#C0392B]' : 'border-navy/40 focus:border-sky'}`} />
            </label>
            {over && <p className="text-[10px] font-mono text-[#C0392B]">That's deeper than the tank ({fmt(maxDepth, 1)} in).</p>}
            <Button size="sm" className="!py-2.5" disabled={!calc || over} loading={busy} onClick={() => void log(false)}>Log count</Button>
          </div>
        </>
      )}

      <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Is this measurement accurate?" size="sm">
        <div className="flex flex-col gap-3">
          <p className="text-sm font-body text-navy">
            Your measurement of <strong>{fmt(calc?.quarts, 1)} qts</strong> is {preview?.variance_qts == null ? 'different from' : `${fmt(Math.abs(preview.variance_qts), 1)} qts ${preview.variance_qts > 0 ? 'more' : 'less'} than`} what the tank monitor expects
            ({fmt(preview?.expected_qts, 1)} qts){preview?.baseline_variance_qts == null ? ', and this tank has no baseline yet' : `, and usually it's off by ${fmt(preview.baseline_variance_qts, 1)} qts`}.
          </p>
          <p className="text-sm font-body text-navy">If you're sure you measured correctly, confirm and this becomes the tank's new baseline variance.</p>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setConfirmOpen(false)}>Re-measure</Button>
            <Button size="sm" loading={busy} onClick={() => void log(true)}>Yes, it's accurate</Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

// One area's free-form grid: tanks can be any width and stacked any way. Drag by the handle, resize from the corner (layout
// editing only — locked otherwise so typing a depth never nudges a tile).
function AreaGrid({ list, slug, editing, narrow, allowance, onEdit, onChanged, onLayout }: {
  list: ShopTank[]; slug: string; editing: boolean; narrow: boolean; allowance: number
  onEdit: (t: ShopTank) => void; onChanged: () => void; onLayout: (l: RGL.Layout[]) => void
}) {
  if (narrow) {
    // A phone is too narrow for a 12-column grid: stack in the order the shop laid them out.
    const ordered = [...layoutFor(list)].sort((a, b) => a.y - b.y || a.x - b.x).map((l) => list.find((t) => t.id === l.i)!)
    return (
      <div className="grid grid-cols-1 min-[520px]:grid-cols-2 gap-2.5">
        {ordered.map((t) => <TankCard key={t.id} tank={t} slug={slug} editingLayout={false} allowance={allowance} onEdit={() => onEdit(t)} onChanged={onChanged} />)}
      </div>
    )
  }
  return (
    <ReactGridLayout className="layout" layout={layoutFor(list)} cols={GRID_COLS} rowHeight={GRID_ROW_HEIGHT} margin={GRID_MARGIN}
      isDraggable={editing} isResizable={editing} draggableHandle=".tank-drag-handle" compactType="vertical"
      onLayoutChange={(l) => { if (editing) onLayout(l) }}>
      {list.map((t) => (
        <div key={t.id} className="h-full">
          <TankCard tank={t} slug={slug} editingLayout={editing} allowance={allowance} onEdit={() => onEdit(t)} onChanged={onChanged} />
        </div>
      ))}
    </ReactGridLayout>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export function PublicTankPage() {
  const { slug = '' } = useParams<{ slug: string }>()
  const [status, setStatus] = useState<'loading' | 'ok' | 'notfound'>('loading')
  const [shop, setShop] = useState<ShareShop | null>(null)
  const [tanks, setTanks] = useState<ShopTank[]>([])
  const [allowance, setAllowance] = useState(DEFAULT_VARIANCE_ALLOWANCE_QTS)
  const [modal, setModal] = useState<{ tank: ShopTank | null; area: TankArea } | null>(null)
  useHomeScreenManifest(shop?.name ? `Tank Calculator — Shop ${shop.name}` : 'Tank Calculator')

  const load = useCallback(async () => {
    // Pre-load a tank for every tank monitor at this shop that isn't on the list yet (no-op once they all are).
    await sb().rpc('tank_share_sync_monitors', { p_slug: slug })
    const { data, error } = await sb().rpc('get_tank_share', { p_slug: slug })
    if (error || !data || data.error) { setStatus('notfound'); return }
    setShop(data.shop as ShareShop); setTanks((data.tanks ?? []) as ShopTank[]); setStatus('ok')
    const a = Number(data.settings?.variance_allowance_qts)
    setAllowance(Number.isFinite(a) && a > 0 ? a : DEFAULT_VARIANCE_ALLOWANCE_QTS)
  }, [slug])
  useEffect(() => { void load() }, [load])

  const [editingLayout, setEditingLayout] = useState(false)
  const narrow = useIsNarrow()
  const byArea = useMemo(() => {
    const m = new Map<TankArea, ShopTank[]>()
    for (const a of AREAS) m.set(a.key, tanks.filter((t) => t.area === a.key).sort((x, y) => x.sort_order - y.sort_order))
    return m
  }, [tanks])

  // Layout changes are saved a moment after the last drag/resize (a drag fires many), all in one call.
  const pending = useRef(new Map<string, TankGrid>())
  const saveTimer = useRef<number | undefined>(undefined)
  function onLayout(l: RGL.Layout[]) {
    const changed: { id: string; grid: TankGrid }[] = []
    for (const it of l) {
      const grid = { x: it.x, y: it.y, w: it.w, h: it.h }
      const cur = tanks.find((t) => t.id === it.i)
      if (cur && gridKey(cur.grid) !== gridKey(grid)) changed.push({ id: it.i, grid })
    }
    if (changed.length === 0) return
    const byId = new Map(changed.map((c) => [c.id, c.grid]))
    setTanks((prev) => prev.map((t) => (byId.has(t.id) ? { ...t, grid: byId.get(t.id)! } : t)))
    for (const c of changed) pending.current.set(c.id, c.grid)
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(async () => {
      const items = [...pending.current.entries()].map(([id, g]) => ({ id, ...g }))
      pending.current.clear()
      const { error } = await sb().rpc('tank_share_save_layout', { p_slug: slug, p_items: items })
      if (error) { toast.error("Couldn't save the layout: " + error.message); void load() }
    }, 600)
  }
  useEffect(() => () => window.clearTimeout(saveTimer.current), [])

  async function resetLayout() {
    if (!window.confirm('Put every tank back in the standard layout (four across)?')) return
    setTanks((prev) => prev.map((t) => ({ ...t, grid: null })))
    pending.current.clear()
    const { error } = await sb().rpc('tank_share_save_layout', { p_slug: slug, p_items: tanks.map((t) => ({ id: t.id })) })
    if (error) { toast.error(error.message); void load() }
  }

  if (status === 'loading') return <div className="min-h-screen bg-cream flex items-center justify-center"><SbLoader size={40} /></div>
  if (status === 'notfound') return (
    <div className="min-h-screen bg-cream flex items-center justify-center p-6 text-center">
      <div><h1 className="text-lg font-heading font-bold text-navy">Link not found</h1><p className="text-sm font-mono text-navy/75 mt-1">This tank link is no longer active. Ask your manager for a new one.</p></div>
    </div>
  )

  const address = [shop?.address, [shop?.city, shop?.state].filter(Boolean).join(', '), shop?.zip].filter(Boolean).join(' · ')
  return (
    <div className="min-h-screen bg-cream text-navy">
      {/* "Tank Calculator" and the shop stay at the top of the screen; the address scrolls away. (The sticky bar is a direct child of the page — inside a short header it would unstick as soon as the header scrolled off.) */}
      <div className="sticky top-0 z-30 bg-[#002745] text-[#F2F1E6] px-4 pt-3 pb-2">
        <div className="max-w-6xl mx-auto">
          <div className="text-[10px] font-mono uppercase tracking-widest text-[#B7E0DE]">Tank Calculator</div>
          <h1 className="text-lg font-heading font-bold">Shop {shop?.name}{shop?.shop_city ? ` — ${String(shop.shop_city).replace(/^\d+-/, '')}` : ''}</h1>
        </div>
      </div>
      {address && <div className="bg-[#002745] text-[#F2F1E6] px-4 pb-3"><div className="max-w-6xl mx-auto text-xs font-mono text-[#F2F1E6]/80">{address}</div></div>}
      <main className="max-w-6xl mx-auto p-3 sm:p-4 flex flex-col gap-6">
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-col gap-1 min-w-0">
            <p className="text-xs font-mono text-navy/75">Enter the filled depth for each tank, then tap Log count. This page does not update Droptop automatically, the count still needs to be completed in Droptop. The Inventory Team will use the logged counts to audit and adjust tank monitors for more accurate orders.</p>
            <p className="text-xs font-mono text-navy/75">Dimensions are saved — tap the pencil to change them.</p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {!narrow && tanks.length > 0 && (editingLayout
              ? <>
                  <Button size="sm" variant="ghost" onClick={() => void resetLayout()}><RotateCcw className="w-3.5 h-3.5 mr-1" />Reset layout</Button>
                  <Button size="sm" onClick={() => setEditingLayout(false)}>Done</Button>
                </>
              : <Button size="sm" variant="secondary" onClick={() => setEditingLayout(true)}><LayoutGrid className="w-3.5 h-3.5 mr-1" />Edit layout</Button>)}
            <Button size="sm" onClick={() => setModal({ tank: null, area: 'bay' })}><Plus className="w-3.5 h-3.5 mr-1" />Add tank</Button>
          </div>
        </div>
        {editingLayout && <p className="text-[11px] font-mono text-navy rounded border border-sky bg-sky/20 px-2.5 py-1.5">Layout editing is on — drag a tank by its <GripVertical className="w-3 h-3 inline -mt-0.5" /> handle to move it and drag a tank's bottom-right corner to resize it. Set up the tanks side by side, stacked, or any mix. Tap Done when it looks right (changes save automatically).</p>}
        {tanks.length === 0 && <p className="text-sm font-mono text-navy/75 py-8 text-center">No tanks yet. Tap "Add tank" to enter your first one.</p>}
        {AREAS.map((a) => {
          const list = byArea.get(a.key) ?? []
          if (list.length === 0) return null
          return (
            <section key={a.key} className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-heading font-bold uppercase tracking-widest text-navy">{a.label}</h2>
                <button type="button" onClick={() => setModal({ tank: null, area: a.key })} className="text-[11px] font-mono text-navy/75 hover:text-navy underline">+ add here</button>
              </div>
              <AreaGrid list={list} slug={slug} editing={editingLayout} narrow={narrow} allowance={allowance} onLayout={onLayout}
                onEdit={(t) => setModal({ tank: t, area: t.area })} onChanged={() => void load()} />
            </section>
          )
        })}
      </main>
      <TankModal open={!!modal} onClose={() => setModal(null)} slug={slug} tank={modal?.tank ?? null} defaultArea={modal?.area ?? 'bay'} onSaved={() => void load()} onDeleted={() => void load()} />
    </div>
  )
}
