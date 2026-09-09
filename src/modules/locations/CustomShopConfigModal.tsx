import { useEffect, useState } from 'react'
import { Modal, Button, Toggle } from '@/components/ui'
import {
  useCustomShopConfig, VALUE_KIND_LABELS,
  type FieldValueKind,
} from './useCustomShopConfig'

/**
 * Edit one shop's custom config — every admin-defined field it has a
 * value for, plus which Menu Board package(s) the custom setup applies to.
 * Used both from Location Lookup's Custom Config box (current shop) and
 * from the Custom Shop Config page (any shop) — `cfg`/`packageOptions` are
 * passed in from whichever already holds them, rather than fetched again
 * here, so the caller's own view refreshes immediately after a save instead
 * of needing a second, independent hook instance to notice the change.
 */
export function CustomShopConfigModal({ cfg, packageOptions, locationId, locationLabel, onClose }: {
  cfg: ReturnType<typeof useCustomShopConfig>
  packageOptions: { package_key: string; display_name: string }[]
  locationId: string
  locationLabel: string
  onClose: () => void
}) {
  const { fields, valuesFor, packagesFor, setValue, togglePackage, loading, reload } = cfg
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [pkgDraft, setPkgDraft] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const existing = valuesFor(locationId)
    const map: Record<string, string> = {}
    for (const v of existing) map[v.field_id] = v.value ?? ''
    setDraft(map)
    setPkgDraft(new Set(packagesFor(locationId).map((p) => p.package_key)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId, loading])

  async function save() {
    setSaving(true)
    await Promise.all([
      ...fields.map((f) => setValue(locationId, f.id, draft[f.id] ?? '')),
      ...packageOptions.map((p) => togglePackage(locationId, p.package_key, pkgDraft.has(p.package_key))),
    ])
    await reload()
    setSaving(false)
    onClose()
  }

  const activeFields = fields.filter((f) => f.active)

  return (
    <Modal open onClose={onClose} title={`Custom Config — ${locationLabel}`} size="md">
      <div className="flex flex-col gap-4">
        {activeFields.length === 0 ? (
          <p className="text-xs font-mono text-inky/50 italic">
            No custom field types defined yet — add some from the Custom Shop Config page.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {activeFields.map((f) => (
              <FieldInput key={f.id} label={f.name} kind={f.value_kind}
                value={draft[f.id] ?? ''} onChange={(v) => setDraft((d) => ({ ...d, [f.id]: v }))} />
            ))}
          </div>
        )}

        {packageOptions.length > 0 && (
          <div className="flex flex-col gap-2 border-t border-navy/10 pt-3">
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

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
        </div>
      </div>
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
