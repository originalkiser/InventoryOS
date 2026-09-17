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
import { PublicFormPage } from '@/pages/PublicFormPage'
import { PublicFranchiseMenuBoardPage } from '@/pages/PublicFranchiseMenuBoardPage'
import { PublicFranchiseSetupPage } from '@/pages/PublicFranchiseSetupPage'
import { PublicMenuBoardPage } from '@/modules/marketing/menuboard/PublicMenuBoardPage'
import { MenuBoardPdfPage } from '@/modules/marketing/menuboard/MenuBoardPdfPage'
import { NearestMenuBoardPage } from '@/modules/marketing/menuboard/NearestMenuBoardPage'

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

// The public menu board lives on its own subdomain (menu.sboc.app) rather
// than under a /menu-board/ path on the main app domain — a bare hostname
// check, not a route, since a bare "/:slug" pattern registered on the main
// domain would collide with every real app route ("/dashboard", "/tasks",
// etc). This is its own tiny router with nothing else in it: no auth, no
// AppShell, no admin routes reachable here at all.
function isMenuBoardHost(): boolean {
  return window.location.hostname.startsWith('menu.')
}

function MenuBoardApp() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Bare root — no specific shop link, so resolve one via the
            visitor's geolocation (falls back to a manual picker). */}
        <Route path="/" element={<NearestMenuBoardPage />} />
        {/* Legacy links minted before pretty slugs existed. */}
        <Route path="/m/:token" element={<PublicMenuBoardPage />} />
        <Route path="/:slug/pdf" element={<MenuBoardPdfPage />} />
        <Route path="/:slug" element={<PublicMenuBoardPage />} />
        <Route path="*" element={
          <div className="min-h-screen flex items-center justify-center bg-sb-navy px-6">
            <p className="text-sm font-mono text-sb-cream/80 text-center">This menu board link is no longer active.</p>
          </div>
        } />
      </Routes>
    </BrowserRouter>
  )
}

// Public forms with a custom, memorable URL (forms.sboc.app/:slug) instead
// of the always-random /f/:shareToken link on the main app domain — same
// hostname-check pattern as MenuBoardApp above, and for the same reason: a
// bare "/:slug" route on the main domain would collide with every other
// real app route. Requires forms.sboc.app to actually be added as a custom
// domain on this same Cloudflare Pages project (+ its own DNS CNAME),
// mirroring however menu.sboc.app was originally set up — this file alone
// can't provision that.
function isFormsHost(): boolean {
  return window.location.hostname.startsWith('forms.')
}

function FormsApp() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/:slug" element={<PublicFormPage />} />
        <Route path="*" element={
          <div className="min-h-screen flex items-center justify-center bg-navy px-6">
            <p className="text-sm font-mono text-cream/80 text-center">This form link is no longer active.</p>
          </div>
        } />
      </Routes>
    </BrowserRouter>
  )
}

// Blank franchise menu boards (fzmenu.sboc.app/:slug) — same hostname-check
// pattern as MenuBoardApp/FormsApp above, and its own subdomain rather than
// a menu.sboc.app path so these never mix with the regular Shop Links
// system at all (different table, different RPC, always locked to one
// shop with page 2 always hidden). Requires fzmenu.sboc.app to be added as
// its own Cloudflare Pages custom domain + DNS record before it resolves —
// see CLAUDE.md's Deployment notes; this file alone can't provision that.
function isFzMenuHost(): boolean {
  return window.location.hostname.startsWith('fzmenu.')
}

function FzMenuApp() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Franchisee self-service setup (2026-09-18 follow-up) — a
            reusable, open (not shop-locked) link handed directly to a
            franchisee so they can build their own board with no SB Net
            login. Lives on this same subdomain under its own path prefix
            rather than a whole new subdomain, since that would mean a
            second manual Cloudflare/DNS setup step for identical
            infrastructure. A distinct 2-segment path shape from "/:slug"
            below, so there's no route-matching ambiguity between the two. */}
        <Route path="/setup/:token" element={<PublicFranchiseSetupPage />} />
        <Route path="/:slug" element={<PublicFranchiseMenuBoardPage />} />
        <Route path="*" element={
          <div className="min-h-screen flex items-center justify-center bg-sb-navy px-6">
            <p className="text-sm font-mono text-sb-cream/80 text-center">This menu board link is no longer active.</p>
          </div>
        } />
      </Routes>
    </BrowserRouter>
  )
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

  if (isMenuBoardHost()) return <MenuBoardApp />
  if (isFzMenuHost()) return <FzMenuApp />
  if (isFormsHost()) return <FormsApp />

  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <AuthProvider />
      <UpdateBanner />
      <ImportPreviewHost />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />

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
