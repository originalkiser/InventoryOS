import { WeekProvider } from './WeekContext'
import { useAuthStore } from '@/stores/authStore'
import { Routes, Route, Navigate } from 'react-router-dom'
import DepartmentPage from './pages/DepartmentPage'
import ReportViewPage from './pages/ReportViewPage'
import AMDashboardPage from './pages/AMDashboardPage'
import LeadershipPage from './pages/LeadershipPage'

function OutlierHome() {
  const { profile } = useAuthStore()
  const role = profile?.role as string | undefined
  if (role === 'director') return <Navigate to="/operations/outlier/leadership" replace />
  if (role === 'area_manager') return <Navigate to="/operations/outlier/am-dashboard" replace />
  return <DepartmentPage />
}

export function OutlierShell() {
  return (
    <WeekProvider>
      <div className="min-h-full bg-sb-navy text-sb-cream">
        <Routes>
          <Route index element={<OutlierHome />} />
          <Route path="report/:slug" element={<ReportViewPage />} />
          <Route path="am-dashboard" element={<AMDashboardPage />} />
          <Route path="leadership" element={<LeadershipPage />} />
        </Routes>
      </div>
    </WeekProvider>
  )
}
