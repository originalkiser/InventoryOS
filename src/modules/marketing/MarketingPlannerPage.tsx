import { useEffect, useState } from 'react'
import { Tabs, TabsList, TabsTrigger, TabsContent, SbLoader } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { isAdminOrDeveloper } from '@/lib/roles'
import toast from 'react-hot-toast'
import type { MarketingLocation } from '@/types/marketing'
import { CampaignTemplatesTab } from './tabs/CampaignTemplatesTab'
import { MonthlyPlansTab } from './tabs/MonthlyPlansTab'
import { ExecutionTab } from './tabs/ExecutionTab'
import { ReportingTab } from './tabs/ReportingTab'

export function MarketingPlannerPage() {
  const { profile } = useAuthStore()
  const isAdmin = isAdminOrDeveloper(profile?.role)
  const companyId = profile?.company_id

  const [locations, setLocations] = useState<MarketingLocation[]>([])
  const [loadingLocations, setLoadingLocations] = useState(true)

  useEffect(() => {
    if (!companyId) return
    loadLocations()
  }, [companyId]) // eslint-disable-line

  async function loadLocations() {
    setLoadingLocations(true)
    const sb = supabase as any
    const { data, error } = await sb.schema('core').from('locations')
      .select('*')
      .eq('company_id', companyId)
      .order('name')
    if (error) { toast.error('Failed to load shops'); setLoadingLocations(false); return }
    // Filter client-side: exclude only explicitly deactivated (active === false)
    setLocations((data ?? []).filter((l: any) => l.active !== false))
    setLoadingLocations(false)
  }

  if (loadingLocations) {
    return (
      <div className="flex items-center justify-center h-48">
        <SbLoader />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <div>
        <h1 className="text-lg font-heading font-bold text-navy uppercase tracking-wide">Marketing Planner</h1>
        <p className="text-xs font-mono text-inky mt-0.5">Campaign templates, monthly plans, and execution tracking</p>
      </div>

      <Tabs defaultValue="execution">
        <TabsList>
          <TabsTrigger value="execution">Execution</TabsTrigger>
          <TabsTrigger value="plans">Monthly Plans</TabsTrigger>
          <TabsTrigger value="reporting">Reporting</TabsTrigger>
          <TabsTrigger value="templates">Campaign Templates</TabsTrigger>
        </TabsList>

        <TabsContent value="execution">
          <ExecutionTab locations={locations} />
        </TabsContent>

        <TabsContent value="plans">
          <MonthlyPlansTab locations={locations} isAdmin={isAdmin} />
        </TabsContent>

        <TabsContent value="reporting">
          <ReportingTab locations={locations} />
        </TabsContent>

        <TabsContent value="templates">
          <CampaignTemplatesTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
