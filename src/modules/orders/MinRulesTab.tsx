import { useEffect, useState, useCallback, useMemo } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { Button, Input, Select, Toggle, Badge, Card, CardHeader, CardBody } from '@/components/ui'
import type { OrderMinRule } from '@/types'
import toast from 'react-hot-toast'

type Scope = 'global' | 'location' | 'product' | 'vendor' | 'column_value'

interface AppliesTo { scope: Scope; location?: string; field?: string; value?: string }
interface RuleLogic { caseSize?: number | null; maxQty?: number | null; maxOnHandAfter?: number | null }

const SCOPE_OPTIONS = [
  { value: 'global', label: '🌐 Global' },
  { value: 'location', label: '📍 Location' },
  { value: 'product', label: '📦 Product' },
  { value: 'vendor', label: '🏭 Vendor Part' },
  { value: 'column_value', label: '🏷 Field Value' },
]

const scopeColor: Record<Scope, 'cyan' | 'green' | 'magenta' | 'amber' | 'gray'> = {
  global: 'cyan', location: 'green', product: 'magenta', vendor: 'amber', column_value: 'gray',
}

function numOrNull(s: string): number | null {
  const t = s.trim()
  if (t === '') return null
  const n = Number(t)
  return isNaN(n) ? null : n
}

function rulePreview(r: OrderMinRule): string {
  const a = (r.applies_to ?? {}) as unknown as AppliesTo
  const logic = (r.rule_logic ?? {}) as unknown as RuleLogic
  const where =
    a.scope === 'global' ? 'every line'
    : a.scope === 'location' ? `lines at location ${a.location}`
    : a.scope === 'product' ? `product ${a.value}`
    : a.scope === 'vendor' ? `vendor part ${a.value}`
    : `${a.field} = ${a.value}`
  const clauses: string[] = []
  if (r.individual_minimum != null) clauses.push(`order at least ${r.individual_minimum}`)
  if (r.bulk_minimum != null || logic.caseSize != null) clauses.push(`round up to ${logic.caseSize ?? r.bulk_minimum}-unit ${r.package_type ?? 'cases'}`)
  if (logic.maxQty != null) clauses.push(`cap at ${logic.maxQty}`)
  if (logic.maxOnHandAfter != null) clauses.push(`keep on-hand ≤ ${logic.maxOnHandAfter}`)
  if (!clauses.length) return `For ${where}: no thresholds set.`
  return `For ${where}: ${clauses.join(', ')}.`
}

export function MinRulesTab() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null

  const [rules, setRules] = useState<OrderMinRule[]>([])
  const [loading, setLoading] = useState(true)

  // Form
  const [name, setName] = useState('')
  const [scope, setScope] = useState<Scope>('global')
  const [location, setLocation] = useState('')
  const [field, setField] = useState('category')
  const [value, setValue] = useState('')
  const [individualMin, setIndividualMin] = useState('')
  const [bulkMin, setBulkMin] = useState('')
  const [uom, setUom] = useState('')
  const [packageType, setPackageType] = useState('')
  const [caseSize, setCaseSize] = useState('')
  const [maxQty, setMaxQty] = useState('')
  const [maxOnHandAfter, setMaxOnHandAfter] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const { data } = await (supabase as any).schema('inventory').from('order_min_rules').select('*').eq('company_id', companyId).order('created_at', { ascending: false })
    setRules((data ?? []) as OrderMinRule[])
    setLoading(false)
  }, [companyId])

  useEffect(() => { load() }, [load])

  function resetForm() {
    setName(''); setScope('global'); setLocation(''); setField('category'); setValue('')
    setIndividualMin(''); setBulkMin(''); setUom(''); setPackageType('')
    setCaseSize(''); setMaxQty(''); setMaxOnHandAfter('')
  }

  async function addRule() {
    if (!companyId) return
    if (scope === 'location' && !location.trim()) { toast.error('Location is required'); return }
    if ((scope === 'product' || scope === 'vendor' || scope === 'column_value') && !value.trim()) { toast.error('Value is required'); return }
    if (!individualMin && !bulkMin && !caseSize) { toast.error('Set at least one minimum / case size'); return }

    const applies_to: AppliesTo = { scope }
    if (scope === 'location') applies_to.location = location.trim()
    if (scope === 'product' || scope === 'vendor') applies_to.value = value.trim()
    if (scope === 'column_value') { applies_to.field = field; applies_to.value = value.trim() }

    const rule_logic: RuleLogic = {
      caseSize: numOrNull(caseSize),
      maxQty: numOrNull(maxQty),
      maxOnHandAfter: numOrNull(maxOnHandAfter),
    }

    setSaving(true)
    const { error } = await (supabase as any).schema('inventory').from('order_min_rules').insert({
      company_id: companyId,
      name: name.trim() || null,
      applies_to,
      individual_minimum: numOrNull(individualMin),
      bulk_minimum: numOrNull(bulkMin),
      uom: uom.trim() || null,
      package_type: packageType.trim() || null,
      rule_logic,
      active: true,
    })
    setSaving(false)
    if (error) toast.error(error.message)
    else { toast.success('Rule added'); resetForm(); load() }
  }

  async function toggleActive(rule: OrderMinRule) {
    await (supabase as any).schema('inventory').from('order_min_rules').update({ active: !rule.active }).eq('id', rule.id)
    load()
  }

  async function removeRule(rule: OrderMinRule) {
    if (!confirm('Delete this rule?')) return
    await (supabase as any).schema('inventory').from('order_min_rules').delete().eq('id', rule.id)
    toast.success('Rule deleted'); load()
  }

  const sortedRules = useMemo(() => rules, [rules])

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader><span className="text-xs font-mono text-inky uppercase tracking-wide">Add Minimum Order Rule</span></CardHeader>
        <CardBody className="flex flex-col gap-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Input label="Rule Name (optional)" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Case minimums" />
            <Select label="Scope" options={SCOPE_OPTIONS} value={scope} onChange={(e) => setScope(e.target.value as Scope)} />
            {scope === 'location' && <Input label="Location (code/name)" value={location} onChange={(e) => setLocation(e.target.value)} />}
            {(scope === 'product' || scope === 'vendor') && <Input label={scope === 'product' ? 'Product ID' : 'Vendor Part #'} value={value} onChange={(e) => setValue(e.target.value)} />}
            {scope === 'column_value' && <>
              <Select label="Field" options={[{ value: 'category', label: 'Category' }, { value: 'unit_of_measure', label: 'UoM' }, { value: 'package_type', label: 'Package Type' }]} value={field} onChange={(e) => setField(e.target.value)} />
              <Input label="Value" value={value} onChange={(e) => setValue(e.target.value)} />
            </>}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Input label="Individual Min" value={individualMin} onChange={(e) => setIndividualMin(e.target.value)} placeholder="per-line floor" />
            <Input label="Bulk Min / Case Size" value={bulkMin} onChange={(e) => setBulkMin(e.target.value)} placeholder="round-up multiple" />
            <Input label="UoM" value={uom} onChange={(e) => setUom(e.target.value)} />
            <Input label="Package Type" value={packageType} onChange={(e) => setPackageType(e.target.value)} placeholder="e.g. Case" />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <Input label="Case Size override" value={caseSize} onChange={(e) => setCaseSize(e.target.value)} placeholder="round to multiple" />
            <Input label="Max Order Qty" value={maxQty} onChange={(e) => setMaxQty(e.target.value)} />
            <Input label="Max On-Hand After" value={maxOnHandAfter} onChange={(e) => setMaxOnHandAfter(e.target.value)} />
          </div>

          <div className="flex justify-end">
            <Button size="sm" loading={saving} onClick={addRule}>+ Add Rule</Button>
          </div>
        </CardBody>
      </Card>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-mono text-inky uppercase tracking-wide">
          Rules ({rules.length}) · Precedence: Product/Vendor &gt; Field &gt; Location &gt; Global
        </span>
        {loading ? (
          <p className="text-xs font-mono text-inky">Loading…</p>
        ) : sortedRules.length === 0 ? (
          <p className="text-xs font-mono text-inky/70">No rules yet. Orders will use calculated quantities.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {sortedRules.map((r) => {
              const a = (r.applies_to ?? {}) as unknown as AppliesTo
              return (
                <div key={r.id} className="flex items-center justify-between gap-3 px-4 py-3 border border-navy/30 rounded bg-cream">
                  <div className="flex flex-col gap-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge color={scopeColor[a.scope] ?? 'gray'}>{a.scope}</Badge>
                      {r.name && <span className="text-xs font-mono text-navy">{r.name}</span>}
                      {!r.active && <span className="text-[10px] font-mono text-inky/70 uppercase">inactive</span>}
                    </div>
                    <span className="text-xs font-mono text-inky">{rulePreview(r)}</span>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <Toggle checked={r.active} onChange={() => toggleActive(r)} size="sm" color="green" />
                    <button onClick={() => removeRule(r)} className="text-xs font-mono text-red-400 hover:text-red-300 border border-red-500/30 rounded px-2 py-1 hover:bg-red-500/10">Remove</button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
