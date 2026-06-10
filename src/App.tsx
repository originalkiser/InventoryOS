import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { useAuthStore } from '@/stores/authStore'
import { AppShell } from '@/components/layout/AppShell'
import { LoginPage } from '@/pages/Login'
import { ResetPasswordPage } from '@/pages/ResetPassword'
import { SetupPage } from '@/pages/Setup'
import { UsersPage } from '@/modules/admin/UsersPage'
import { DashboardPage } from '@/pages/Dashboard'
import { ConfigPage } from '@/modules/config/ConfigPage'
import { MonthEndPage } from '@/modules/monthend/MonthEndPage'
import { WeeklyCountsPage } from '@/modules/weekly/WeeklyCountsPage'
import { OrdersPage } from '@/modules/orders/OrdersPage'
import { IssuesPage } from '@/modules/issues/IssuesPage'
import { SchedulePage } from '@/modules/schedule/SchedulePage'

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { session } = useAuthStore()
  // DEV_PREVIEW: allow bypass when env is placeholder
  const isPlaceholder = import.meta.env.VITE_SUPABASE_URL?.includes('placeholder')
  if (!isPlaceholder && session === null) return <Navigate to="/login" replace />
  return <>{children}</>
}

function AuthProvider() {
  useAuth()
  return null
}

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <AuthProvider />
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
          <Route path="weekly" element={<WeeklyCountsPage />} />
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
