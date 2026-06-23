import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useOrderStore } from '@/stores/orderStore'
import { Button, Input, Card, CardHeader, CardBody } from '@/components/ui'
import type { OrderProfile } from '@/types'
import type { GenerationParams } from '@/lib/orderEngine'
import type { ColumnMapping } from '@/types'
import { format } from 'date-fns'
import toast from 'react-hot-toast'

interface ProfileConfig {
  params?: GenerationParams
  selectedMinRuleIds?: string[]
  mapping?: ColumnMapping[]
}

export function ProfilesTab() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const { params, selectedMinRuleIds, mapping, setParams, setSelectedMinRuleIds, setMapping } = useOrderStore()

  const [profiles, setProfiles] = useState<OrderProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const { data } = await (supabase as any).schema('inventory').from('order_profiles').select('*').eq('company_id', companyId).order('created_at', { ascending: false })
    setProfiles((data ?? []) as OrderProfile[])
    setLoading(false)
  }, [companyId])

  useEffect(() => { load() }, [load])

  async function saveProfile() {
    if (!companyId || !name.trim()) { toast.error('Name is required'); return }
    setSaving(true)
    const config: ProfileConfig = { params, selectedMinRuleIds, mapping }
    const { error } = await (supabase as any).schema('inventory').from('order_profiles').upsert({
      company_id: companyId,
      name: name.trim(),
      scope: 'order',
      config,
      created_by: profile?.id ?? null,
    }, { onConflict: 'company_id,name' })
    setSaving(false)
    if (error) toast.error(error.message)
    else { toast.success(`Profile "${name.trim()}" saved`); setName(''); load() }
  }

  function loadProfile(p: OrderProfile) {
    const cfg = (p.config ?? {}) as ProfileConfig
    if (cfg.params) setParams(cfg.params)
    if (cfg.selectedMinRuleIds) setSelectedMinRuleIds(cfg.selectedMinRuleIds)
    if (cfg.mapping) setMapping(cfg.mapping)
    toast.success(`Loaded "${p.name}" — open the New Order tab to use it`)
  }

  async function removeProfile(p: OrderProfile) {
    if (!confirm(`Delete profile "${p.name}"?`)) return
    await (supabase as any).schema('inventory').from('order_profiles').delete().eq('id', p.id)
    toast.success('Profile deleted'); load()
  }

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader><span className="text-xs font-mono text-inky uppercase tracking-wide">Save Current Setup as Profile</span></CardHeader>
        <CardBody className="flex items-end gap-2 flex-wrap">
          <div className="flex-1 min-w-[12rem]">
            <Input label="Profile Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Weekly POS import" />
          </div>
          <Button size="sm" loading={saving} onClick={saveProfile}>Save Profile</Button>
          <p className="w-full text-xs font-mono text-inky/70">
            Captures the current generation params, selected min-rule set, and file column mapping from the New Order tab.
          </p>
        </CardBody>
      </Card>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-mono text-inky uppercase tracking-wide">Saved Profiles ({profiles.length})</span>
        {loading ? (
          <p className="text-xs font-mono text-inky">Loading…</p>
        ) : profiles.length === 0 ? (
          <p className="text-xs font-mono text-inky/70">No saved profiles yet.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {profiles.map((p) => {
              const cfg = (p.config ?? {}) as ProfileConfig
              return (
                <div key={p.id} className="flex items-center justify-between gap-3 px-4 py-3 border border-navy/30 rounded bg-cream">
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-xs font-mono text-navy">{p.name}</span>
                    <span className="text-[11px] font-mono text-inky">
                      {cfg.params?.orderMode ?? '—'} · {cfg.params?.targetDays ?? '—'}d · {cfg.selectedMinRuleIds?.length ?? 0} rules · {cfg.mapping?.length ?? 0} mapped cols · {format(new Date(p.created_at), 'MMM d, yyyy')}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <Button size="sm" variant="secondary" onClick={() => loadProfile(p)}>Load</Button>
                    <button onClick={() => removeProfile(p)} className="text-xs font-mono text-red-400 hover:text-red-300 border border-red-500/30 rounded px-2 py-1 hover:bg-red-500/10">Delete</button>
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
