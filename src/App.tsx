import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { useAuthStore } from '@/stores/authStore'
import { SUPABASE_MISSING } from '@/lib/supabase'
import { AppShell } from '@/components/layout/AppShell'
import { SbLoader } from '@/components/ui'
import { UpdateBanner } from '@/components/shared/UpdateBanner'
import { ImportPreviewHost } from '@/components/config/ImportPreviewHost'
import { LoginPage } from '@/pages/Login'
import { ResetPasswordPage } from '@/pages/ResetPassword'
import { SetupPage } from '@/pages/Setup'
import { PublicFormPage } from '@/pages/PublicFormPage'

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { session, profile, initialized } = useAuthStore()
  const isPlaceholder = import.meta.env.VITE_SUPABASE_URL?.includes('placeholder')
  if (!isPlaceholder && !initialized) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center">
        <SbLoader />
      </div>
    )
  }
  if (!isPlaceholder && session === null) return <Navigate to="/login" replace />
  // An admin reset this user's password — force Set New Password before
  // letting them into the rest of the app.
  if (!isPlaceholder && profile?.must_reset_password) return <Navigate to="/reset-password" replace />
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
      <ImportPreviewHost />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/setup" element={<SetupPage />} />

        {/* AppShell owns matching everything under here itself now (see
            src/routes/appRoutes.tsx) — it renders that same route list into
            more than one <Routes location={...}> instance so a few recently
            visited pages can stay mounted in the background instead of
            unmounting (and losing their fetched data) on every navigation. */}
        <Route
          path="/*"
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        />

        {/* Public form — no auth required */}
        <Route path="/f/:shareToken" element={<PublicFormPage />} />

        {/* Unreachable in practice — "/*" above already matches anything
            that isn't one of the explicit paths higher up (which rank
            higher regardless of declaration order). Kept only as a guard
            against a route ever being deleted from the "/*" branch without
            a replacement; the real in-app fallback lives in
            appRoutes.tsx's own catch-all. */}
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
