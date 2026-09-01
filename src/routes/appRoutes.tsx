// Every route that renders inside AppShell's content area. Pulled out of
// App.tsx so AppShell can render this SAME route list into more than one
// <Routes location={...}> instance — one per page kept warm in the Recent
// Pages cache (see AppShell.tsx) — instead of a single <Outlet/> that
// unmounts a page (and loses its already-fetched data) every time you
// navigate away from it.
//
// These path strings are unchanged from when they lived nested under
// App.tsx's <Route path="/">: a direct child of a <Routes> with no
// wrapping parent <Route> resolves the same absolute paths ("dashboard" ->
// "/dashboard", index -> "/"), so nothing here needed to change to move.
import { Navigate, Route } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'
import { useDeptAccess } from '@/hooks/useDeptAccess'
import { isAdminOrDeveloper } from '@/lib/roles'
import { SbLoader } from '@/components/ui'
import { DashboardPage } from '@/pages/Dashboard'
import { ConfigPage } from '@/modules/config/ConfigPage'
import { GlobalConfigPage } from '@/modules/config/GlobalConfigPage'
import { LocationsPage } from '@/modules/locations/LocationsPage'
import { LocationLookupPage } from '@/modules/locations/LocationLookupPage'
import { AmRdLookupPage } from '@/modules/locations/AmRdLookupPage'
import { TankMonitorsPage } from '@/modules/locations/TankMonitorsPage'
import { InventoryAlertsPage } from '@/modules/inventory/InventoryAlertsPage'
import { ExceptionReportingPage } from '@/modules/exceptions/ExceptionReportingPage'
import { LocationCommsPage } from '@/modules/comms/LocationCommsPage'
import { DevHubPage } from '@/modules/dev-hub/DevHubPage'
import { MonthEndPage } from '@/modules/monthend/MonthEndPage'
import { WeeklyPage } from '@/modules/weekly/WeeklyPage'
import { OrdersPage } from '@/modules/orders/OrdersPage'
import { IssuesPage } from '@/modules/issues/IssuesPage'
import { SchedulePage } from '@/modules/schedule/SchedulePage'
import { ProjectsModule } from '@/modules/projects/ProjectsModule'
import { MeetingNotesPage } from '@/modules/meetings/MeetingNotesPage'
import { TasksPage } from '@/modules/tasks/TasksPage'
import { OutlierShell } from '@/modules/operations/outlier/OutlierShell'
import { OrderConfigPage } from '@/pages/OrderConfig'
import { OrderHistoryPage } from '@/pages/OrderHistory'
import { FormsListPage } from '@/modules/forms/FormsListPage'
import { FormBuilderPage } from '@/modules/forms/FormBuilderPage'
import { FormResultsPage } from '@/modules/forms/FormResultsPage'
import { FormAssignmentsPage } from '@/modules/forms/FormAssignmentsPage'
import { OnHandPage } from '@/pages/OnHandPage'
import { MarketingPlannerPage } from '@/modules/marketing/MarketingPlannerPage'
import { CustomerHeatmapPage } from '@/modules/customers/CustomerHeatmapPage'
import { DroptopOrdersPage } from '@/modules/customers/DroptopOrdersPage'
import { OrdersV2Landing } from '@/modules/orders-v2/OrdersV2Landing'
import { OrdersV2Review } from '@/modules/orders-v2/OrdersV2Review'
import { OrdersV2FinalReview } from '@/modules/orders-v2/OrdersV2FinalReview'
import { OrdersV2Export } from '@/modules/orders-v2/OrdersV2Export'
import { OrdersV2Settings } from '@/modules/orders-v2/OrdersV2Settings'
import { OrdersV2History } from '@/modules/orders-v2/OrdersV2History'
import { PoStatusPage } from '@/modules/orders-v2/PoStatusPage'
import { UsersPage } from '@/modules/admin/UsersPage'
import { FeatureRequestsPage } from '@/modules/feature-requests/FeatureRequestsPage'
import { FeatureRequestForm } from '@/modules/feature-requests/FeatureRequestForm'
import { ManageRequestsPage } from '@/modules/feature-requests/ManageRequestsPage'

const DEPT_FIRST_ROUTE: Record<string, string> = {
  marketing: '/marketing-planner',
  operations: '/operations/outlier',
  inventory: '/dashboard',
}

function SmartRedirect() {
  const { profile } = useAuthStore()
  const allowedSections = useDeptAccess()
  const isDeptUser = (profile?.role as string) === 'department_user'

  if (isDeptUser && allowedSections === null) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center">
        <SbLoader />
      </div>
    )
  }

  if (isDeptUser && allowedSections) {
    for (const [slug, route] of Object.entries(DEPT_FIRST_ROUTE)) {
      if (allowedSections.has(slug)) return <Navigate to={route} replace />
    }
  }

  return <Navigate to="/dashboard" replace />
}

function RequireAdminOrDev({ children }: { children: React.ReactNode }) {
  const { profile } = useAuthStore()
  if (!isAdminOrDeveloper(profile?.role)) return <Navigate to="/dashboard" replace />
  return <>{children}</>
}

export const APP_ROUTE_ELEMENTS = (
  <>
    <Route index element={<SmartRedirect />} />
    <Route path="dashboard" element={<DashboardPage />} />
    <Route path="config" element={<ConfigPage />} />
    <Route path="global-config" element={<GlobalConfigPage />} />
    <Route path="locations" element={<LocationsPage />} />
    <Route path="location-lookup" element={<LocationLookupPage />} />
    <Route path="am-rd-lookup" element={<AmRdLookupPage />} />
    <Route path="tank-monitors" element={<TankMonitorsPage />} />
    <Route path="inventory-alerts" element={<InventoryAlertsPage />} />
    <Route path="exception-reporting" element={<ExceptionReportingPage />} />
    <Route path="location-comms" element={<LocationCommsPage />} />
    <Route path="dev-hub" element={<RequireAdminOrDev><DevHubPage /></RequireAdminOrDev>} />
    <Route path="monthend" element={<MonthEndPage />} />
    <Route path="month-end" element={<Navigate to="/monthend" replace />} />
    <Route path="weekly" element={<WeeklyPage />} />
    <Route path="orders" element={<OrdersPage />} />
    <Route path="orders-v2" element={<OrdersV2Landing />} />
    <Route path="orders-v2/settings" element={<OrdersV2Settings />} />
    <Route path="orders-v2/draft/:draftId" element={<OrdersV2Review />} />
    <Route path="orders-v2/draft/:draftId/final" element={<OrdersV2FinalReview />} />
    <Route path="orders-v2/draft/:draftId/export" element={<OrdersV2Export />} />
    <Route path="orders-v2/history/:orderId" element={<OrdersV2History />} />
    <Route path="po-status" element={<PoStatusPage />} />
    <Route path="on-hand" element={<OnHandPage />} />
    <Route path="issues" element={<IssuesPage />} />
    <Route path="projects" element={<ProjectsModule />} />
    <Route path="schedule" element={<SchedulePage />} />
    <Route path="meetings" element={<MeetingNotesPage />} />
    <Route path="tasks" element={<TasksPage />} />
    <Route path="admin/users" element={<RequireAdminOrDev><UsersPage /></RequireAdminOrDev>} />
    <Route path="order-config" element={<OrderConfigPage />} />
    <Route path="order-history" element={<OrderHistoryPage />} />
    <Route path="feature-requests" element={<FeatureRequestsPage />} />
    <Route path="feature-requests/new" element={<FeatureRequestForm />} />
    <Route path="feature-requests/manage" element={<RequireAdminOrDev><ManageRequestsPage /></RequireAdminOrDev>} />
    <Route path="operations/outlier/*" element={<OutlierShell />} />
    <Route path="forms" element={<FormsListPage />} />
    <Route path="forms/new" element={<FormBuilderPage />} />
    <Route path="forms/:formId/edit" element={<FormBuilderPage />} />
    <Route path="forms/:formId/results" element={<FormResultsPage />} />
    <Route path="forms/:formId/assignments" element={<FormAssignmentsPage />} />
    <Route path="marketing-planner" element={<MarketingPlannerPage />} />
    <Route path="customer-heatmap" element={<CustomerHeatmapPage />} />
    <Route path="droptop-orders" element={<DroptopOrdersPage />} />
    {/* Was previously an outer, top-level catch-all in App.tsx — moved here
        since AppShell's own route is now a "/*" splat and would otherwise
        render its chrome around a blank content area for an unmatched
        in-app path instead of falling through to this redirect. */}
    <Route path="*" element={<Navigate to="/dashboard" replace />} />
  </>
)
