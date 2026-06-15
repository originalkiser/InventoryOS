import { useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useMonthEndStore } from '@/stores/monthEndStore'
import { Select, Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui'
import { CountsTab } from './CountsTab'
import { RecountLogicTab } from './RecountLogicTab'
import { RecountsTab } from './RecountsTab'
import { NotSubmittedTab } from './NotSubmittedTab'

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

const MONTH_OPTIONS = MONTH_NAMES.map((name, i) => ({ value: String(i + 1), label: name }))

const nowYear = new Date().getFullYear()
const YEAR_OPTIONS = Array.from({ length: 6 }, (_, i) => {
  const y = nowYear - i
  return { value: String(y), label: String(y) }
})

export function MonthEndPage() {
  const { profile } = useAuthStore()
  const { month, year, setPeriod } = useMonthEndStore()

  // Default the period to the most recent month that has count data.
  useEffect(() => {
    if (!profile?.company_id) return
    let cancelled = false
    ;(async () => {
      const { data } = await (supabase as any)
        .from('monthly_counts')
        .select('count_month')
        .eq('company_id', profile.company_id)
        .not('count_month', 'is', null)
        .order('count_month', { ascending: false })
        .limit(1)
      if (cancelled) return
      const latest = data?.[0]?.count_month as string | undefined
      if (latest) {
        const d = new Date(latest)
        setPeriod(d.getUTCMonth() + 1, d.getUTCFullYear())
      }
    })()
    return () => { cancelled = true }
  }, [profile?.company_id])

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Month End Inventory</h1>
          <p className="text-xs text-inky mt-0.5">Upload counts, review recount flags, and reconcile by period</p>
        </div>
        <div className="flex items-end gap-2">
          <div className="w-40">
            <Select
              label="Period — Month"
              options={MONTH_OPTIONS}
              value={String(month)}
              onChange={(e) => setPeriod(Number(e.target.value), year)}
            />
          </div>
          <div className="w-28">
            <Select
              label="Year"
              options={YEAR_OPTIONS}
              value={String(year)}
              onChange={(e) => setPeriod(month, Number(e.target.value))}
            />
          </div>
        </div>
      </div>

      <Tabs defaultValue="counts">
        <TabsList>
          <TabsTrigger value="counts">Counts</TabsTrigger>
          <TabsTrigger value="recount_logic">Recount Logic</TabsTrigger>
          <TabsTrigger value="recounts">Recounts</TabsTrigger>
          <TabsTrigger value="not_submitted">Not Submitted</TabsTrigger>
        </TabsList>
        <TabsContent value="counts"><CountsTab /></TabsContent>
        <TabsContent value="recount_logic"><RecountLogicTab /></TabsContent>
        <TabsContent value="recounts"><RecountsTab /></TabsContent>
        <TabsContent value="not_submitted"><NotSubmittedTab /></TabsContent>
      </Tabs>
    </div>
  )
}
