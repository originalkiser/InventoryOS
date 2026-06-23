import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { useAuthStore } from '@/stores/authStore'
import { SUPABASE_MISSING } from '@/lib/supabase'
import { AppShell } from '@/components/layout/AppShell'
import { UpdateBanner } from '@/components/shared/UpdateBanner'
import { LoginPage } from '@/pages/Login'
import { ResetPasswordPage } from '@/pages/ResetPassword'
import { SetupPage } from '@/pages/Setup'
import { UsersPage } from '@/modules/admin/UsersPage'
import { FeatureRequestsPage } from '@/modules/feature-requests/FeatureRequestsPage'
import { FeatureRequestForm } from '@/modules/feature-requests/FeatureRequestForm'
import { ManageRequestsPage } from '@/modules/feature-requests/ManageRequestsPage'
import { isAdminOrDeveloper } from '@/lib/roles'
import { DashboardPage } from '@/pages/Dashboard'
import { ConfigPage } from '@/modules/config/ConfigPage'
import { MonthEndPage } from '@/modules/monthend/MonthEndPage'
import { WeeklyPage } from '@/modules/weekly/WeeklyPage'
import { OrdersPage } from '@/modules/orders/OrdersPage'
import { IssuesPage } from '@/modules/issues/IssuesPage'
import { SchedulePage } from '@/modules/schedule/SchedulePage'
import { ProjectsModule } from '@/modules/projects/ProjectsModule'
import { MeetingNotesPage } from '@/modules/meetings/MeetingNotesPage'
import { TasksPage } from '@/modules/tasks/TasksPage'
import { OrderConfigPage } from '@/pages/OrderConfig'
import { OrderHistoryPage } from '@/pages/OrderHistory'

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { session, initialized } = useAuthStore()
  const isPlaceholder = import.meta.env.VITE_SUPABASE_URL?.includes('placeholder')
  if (!isPlaceholder && !initialized) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center">
        <div className="text-inky font-body text-xs tracking-widest animate-pulse">Loading</div>
      </div>
    )
  }
  if (!isPlaceholder && session === null) return <Navigate to="/login" replace />
  return <>{children}</>
}

function RequireAdminOrDev({ children }: { children: React.ReactNode }) {
  const { profile } = useAuthStore()
  if (!isAdminOrDeveloper(profile?.role)) return <Navigate to="/dashboard" replace />
  return <>{children}</>
}

function AuthProvider() {
  useAuth()
  return null
}

export default function App() {
  if (SUPABASE_MISSING) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center font-body p-8">
        <div className="max-w-md w-full bg-cream border border-[#C0392B]/40 rounded-xl p-6 flex flex-col gap-3 shadow-sm">
          <div className="text-[#C0392B] text-sm font-heading font-bold uppercase tracking-wide">Configuration Error</div>
          <p className="text-navy text-xs leading-relaxed font-body">
            Supabase environment variables are missing. The app was built without{' '}
            <code className="text-inky">VITE_SUPABASE_URL</code> and{' '}
            <code className="text-inky">VITE_SUPABASE_ANON_KEY</code>.
          </p>
          <p className="text-inky text-xs leading-relaxed font-body">
            In GitHub Actions: go to <strong className="text-navy">Settings → Secrets and variables → Actions</strong>{' '}
            and add both secrets, then re-run the deployment workflow.
          </p>
        </div>
      </div>
    )
  }

  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <AuthProvider />
      <UpdateBanner />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/setup" element={<SetupPage />} />

        <Route
          path="/"
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        >
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="config" element={<ConfigPage />} />
          <Route path="monthend" element={<MonthEndPage />} />
          <Route path="month-end" element={<Navigate to="/monthend" replace />} />
          <Route path="weekly" element={<WeeklyPage />} />
          <Route path="orders" element={<OrdersPage />} />
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
        </Route>

        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
