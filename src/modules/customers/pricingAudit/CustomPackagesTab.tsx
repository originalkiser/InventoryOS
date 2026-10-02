// Custom Packages — direct ask 2026-10-02. Per-shop package layout: price,
// included quarts, price/quart, supply fee, oil inflation surcharge, and
// any "other casual items" the package includes — the system intended to
// replace Custom Shop Config's job going forward (see useCustomPackages.ts
// header comment; Custom Shop Config's own data/page are untouched).
import { useMemo, useState } from 'react'
import { Button, Card, CardBody, Combobox, Input, SbLoader } from '@/components/ui'
import { Trash2, Plus, X } from 'lucide-react'
import { useLocations } from '@/hooks/useLocations'
import { byNaturalLabel, naturalCompare } from '@/lib/naturalSort'
import { useCustomShopConfigPackageOptions } from '@/modules/locations/useCustomShopConfig'
import { useCustomPackages, type CustomPackage } from './useCustomPackages'

const numInputCls = 'w-full bg-cream border border-navy/30 rounded px-2 py-1 text-xs font-mono text-navy focus:outline-none focus:border-sky'

export function CustomPackagesTab() {
  const loc = useLocations()
  const cfg = useCustomPackages()
  const packageOptions = useCustomShopConfigPackageOptions()
  const [pickerId, setPickerId] = useState('')
  const [selectedShopId, setSelectedShopId] = useState<string | null>(null)
  const [cloneFromId, setCloneFromId] = useState('')

  const shopOptions = useMemo(() => loc.locations.map((l) => {
    const addr = [l.address, l.city, l.state].filter(Boolean).join(', ')
    return { value: l.id, label: addr ? `${l.shop_city || l.name} — ${addr}` : (l.shop_city || l.name) }
  }).sort(byNaturalLabel), [loc.locations])

  const shopsWithPackages = useMemo(
    () => cfg.locationIdsWithPackages.sort((a, b) => naturalCompare(loc.labelOf(a), loc.labelOf(b))),
    [cfg.locationIdsWithPackages, loc],
  )
  const otherShopsWithPackages = useMemo(
    () => shopsWithPackages.filter((id) => id !== selectedShopId).map((id) => ({ value: id, label: loc.labelOf(id) })),
    [shopsWithPackages, selectedShopId, loc],
  )

  const selectedPackages = selectedShopId ? cfg.packagesFor(selectedShopId) : []

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-sm font-bold text-navy tracking-wide uppercase">Custom Packages</h2>
        <p className="text-xs text-inky mt-0.5">
          Per-shop package layout — price, included quarts, price/quart, fees, and any casual items. Useful for
          tracking the special arrangements that come up as shops are acquired (more included quarts, renamed/
          relabeled packages, etc.).
        </p>
      </div>

      <Card><CardBody className="flex items-end gap-3 flex-wrap">
        <div className="w-72">
          <Combobox label="Shop" options={shopOptions} value={pickerId} onChange={setPickerId} placeholder="Search by name, address, or city…" />
        </div>
        <Button size="sm" disabled={!pickerId} onClick={() => setSelectedShopId(pickerId)}>Open</Button>
      </CardBody></Card>

      {!cfg.loading && shopsWithPackages.length > 0 && (
        <Card><CardBody className="flex flex-col gap-2">
          <span className="text-xs font-mono text-navy uppercase tracking-wide">Shops with Custom Packages ({shopsWithPackages.length})</span>
          <div className="flex flex-wrap gap-1.5">
            {shopsWithPackages.map((id) => (
              <button key={id} onClick={() => { setSelectedShopId(id); setPickerId(id) }}
                className={`text-[11px] font-mono border rounded px-2 py-1 ${selectedShopId === id ? 'bg-navy text-cream border-navy' : 'text-navy border-navy/30 hover:border-navy'}`}>
                {loc.labelOf(id)} ({cfg.packagesFor(id).length})
              </button>
            ))}
          </div>
        </CardBody></Card>
      )}

      {cfg.loading ? (
        <div className="py-8 flex justify-center"><SbLoader size={28} /></div>
      ) : selectedShopId && (
        <Card><CardBody className="flex flex-col gap-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <span className="text-sm font-heading font-bold text-navy">{loc.labelOf(selectedShopId)}</span>
            <Button size="sm" variant="secondary" onClick={() => cfg.addPackage(selectedShopId, '')}>
              <Plus className="w-3.5 h-3.5 mr-1" /> Add Package
            </Button>
          </div>

          {selectedPackages.length === 0 && (
            <div className="flex items-end gap-2 flex-wrap border border-navy/15 rounded px-3 py-2">
              <span className="text-[11px] font-mono text-inky/60">No packages yet —</span>
              {otherShopsWithPackages.length > 0 && (
                <>
                  <div className="w-64">
                    <Combobox label="Matches other shop" options={otherShopsWithPackages} value={cloneFromId} onChange={setCloneFromId}
                      placeholder="Copy another shop's layout…" />
                  </div>
                  <Button size="sm" variant="secondary" disabled={!cloneFromId}
                    onClick={() => { cfg.cloneFromShop(cloneFromId, selectedShopId); setCloneFromId('') }}>
                    Copy
                  </Button>
                </>
              )}
            </div>
          )}

          {selectedPackages.map((pkg) => (
            <PackageCard key={pkg.id} pkg={pkg} cfg={cfg} packageOptions={packageOptions} />
          ))}
        </CardBody></Card>
      )}
    </div>
  )
}

function NumField({ label, value, onSave }: { label: string; value: number | null; onSave: (v: number | null) => void }) {
  const [text, setText] = useState(value != null ? String(value) : '')
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">{label}</span>
      <input
        type="text" inputMode="decimal" className={numInputCls} value={text}
        onChange={(e) => setText(e.target.value.replace(/[^0-9.]/g, ''))}
        onBlur={() => onSave(text.trim() === '' ? null : Number(text))}
      />
    </label>
  )
}

function PackageCard({ pkg, cfg, packageOptions }: {
  pkg: CustomPackage
  cfg: ReturnType<typeof useCustomPackages>
  packageOptions: { package_key: string; display_name: string }[]
}) {
  const items = cfg.casualItemsFor(pkg.id)
  const [newItemName, setNewItemName] = useState('')

  return (
    <div className="border border-navy/20 rounded p-3 flex flex-col gap-2.5">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="flex items-end gap-2 flex-wrap flex-1 min-w-[260px]">
          <div className="w-56">
            <Combobox label="Package Name" allowCreate
              options={packageOptions.map((p) => ({ value: p.display_name, label: p.display_name }))}
              value={pkg.package_name} onChange={(v) => cfg.savePackage(pkg.id, { package_name: v })}
              onCreateOption={(label) => ({ value: label, label })} />
          </div>
          <div className="w-56">
            <Input label="Internal Package Name" placeholder="What this is for…" defaultValue={pkg.internal_package_name ?? ''}
              onBlur={(e) => cfg.savePackage(pkg.id, { internal_package_name: e.target.value.trim() || null })} />
          </div>
        </div>
        <button onClick={() => cfg.deletePackage(pkg.id)} className="text-inky/40 hover:text-[#C0392B]" title="Remove this package">
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <NumField label="Price" value={pkg.price} onSave={(v) => cfg.savePackage(pkg.id, { price: v })} />
        <NumField label="Included Quarts" value={pkg.included_quarts} onSave={(v) => cfg.savePackage(pkg.id, { included_quarts: v })} />
        <NumField label="Price / Quart" value={pkg.price_per_quart} onSave={(v) => cfg.savePackage(pkg.id, { price_per_quart: v })} />
        <NumField label="Supply Fee" value={pkg.supply_fee} onSave={(v) => cfg.savePackage(pkg.id, { supply_fee: v })} />
        <NumField label="Oil Inflation Surcharge" value={pkg.oil_inflation_surcharge} onSave={(v) => cfg.savePackage(pkg.id, { oil_inflation_surcharge: v })} />
      </div>

      <div className="flex flex-col gap-1 border-t border-navy/10 pt-2">
        <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Other Casual Items</span>
        {items.map((item) => (
          <div key={item.id} className="flex items-center gap-2">
            <input className={`${numInputCls} flex-1`} defaultValue={item.item_name}
              onBlur={(e) => cfg.saveCasualItem(item.id, { item_name: e.target.value })} placeholder="Item name" />
            <input className={`${numInputCls} w-24`} type="text" inputMode="decimal" defaultValue={item.price != null ? String(item.price) : ''}
              onBlur={(e) => cfg.saveCasualItem(item.id, { price: e.target.value.trim() === '' ? null : Number(e.target.value) })} placeholder="Price" />
            <button onClick={() => cfg.deleteCasualItem(item.id)} className="text-inky/40 hover:text-[#C0392B]"><X className="w-3.5 h-3.5" /></button>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <input className={`${numInputCls} flex-1`} value={newItemName} onChange={(e) => setNewItemName(e.target.value)}
            placeholder="Add a casual item…"
            onKeyDown={(e) => { if (e.key === 'Enter' && newItemName.trim()) { cfg.addCasualItem(pkg.id, newItemName.trim()); setNewItemName('') } }} />
          <Button size="sm" variant="secondary" disabled={!newItemName.trim()}
            onClick={() => { cfg.addCasualItem(pkg.id, newItemName.trim()); setNewItemName('') }}>
            Add
          </Button>
        </div>
      </div>
    </div>
  )
}
