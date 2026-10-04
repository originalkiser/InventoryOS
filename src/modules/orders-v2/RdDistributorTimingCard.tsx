// Order Settings (shared): when each RelaDyne distributor (warehouse) processes its shops' VMI / keep-fill bulk orders — on
// the shop's order day, or the day before delivery — plus wiggle room either side. The "possible VMI misses" check uses it to
// decide whether a bulk order is overdue (see vmiMissCheck.ts). A distributor with no mapping uses the default below.
import { useEffect, useState } from 'react'
import { Card, CardBody } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useAppSetting } from '@/hooks/useAppSetting'
import { BASIS_LABELS, DEFAULT_TIMING, type DistributorTiming, type TimingBasis, type TimingMap } from './vmiMissCheck'
import { RD_TIMING_KEY } from './useVmiMissCheck'

let codesCache: { company: string; codes: string[] } | null = null

export function RdDistributorTimingCard() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [timing, setTiming] = useAppSetting<TimingMap>(RD_TIMING_KEY, {})
  const [codes, setCodes] = useState<string[]>(codesCache && codesCache.company === companyId ? codesCache.codes : [])

  // Distributors (warehouse codes) seen on the uploaded Open Sales Order reports.
  useEffect(() => {
    if (!companyId || (codesCache && codesCache.company === companyId)) return
    let cancelled = false
    ;(supabase as any).schema('inventory').from('rd_open_orders').select('warehouse_code').eq('company_id', companyId).not('warehouse_code', 'is', null).limit(30000)
      .then(({ data }: any) => {
        if (cancelled) return
        const list = [...new Set(((data ?? []) as any[]).map((r) => String(r.warehouse_code)))].sort()
        codesCache = { company: companyId, codes: list }
        setCodes(list)
      })
    return () => { cancelled = true }
  }, [companyId])

  const get = (code: string): DistributorTiming => timing[code] ?? DEFAULT_TIMING
  const set = (code: string, patch: Partial<DistributorTiming>) => setTiming({ ...timing, [code]: { ...get(code), ...patch } })
  const all = [...new Set([...codes, ...Object.keys(timing)])].sort()
  const cls = 'bg-cream border border-navy/30 rounded px-2 py-1 text-xs font-mono text-navy'

  return (
    <Card><CardBody className="flex flex-col gap-2">
      <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">RelaDyne Distributor VMI Timing</h3>
      <p className="text-[11px] font-mono text-inky/60">
        When each distributor processes its shops' VMI / keep-fill bulk orders, with wiggle room either side. If a shop's tank will run out
        before its delivery after next and there's no bulk order within that window, it shows up as a "Possible VMI miss" Inventory Alert.
        Distributors not listed use: {BASIS_LABELS[DEFAULT_TIMING.basis].toLowerCase()}, ± {DEFAULT_TIMING.wiggle_days} days.
      </p>
      {all.length === 0 ? <p className="text-[11px] font-mono text-navy/75">Distributors appear here once an Open Sales Order report has been uploaded.</p> : (
        <div className="overflow-auto">
          <table className="text-xs font-mono">
            <thead><tr className="text-left text-navy/75 uppercase tracking-wide"><th className="pr-4 py-1">Distributor</th><th className="pr-4 py-1">Processes VMI orders</th><th className="py-1">Wiggle (± days)</th></tr></thead>
            <tbody>
              {all.map((code) => (
                <tr key={code} className="border-t border-navy/10">
                  <td className="pr-4 py-1 text-navy font-bold">{code}</td>
                  <td className="pr-4 py-1">
                    <select className={cls} value={get(code).basis} onChange={(e) => set(code, { basis: e.target.value as TimingBasis })}>
                      {(Object.keys(BASIS_LABELS) as TimingBasis[]).map((b) => <option key={b} value={b}>{BASIS_LABELS[b]}</option>)}
                    </select>
                  </td>
                  <td className="py-1"><input className={`${cls} w-16`} type="number" min={0} max={30} value={get(code).wiggle_days}
                    onChange={(e) => set(code, { wiggle_days: Math.max(0, Math.min(30, Number(e.target.value) || 0)) })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </CardBody></Card>
  )
}
