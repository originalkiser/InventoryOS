import { useMemo, useState } from 'react'
import { Button, Card, CardBody, Combobox, Input, Select, SbLoader } from '@/components/ui'
import { useLocations } from '@/hooks/useLocations'
import {
  useCustomShopConfig, useMenuBoardPackageOptions, formatFieldValue, VALUE_KIND_LABELS,
  type FieldValueKind,
} from './useCustomShopConfig'
import { CustomShopConfigModal } from './CustomShopConfigModal'

/**
 * Company-wide view of Custom Shop Config: manage the admin-extensible
 * field types, then see/edit every shop that has a custom arrangement.
 * Same data + modal as the "Custom Config" box on Location Lookup — this
 * page is the "see all the custom shops" rollup of it.
 */
export function CustomShopConfigPage() {
  const loc = useLocations()
  const cfg = useCustomShopConfig()
  const packageOptions = useMenuBoardPackageOptions()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [pickerId, setPickerId] = useState('')

  // Fold address into the label so the picker can search by name, address, or city.
  const shopOptions = useMemo(() => loc.locations.map((l) => {
    const addr = [l.address, l.city, l.state].filter(Boolean).join(', ')
    return { value: l.id, label: addr ? `${l.shop_city || l.name} — ${addr}` : (l.shop_city || l.name) }
  }), [loc.locations])

  const activeFields = cfg.fields.filter((f) => f.active)
  const customIds = useMemo(() => [...cfg.customLocationIds].sort((a, b) => loc.labelOf(a).localeCompare(loc.labelOf(b))), [cfg.customLocationIds, loc])
  const packageLabel = (key: string) => packageOptions.find((p) => p.package_key === key)?.display_name ?? key

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Custom Shop Config</h1>
        <p className="text-xs text-inky mt-0.5">
          Per-shop exceptions that don't fit anywhere else — a custom price per quart, shop supply fee, oil inflation
          surcharge, and whatever else comes up, flagged to whichever Menu Board package(s) it applies to.
        </p>
      </div>

      <FieldTypesCard cfg={cfg} />

      <Card><CardBody className="flex items-end gap-3 flex-wrap">
        <div className="w-72">
          <Combobox label="Edit a shop" options={shopOptions} value={pickerId} onChange={setPickerId}
            placeholder="Search by name, address, or city…" />
        </div>
        <Button size="sm" disabled={!pickerId} onClick={() => setEditingId(pickerId)}>Edit Custom Config</Button>
      </CardBody></Card>

      <Card><CardBody className="flex flex-col gap-2">
        <span className="text-xs font-mono text-navy uppercase tracking-wide">Custom Shops ({customIds.length})</span>
        {cfg.loading ? (
          <div className="py-8 flex justify-center"><SbLoader size={28} /></div>
        ) : customIds.length === 0 ? (
          <p className="text-xs font-mono text-inky/50 italic py-2">No shops have custom config yet.</p>
        ) : (
          <div className="overflow-x-auto rounded border border-navy/30">
            <table className="text-xs font-mono">
              <thead>
                <tr className="border-b border-navy/30 bg-cream text-inky uppercase tracking-wide">
                  <th className="px-3 py-2 text-left whitespace-nowrap">Shop</th>
                  {activeFields.map((f) => (
                    <th key={f.id} className="px-3 py-2 text-right whitespace-nowrap">{f.name}</th>
                  ))}
                  <th className="px-3 py-2 text-left whitespace-nowrap">Custom Package(s)</th>
                  <th className="px-3 py-2 whitespace-nowrap" />
                </tr>
              </thead>
              <tbody>
                {customIds.map((id) => {
                  const vals = cfg.valuesFor(id)
                  const pkgs = cfg.packagesFor(id)
                  return (
                    <tr key={id} className="border-b border-navy/20">
                      <td className="px-3 py-1.5 text-navy whitespace-nowrap">{loc.labelOf(id)}</td>
                      {activeFields.map((f) => {
                        const v = vals.find((x) => x.field_id === f.id)
                        return <td key={f.id} className="px-3 py-1.5 text-navy text-right whitespace-nowrap">{formatFieldValue(v?.value ?? null, f.value_kind)}</td>
                      })}
                      <td className="px-3 py-1.5 text-navy">
                        {pkgs.length === 0 ? <span className="text-inky/30">—</span> : pkgs.map((p) => packageLabel(p.package_key)).join(', ')}
                      </td>
                      <td className="px-3 py-1.5">
                        <button onClick={() => setEditingId(id)} className="text-[10px] font-mono text-sky hover:underline">edit</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardBody></Card>

      {editingId && (
        <CustomShopConfigModal cfg={cfg} packageOptions={packageOptions} locationId={editingId} locationLabel={loc.labelOf(editingId)} onClose={() => setEditingId(null)} />
      )}
    </div>
  )
}

function FieldTypesCard({ cfg }: { cfg: ReturnType<typeof useCustomShopConfig> }) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState<FieldValueKind>('currency')
  const [saving, setSaving] = useState(false)

  async function add() {
    if (!name.trim()) return
    setSaving(true)
    const ok = await cfg.addField(name, kind)
    setSaving(false)
    if (ok) { setName(''); setKind('currency') }
  }

  return (
    <Card><CardBody className="flex flex-col gap-3">
      <div>
        <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Field Types</h3>
        <p className="text-[11px] font-mono text-inky/60 mt-0.5">
          The kinds of custom thing a shop can have. Add more any time — every shop's editor picks up new ones automatically.
        </p>
      </div>

      {cfg.fields.length > 0 && (
        <div className="flex flex-col gap-1">
          {cfg.fields.map((f) => (
            <div key={f.id} className="flex items-center gap-2 text-xs font-mono text-navy">
              <span className="w-48">{f.name}</span>
              <span className="text-inky/50 w-32">{VALUE_KIND_LABELS[f.value_kind]}</span>
              <button onClick={() => cfg.removeField(f.id)} className="text-inky/40 hover:text-[#C0392B]" title="Remove — clears every shop's value for this field">✕</button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2 flex-wrap border-t border-navy/10 pt-3">
        <div className="w-56">
          <Input label="New field name" placeholder="e.g. Loyalty Discount" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="w-40">
          <Select label="Value type" value={kind} onChange={(e) => setKind(e.target.value as FieldValueKind)}
            options={(Object.keys(VALUE_KIND_LABELS) as FieldValueKind[]).map((k) => ({ value: k, label: VALUE_KIND_LABELS[k] }))} />
        </div>
        <Button size="sm" variant="secondary" disabled={!name.trim() || saving} onClick={add}>Add Field Type</Button>
      </div>
    </CardBody></Card>
  )
}
