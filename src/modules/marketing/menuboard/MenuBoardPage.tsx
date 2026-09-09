import { useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { Button, Card, CardBody, Combobox, Input, Select, Tabs, TabsList, TabsTrigger, TabsContent, Toggle, SbLoader } from '@/components/ui'
import { useLocations } from '@/hooks/useLocations'
import { useMenuBoardPackages, useMenuBoardQuartPricing, type MenuBoardPackage } from './useMenuBoard'
import type { Location } from '@/types'

const LAST_LOCATION_KEY = 'menu-board:last-location'
const money = (v: number | null | undefined) => (v == null ? null : Number(v))
const fmtPrice = (v: number | null) => (v == null ? '—' : v.toFixed(2))

/**
 * Menu Board — an on-screen recreation of the printed lobby/bay board,
 * priced live per shop. Package prices come straight from core.locations
 * (economy/premium_hm/premium_full_synthetic/premium_full_synthetic_hm/rp —
 * already synced from Monday.com, see the migration's own comment for how
 * that mapping was verified against a real board); price-per-extra-quart is
 * a company default with optional per-location overrides.
 */
export function MenuBoardPage() {
  const loc = useLocations()
  const { packages, loading: packagesLoading, update: updatePackage } = useMenuBoardPackages()
  const quartPricing = useMenuBoardQuartPricing()

  const [locationId, setLocationId] = useState(() => {
    try { return localStorage.getItem(LAST_LOCATION_KEY) ?? '' } catch { return '' }
  })
  useEffect(() => {
    try { if (locationId) localStorage.setItem(LAST_LOCATION_KEY, locationId) } catch { /* ignore */ }
  }, [locationId])

  // Combobox's own filter only matches substrings of `label` — folding
  // address/city/state into the label text (not just the shop number/city)
  // is what makes "search by name, address, or city" actually work.
  const shopOptions = useMemo(() => loc.locations.map((l) => {
    const addr = [l.address, l.city, l.state].filter(Boolean).join(', ')
    return { value: l.id, label: addr ? `${l.shop_city || l.name} — ${addr}` : (l.shop_city || l.name) }
  }), [loc.locations])
  const location = loc.byId(locationId || null)

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Menu Board</h1>
        <p className="text-xs text-inky mt-0.5">Live per-shop pricing board, pulled from each location's own configured prices.</p>
      </div>

      <Tabs defaultValue="board">
        <TabsList>
          <TabsTrigger value="board">Board</TabsTrigger>
          <TabsTrigger value="mapping">Package Mapping</TabsTrigger>
          <TabsTrigger value="quarts">Quart Pricing</TabsTrigger>
          <TabsTrigger value="custom">Custom Pricing ({quartPricing.overrides.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="board">
          <BoardTab
            shopOptions={shopOptions} locationId={locationId} onLocationChange={setLocationId} location={location}
            packages={packages} packagesLoading={packagesLoading} updatePackage={updatePackage}
            resolveQuart={quartPricing.resolve}
          />
        </TabsContent>

        <TabsContent value="mapping">
          <PackageMappingTab packages={packages} loading={packagesLoading} updatePackage={updatePackage} />
        </TabsContent>

        <TabsContent value="quarts">
          <QuartDefaultsTab packages={packages} quartPricing={quartPricing} />
        </TabsContent>

        <TabsContent value="custom">
          <CustomPricingTab packages={packages} quartPricing={quartPricing} loc={loc} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ── Board ────────────────────────────────────────────────────────────────

function BoardTab({ shopOptions, locationId, onLocationChange, location, packages, packagesLoading, updatePackage, resolveQuart }: {
  shopOptions: { value: string; label: string }[]
  locationId: string
  onLocationChange: (id: string) => void
  location: Location | undefined
  packages: MenuBoardPackage[]
  packagesLoading: boolean
  updatePackage: (id: string, patch: Partial<MenuBoardPackage>) => Promise<boolean>
  resolveQuart: (locationId: string, packageKey: string) => { pricePerQuart: number | null; includedQuarts: number | null; isCustom: boolean }
}) {
  const [editMode, setEditMode] = useState(false)
  const address = location ? [location.address, location.city, location.state, location.zip].filter(Boolean).join(', ') : ''
  const activePackages = useMemo(() => packages.filter((p) => p.active).sort((a, b) => a.sort_order - b.sort_order), [packages])

  return (
    <div className="flex flex-col gap-3">
      <Card><CardBody className="flex items-end gap-3 flex-wrap">
        <div className="w-72">
          <Combobox label="Shop" options={shopOptions} value={locationId} onChange={onLocationChange}
            placeholder="Search by name, address, or city…" />
        </div>
        <div className="ml-auto">
          <Toggle checked={editMode} onChange={setEditMode} color="cyan" size="sm" label="Edit layout" />
        </div>
      </CardBody></Card>

      {!locationId ? (
        <Card><CardBody><p className="text-xs font-mono text-inky/60 py-8 text-center">Search for a shop above to show its board.</p></CardBody></Card>
      ) : packagesLoading ? (
        <div className="py-16 flex justify-center"><SbLoader size={36} /></div>
      ) : (
        <Board
          location={location} packages={activePackages} editMode={editMode} updatePackage={updatePackage}
          resolveQuart={resolveQuart} address={address}
        />
      )}
    </div>
  )
}

/**
 * The board itself — a fixed-aspect card with each package's price/quart
 * text absolutely positioned by percentage (so it's independent of the
 * rendered size). Draggable in edit mode: pointer-drag updates position
 * live, committed to the database on release.
 */
function Board({ location, packages, editMode, updatePackage, resolveQuart, address }: {
  location: Location | undefined
  packages: MenuBoardPackage[]
  editMode: boolean
  updatePackage: (id: string, patch: Partial<MenuBoardPackage>) => Promise<boolean>
  resolveQuart: (locationId: string, packageKey: string) => { pricePerQuart: number | null; includedQuarts: number | null; isCustom: boolean }
  address: string
}) {
  const boardRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState<{ id: string; field: 'price' | 'quart' } | null>(null)

  function startDrag(e: React.PointerEvent, pkg: MenuBoardPackage, field: 'price' | 'quart') {
    if (!editMode) return
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    setDragging({ id: pkg.id, field })
  }

  function onMove(e: React.PointerEvent) {
    if (!dragging || !boardRef.current) return
    const rect = boardRef.current.getBoundingClientRect()
    const x = Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100))
    const y = Math.min(100, Math.max(0, ((e.clientY - rect.top) / rect.height) * 100))
    const key = dragging.field === 'price' ? { price_pos_x: x, price_pos_y: y } : { quart_pos_x: x, quart_pos_y: y }
    updatePackage(dragging.id, key)
  }

  function endDrag() { setDragging(null) }

  return (
    <Card>
      <CardBody>
        <div
          ref={boardRef}
          onPointerMove={onMove}
          onPointerUp={endDrag}
          className="relative w-full rounded-lg border-2 border-sb-navy bg-sb-navy text-sb-cream overflow-hidden select-none"
          style={{ aspectRatio: '9 / 16', maxWidth: 480, margin: '0 auto' }}
        >
          <div className="absolute top-3 left-0 right-0 text-center">
            <span className="font-heading text-xl tracking-widest uppercase">Strickland Brothers</span>
          </div>
          {packages.map((p) => {
            const priceCol = p.price_column
            const price = priceCol ? money((location as any)?.[priceCol]) : null
            const quart = resolveQuart(location?.id ?? '', p.package_key)
            return (
              <div key={p.id}>
                <div
                  onPointerDown={(e) => startDrag(e, p, 'price')}
                  className={`absolute flex flex-col items-center ${editMode ? 'cursor-move ring-1 ring-sb-sky/60 rounded px-1' : ''}`}
                  style={{ left: `${p.price_pos_x}%`, top: `${p.price_pos_y}%`, transform: 'translate(-50%, -50%)' }}
                >
                  <span className="font-heading uppercase tracking-wide text-[11px] text-sb-sky">{p.display_name}</span>
                  {p.qualifier && <span className="text-[9px] text-sb-cream/70 uppercase">{p.qualifier}</span>}
                  <span className="font-heading font-bold text-sb-cream" style={{ fontSize: p.price_font_size }}>
                    {price == null ? '—' : `$${fmtPrice(price)}`}
                  </span>
                  <span className="text-[9px] text-sb-cream/60 uppercase">Plus Tax</span>
                </div>
                <div
                  onPointerDown={(e) => startDrag(e, p, 'quart')}
                  className={`absolute text-center whitespace-nowrap text-sb-cream ${editMode ? 'cursor-move ring-1 ring-sb-sky/60 rounded px-1' : ''}`}
                  style={{ left: `${p.quart_pos_x}%`, top: `${p.quart_pos_y}%`, transform: 'translate(-50%, -50%)', fontSize: p.quart_font_size }}
                >
                  {quart.pricePerQuart == null ? '—' : `$${fmtPrice(quart.pricePerQuart)} per extra quart`}
                  {quart.isCustom && <span className="ml-1 text-sb-orange">*</span>}
                </div>
              </div>
            )
          })}
          <div className="absolute bottom-2 left-0 right-0 text-center px-3">
            <span className="text-[10px] font-mono text-sb-cream/70">{address || (location ? '' : 'Select a shop above')}</span>
          </div>
        </div>
        {editMode && (
          <p className="text-[11px] font-mono text-inky/60 mt-2 text-center">
            Drag a price or per-quart label to reposition it. Use Package Mapping to adjust font size.
          </p>
        )}
      </CardBody>
    </Card>
  )
}

// ── Package Mapping ─────────────────────────────────────────────────────

function PackageMappingTab({ packages, loading, updatePackage }: {
  packages: MenuBoardPackage[]
  loading: boolean
  updatePackage: (id: string, patch: Partial<MenuBoardPackage>) => Promise<boolean>
}) {
  if (loading) return <div className="py-12 flex justify-center"><SbLoader size={32} /></div>
  return (
    <Card><CardBody className="flex flex-col gap-2">
      <p className="text-[11px] font-mono text-inky/60">
        Which core.locations column feeds each package's price, whether it shows on the board, and its price text's
        font size. A package with no column mapped yet (e.g. a new package before pricing is set up) can't go active.
      </p>
      <div className="overflow-auto rounded border border-navy/30">
        <table className="w-full text-xs font-mono">
          <thead><tr className="bg-cream text-inky uppercase tracking-wide border-b border-navy/30">
            <th className="px-3 py-2 text-left">Package</th>
            <th className="px-3 py-2 text-left">Source Column</th>
            <th className="px-3 py-2 text-right">Price Font Size</th>
            <th className="px-3 py-2 text-right">Quart Font Size</th>
            <th className="px-3 py-2 text-center">Active</th>
          </tr></thead>
          <tbody>
            {packages.map((p) => (
              <tr key={p.id} className="border-b border-navy/15">
                <td className="px-3 py-1.5 text-navy">{p.display_name}</td>
                <td className="px-3 py-1.5">
                  <input defaultValue={p.price_column ?? ''} placeholder="e.g. rp"
                    onBlur={(e) => { const v = e.target.value.trim() || null; if (v !== p.price_column) updatePackage(p.id, { price_column: v }) }}
                    className="bg-cream border border-navy/30 rounded px-2 py-1 text-xs font-mono text-navy w-40" />
                </td>
                <td className="px-3 py-1.5 text-right">
                  <input type="number" defaultValue={p.price_font_size}
                    onBlur={(e) => { const v = Number(e.target.value) || p.price_font_size; if (v !== p.price_font_size) updatePackage(p.id, { price_font_size: v }) }}
                    className="bg-cream border border-navy/30 rounded px-2 py-1 text-xs font-mono text-navy w-16 text-right" />
                </td>
                <td className="px-3 py-1.5 text-right">
                  <input type="number" defaultValue={p.quart_font_size}
                    onBlur={(e) => { const v = Number(e.target.value) || p.quart_font_size; if (v !== p.quart_font_size) updatePackage(p.id, { quart_font_size: v }) }}
                    className="bg-cream border border-navy/30 rounded px-2 py-1 text-xs font-mono text-navy w-16 text-right" />
                </td>
                <td className="px-3 py-1.5 text-center">
                  <Toggle checked={p.active} color="green" size="sm" onChange={(v) => {
                    // Toggle.tsx has no disabled prop — guarded here instead:
                    // a package with no source column mapped yet can't go
                    // active, it would just show "—" on the board.
                    if (v && !p.price_column) { toast.error('Set a Source Column before activating this package'); return }
                    updatePackage(p.id, { active: v })
                  }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </CardBody></Card>
  )
}

// ── Quart Pricing (company defaults) ────────────────────────────────────

function QuartDefaultsTab({ packages, quartPricing }: {
  packages: MenuBoardPackage[]
  quartPricing: ReturnType<typeof useMenuBoardQuartPricing>
}) {
  const { defaults, loading, saveDefault } = quartPricing
  const [drafts, setDrafts] = useState<Record<string, { price: string; quarts: string }>>({})

  if (loading) return <div className="py-12 flex justify-center"><SbLoader size={32} /></div>

  function draftFor(packageKey: string) {
    if (drafts[packageKey]) return drafts[packageKey]
    const d = defaults.find((r) => r.package_key === packageKey)
    return { price: d?.price_per_quart?.toString() ?? '', quarts: d?.included_quarts?.toString() ?? '' }
  }

  async function save(packageKey: string) {
    const draft = draftFor(packageKey)
    const num = (v: string) => (v.trim() === '' ? null : Number(v))
    await saveDefault(packageKey, { price_per_quart: num(draft.price), included_quarts: num(draft.quarts) })
  }

  return (
    <Card><CardBody className="flex flex-col gap-2">
      <p className="text-[11px] font-mono text-inky/60">
        Company-wide default price per additional quart, and how many quarts are already included in the base
        price — per package. A shop can be set to something different under Custom Pricing.
      </p>
      <div className="overflow-auto rounded border border-navy/30">
        <table className="w-full text-xs font-mono">
          <thead><tr className="bg-cream text-inky uppercase tracking-wide border-b border-navy/30">
            <th className="px-3 py-2 text-left">Package</th>
            <th className="px-3 py-2 text-right">Price / Extra Quart</th>
            <th className="px-3 py-2 text-right">Included Quarts</th>
            <th className="px-3 py-2" />
          </tr></thead>
          <tbody>
            {packages.filter((p) => p.active).map((p) => {
              const draft = draftFor(p.package_key)
              return (
                <tr key={p.id} className="border-b border-navy/15">
                  <td className="px-3 py-1.5 text-navy">{p.display_name}</td>
                  <td className="px-3 py-1.5 text-right">
                    <input value={draft.price} placeholder="0.00"
                      onChange={(e) => setDrafts((d) => ({ ...d, [p.package_key]: { ...draftFor(p.package_key), price: e.target.value } }))}
                      className="bg-cream border border-navy/30 rounded px-2 py-1 text-xs font-mono text-navy w-24 text-right" />
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <input value={draft.quarts} placeholder="5"
                      onChange={(e) => setDrafts((d) => ({ ...d, [p.package_key]: { ...draftFor(p.package_key), quarts: e.target.value } }))}
                      className="bg-cream border border-navy/30 rounded px-2 py-1 text-xs font-mono text-navy w-16 text-right" />
                  </td>
                  <td className="px-3 py-1.5">
                    <Button size="sm" variant="secondary" onClick={() => save(p.package_key)}>Save</Button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </CardBody></Card>
  )
}

// ── Custom Pricing (per-location overrides) ─────────────────────────────

function CustomPricingTab({ packages, quartPricing, loc }: {
  packages: MenuBoardPackage[]
  quartPricing: ReturnType<typeof useMenuBoardQuartPricing>
  loc: ReturnType<typeof useLocations>
}) {
  const { overrides, loading, saveOverride, removeOverride } = quartPricing
  const [addOpen, setAddOpen] = useState(false)
  const [locationId, setLocationId] = useState('')
  const [packageKey, setPackageKey] = useState('')
  const [price, setPrice] = useState('')
  const [quarts, setQuarts] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  const shopOptions = useMemo(() => loc.locations.map((l) => ({ value: l.id, label: l.shop_city || l.name })), [loc.locations])
  const packageOptions = useMemo(() => packages.filter((p) => p.active).map((p) => ({ value: p.package_key, label: p.display_name })), [packages])
  const shopLabel = (id: string) => loc.locations.find((l) => l.id === id)?.shop_city || loc.locations.find((l) => l.id === id)?.name || id
  const packageLabel = (key: string) => packages.find((p) => p.package_key === key)?.display_name ?? key

  async function onAdd() {
    if (!locationId || !packageKey) return
    setSaving(true)
    const num = (v: string) => (v.trim() === '' ? null : Number(v))
    const ok = await saveOverride({ location_id: locationId, package_key: packageKey, price_per_quart: num(price), included_quarts: num(quarts), notes: notes.trim() || null })
    setSaving(false)
    if (ok) { setAddOpen(false); setLocationId(''); setPackageKey(''); setPrice(''); setQuarts(''); setNotes('') }
  }

  return (
    <Card><CardBody className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-mono text-inky/60">
          Shops set to a different price-per-extra-quart (or included-quarts count) than the company default.
        </p>
        <Button size="sm" onClick={() => setAddOpen((o) => !o)}>{addOpen ? 'Cancel' : '+ Add Custom Pricing'}</Button>
      </div>

      {addOpen && (
        <div className="rounded border border-navy/20 p-3 grid grid-cols-1 md:grid-cols-5 gap-2 items-end">
          <Combobox label="Shop" options={shopOptions} value={locationId} onChange={setLocationId} placeholder="Select shop…" />
          <Select label="Package" value={packageKey} onChange={(e) => setPackageKey(e.target.value)}
            options={[{ value: '', label: 'Select…' }, ...packageOptions]} />
          <Input label="Price / Extra Quart" type="number" step={0.01} value={price} onChange={(e) => setPrice(e.target.value)} />
          <Input label="Included Quarts" type="number" value={quarts} onChange={(e) => setQuarts(e.target.value)} />
          <Input label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <div className="md:col-span-5 flex justify-end">
            <Button size="sm" loading={saving} disabled={!locationId || !packageKey} onClick={onAdd}>Save</Button>
          </div>
        </div>
      )}

      {loading ? <div className="py-8 flex justify-center"><SbLoader size={32} /></div>
        : overrides.length === 0 ? <p className="text-xs font-mono text-inky/60 py-4">No custom pricing set — every shop uses the company defaults.</p>
        : (
          <div className="overflow-auto rounded border border-navy/30">
            <table className="w-full text-xs font-mono">
              <thead><tr className="bg-cream text-inky uppercase tracking-wide border-b border-navy/30">
                <th className="px-3 py-2 text-left">Shop</th>
                <th className="px-3 py-2 text-left">Package</th>
                <th className="px-3 py-2 text-right">Price / Extra Quart</th>
                <th className="px-3 py-2 text-right">Included Quarts</th>
                <th className="px-3 py-2 text-left">Notes</th>
                <th className="px-3 py-2" />
              </tr></thead>
              <tbody>
                {overrides.map((r) => (
                  <tr key={r.id} className="border-b border-navy/15">
                    <td className="px-3 py-1.5 text-navy">{shopLabel(r.location_id)}</td>
                    <td className="px-3 py-1.5 text-navy">{packageLabel(r.package_key)}</td>
                    <td className="px-3 py-1.5 text-right text-navy">{r.price_per_quart != null ? `$${fmtPrice(r.price_per_quart)}` : '—'}</td>
                    <td className="px-3 py-1.5 text-right text-navy">{r.included_quarts ?? '—'}</td>
                    <td className="px-3 py-1.5 text-inky/70">{r.notes || '—'}</td>
                    <td className="px-3 py-1.5">
                      <button onClick={() => removeOverride(r.id)} className="text-inky/40 hover:text-[#C0392B]" title="Remove custom pricing">×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </CardBody></Card>
  )
}
