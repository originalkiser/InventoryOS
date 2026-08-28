import { useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useProfilePref } from '@/hooks/useProfilePrefs'
import { useMonthEndStore } from '@/stores/monthEndStore'
import { Select, Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui'
import { MonthEndPullPanel } from '@/components/integrations/MonthEndPullPanel'
import { CountsTab } from './CountsTab'
import { RecountLogicTab } from './RecountLogicTab'
import { RecountsTab } from './RecountsTab'
import { RecountHistoryTab } from './RecountHistoryTab'
import { NotSubmittedTab } from './NotSubmittedTab'
import { ProductExceptionsTab } from './ProductExceptionsTab'
import { OverviewTab } from './OverviewTab'
import { ReviewTab } from './ReviewTab'

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
  const [savedPeriod, setSavedPeriod, prefsLoaded] = useProfilePref<{ month: number; year: number } | null>('monthend:period', null)

  // Restore whatever period the user last picked, once profile prefs have
  // loaded (cross-device). Only when nothing has ever been picked does this
  // fall back to the most recent month with count data — after that first
  // default, an explicit choice sticks until changed again.
  useEffect(() => {
    if (!prefsLoaded) return
    if (savedPeriod) { setPeriod(savedPeriod.month, savedPeriod.year); return }
    if (!profile?.company_id) return
    let cancelled = false
    ;(async () => {
      const { data } = await (supabase as any)
        .schema('inventory').from('counts')
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
  }, [prefsLoaded, savedPeriod, profile?.company_id])

  function changePeriod(m: number, y: number) {
    setPeriod(m, y)
    setSavedPeriod({ month: m, year: y })
  }

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
              onChange={(e) => changePeriod(Number(e.target.value), year)}
            />
          </div>
          <div className="w-28">
            <Select
              label="Year"
              options={YEAR_OPTIONS}
              value={String(year)}
              onChange={(e) => changePeriod(month, Number(e.target.value))}
            />
          </div>
        </div>
      </div>

      <MonthEndPullPanel />

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="counts">Counts</TabsTrigger>
          <TabsTrigger value="product_exceptions">Product Exceptions</TabsTrigger>
          <TabsTrigger value="recount_logic">Recount Logic</TabsTrigger>
          <TabsTrigger value="recounts">Recounts</TabsTrigger>
          <TabsTrigger value="recount_history">Recount History</TabsTrigger>
          <TabsTrigger value="review">Review</TabsTrigger>
          <TabsTrigger value="not_submitted">Not Submitted</TabsTrigger>
        </TabsList>
        <TabsContent value="overview"><OverviewTab /></TabsContent>
        <TabsContent value="counts"><CountsTab /></TabsContent>
        <TabsContent value="product_exceptions"><ProductExceptionsTab /></TabsContent>
        <TabsContent value="recount_logic"><RecountLogicTab /></TabsContent>
        <TabsContent value="recounts"><RecountsTab /></TabsContent>
        <TabsContent value="recount_history"><RecountHistoryTab /></TabsContent>
        <TabsContent value="review"><ReviewTab /></TabsContent>
        <TabsContent value="not_submitted"><NotSubmittedTab /></TabsContent>
      </Tabs>
    </div>
  )
}
