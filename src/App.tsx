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
import { DashboardPage } from '@/pages/Dashboard'
import { ConfigPage } from '@/modules/config/ConfigPage'
import { MonthEndPage } from '@/modules/monthend/MonthEndPage'
import { WeeklyPage } from '@/modules/weekly/WeeklyPage'
import { OrdersPage } from '@/modules/orders/OrdersPage'
import { IssuesPage } from '@/modules/issues/IssuesPage'
import { SchedulePage } from '@/modules/schedule/SchedulePage'

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { session, initialized } = useAuthStore()
  const isPlaceholder = import.meta.env.VITE_SUPABASE_URL?.includes('placeholder')
  // Wait for the initial session check before deciding to redirect
  if (!isPlaceholder && !initialized) {
    return (
      <div className="min-h-screen bg-[#0f1117] flex items-center justify-center">
        <div className="text-[#00e5ff] font-mono text-xs tracking-widest animate-pulse">LOADING…</div>
      </div>
    )
  }
  if (!isPlaceholder && session === null) return <Navigate to="/login" replace />
  return <>{children}</>
}

function AuthProvider() {
  useAuth()
  return null
}

export default function App() {
  if (SUPABASE_MISSING) {
    return (
      <div className="min-h-screen bg-[#0f1117] flex items-center justify-center font-mono p-8">
        <div className="max-w-md w-full bg-[#161820] border border-red-500/40 rounded-lg p-6 flex flex-col gap-3">
          <div className="text-red-400 text-sm font-semibold uppercase tracking-wide">Configuration Error</div>
          <p className="text-gray-300 text-xs leading-relaxed">
            Supabase environment variables are missing. The app was built without{' '}
            <code className="text-[#00e5ff]">VITE_SUPABASE_URL</code> and{' '}
            <code className="text-[#00e5ff]">VITE_SUPABASE_ANON_KEY</code>.
          </p>
          <p className="text-gray-500 text-xs leading-relaxed">
            In GitHub Actions: go to <strong className="text-white">Settings → Secrets and variables → Actions</strong>{' '}
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
          <Route path="schedule" element={<SchedulePage />} />
          <Route path="admin/users" element={<UsersPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
