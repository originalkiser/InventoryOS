import { useEffect, useState } from 'react'
import { Modal, Button, Toggle, Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui'
import {
  useCustomShopConfig, VALUE_KIND_LABELS,
  type FieldValueKind,
} from './useCustomShopConfig'
import { DeliverySchedulesCard } from '@/modules/orders-v2/DeliverySchedulesCard'

/**
 * Edit one shop's custom config — every admin-defined field it has a
 * value for, plus which package(s) the custom setup applies to. Used both
 * from Location Lookup's Custom Config box (current shop) and from the
 * Custom Shop Config page (any shop) — `cfg`/`packageOptions` are passed
 * in from whichever already holds them, rather than fetched again here, so
 * the caller's own view refreshes immediately after a save instead of
 * needing a second, independent hook instance to notice the change.
 *
 * Package selection renders FIRST, not last — a per_package field's inputs
 * (Price Per Quart, Included Quarts) depend on knowing which packages are
 * checked, so picking those needs to happen before entering their values,
 * not after. Shop-wide fields (Shop Supply Fee, Oil Inflation Surcharge)
 * don't care about package selection at all and render once regardless.
 */
export function CustomShopConfigModal({ cfg, packageOptions, locationId, locationLabel, onClose }: {
  cfg: ReturnType<typeof useCustomShopConfig>
  packageOptions: { package_key: string; display_name: string }[]
  locationId: string
  locationLabel: string
  onClose: () => void
}) {
  const { fields, valuesFor, packagesFor, setValue, togglePackage, loading, reload } = cfg
  // Shop-wide field: keyed by fieldId alone. Per-package field: keyed by
  // `${fieldId}|${packageKey}`, one entry per currently-checked package.
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [pkgDraft, setPkgDraft] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const existing = valuesFor(locationId)
    const map: Record<string, string> = {}
    for (const v of existing) map[v.package_key ? `${v.field_id}|${v.package_key}` : v.field_id] = v.value ?? ''
    setDraft(map)
    setPkgDraft(new Set(packagesFor(locationId).map((p) => p.package_key)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId, loading])

  const activeFields = fields.filter((f) => f.active)
  const shopWideFields = activeFields.filter((f) => !f.per_package)
  const perPackageFields = activeFields.filter((f) => f.per_package)
  const checkedPackages = packageOptions.filter((p) => pkgDraft.has(p.package_key))

  async function save() {
    setSaving(true)
    await Promise.all([
      ...shopWideFields.map((f) => setValue(locationId, f.id, draft[f.id] ?? '')),
      // Per-package fields only ever save a value for a package that's
      // actually still checked — unchecking a package after entering a
      // value clears it rather than leaving an orphaned row for a package
      // this shop's custom setup no longer applies to.
      ...perPackageFields.flatMap((f) => checkedPackages.map((p) =>
        setValue(locationId, f.id, draft[`${f.id}|${p.package_key}`] ?? '', p.package_key),
      )),
      ...packageOptions.map((p) => togglePackage(locationId, p.package_key, pkgDraft.has(p.package_key))),
    ])
    await reload()
    setSaving(false)
    onClose()
  }

  return (
    <Modal open onClose={onClose} title={`Custom Config — ${locationLabel}`} size="lg">
      <Tabs defaultValue="pricing">
        <TabsList>
          <TabsTrigger value="pricing">Pricing &amp; Fees</TabsTrigger>
          <TabsTrigger value="schedule">Order / Delivery Schedule</TabsTrigger>
        </TabsList>

        <TabsContent value="pricing">
      <div className="flex flex-col gap-4">
        {packageOptions.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Custom for which package(s)?</span>
            <div className="flex flex-col gap-1">
              {packageOptions.map((p) => (
                <label key={p.package_key} className="flex items-center gap-2 text-xs font-mono text-navy cursor-pointer">
                  <Toggle size="sm" checked={pkgDraft.has(p.package_key)} onChange={(v) => setPkgDraft((s) => {
                    const next = new Set(s)
                    if (v) next.add(p.package_key); else next.delete(p.package_key)
                    return next
                  })} />
                  {p.display_name}
                </label>
              ))}
            </div>
          </div>
        )}

        {shopWideFields.length === 0 && perPackageFields.length === 0 ? (
          <p className="text-xs font-mono text-inky/50 italic">
            No custom field types defined yet — add some from the Custom Shop Config page.
          </p>
        ) : (
          <>
            {shopWideFields.length > 0 && (
              <div className="flex flex-col gap-2 border-t border-navy/10 pt-3">
                <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Shop-Wide</span>
                {shopWideFields.map((f) => (
                  <FieldInput key={f.id} label={f.name} kind={f.value_kind}
                    value={draft[f.id] ?? ''} onChange={(v) => setDraft((d) => ({ ...d, [f.id]: v }))} />
                ))}
              </div>
            )}

            {perPackageFields.length > 0 && (
              <div className="flex flex-col gap-3 border-t border-navy/10 pt-3">
                <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Per Package</span>
                {checkedPackages.length === 0 ? (
                  <p className="text-[11px] font-mono text-inky/50 italic">Check a package above to set its {perPackageFields.map((f) => f.name).join(' / ')}.</p>
                ) : (
                  checkedPackages.map((p) => (
                    <div key={p.package_key} className="flex flex-col gap-1.5 rounded border border-navy/10 px-2 py-2">
                      <span className="text-[11px] font-mono text-navy font-bold">{p.display_name}</span>
                      {perPackageFields.map((f) => (
                        <FieldInput key={f.id} label={f.name} kind={f.value_kind}
                          value={draft[`${f.id}|${p.package_key}`] ?? ''}
                          onChange={(v) => setDraft((d) => ({ ...d, [`${f.id}|${p.package_key}`]: v }))} />
                      ))}
                    </div>
                  ))
                )}
              </div>
            )}
          </>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
        </div>
      </div>
        </TabsContent>

        <TabsContent value="schedule">
          {/* Reuses the real Delivery Schedules editor (Order Settings' own
              vendor-scoped ov2_location_schedules editor) rather than a
              second, competing schedule table under Custom Shop Config's own
              schema — ov2_location_schedules is what Orders v2 generation
              actually reads, so this stays the single source of truth.
              Locked to this shop: pick a vendor, then add/edit/remove just
              this shop's schedule for it — no shop picker, no bulk upload/
              calendar/history-analysis tools (those are company/vendor-wide
              operations that don't belong inside a single-shop modal). */}
          <DeliverySchedulesCard lockedLocationId={locationId} />
        </TabsContent>
      </Tabs>
    </Modal>
  )
}

function FieldInput({ label, kind, value, onChange }: {
  label: string; kind: FieldValueKind; value: string; onChange: (v: string) => void
}) {
  const suffix = kind === 'percent' ? '%' : null
  const prefix = kind === 'currency' ? '$' : null
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-mono text-navy w-40 flex-shrink-0" title={VALUE_KIND_LABELS[kind]}>{label}</span>
      <div className="relative flex-1">
        {prefix && <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs font-mono text-inky/50">{prefix}</span>}
        <input
          type={kind === 'text' ? 'text' : 'number'}
          step={kind === 'currency' ? 0.01 : kind === 'percent' ? 0.1 : 1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="—"
          className={`w-full rounded border border-navy/30 bg-cream px-2 py-1 text-xs font-mono text-navy focus:border-sky focus:outline-none ${prefix ? 'pl-5' : ''} ${suffix ? 'pr-5' : ''}`}
        />
        {suffix && <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs font-mono text-inky/50">{suffix}</span>}
      </div>
    </div>
  )
}
