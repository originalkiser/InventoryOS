import { Link } from 'react-router-dom'
import sbDroplet from '@/assets/SBOC-IconNavy.png'
import { Button } from '@/components/ui'

// SB-branded replacement for the silent `<Navigate to="/dashboard" replace />`
// appRoutes.tsx used to fall back to for any unmatched in-app path — that
// bounced someone off a stale/broken link straight to the dashboard with no
// explanation at all. This is the in-app 404: it does NOT touch
// dist/404.html (the static host-level fallback that lets GitHub Pages/
// Cloudflare serve a deep link at all — see vite.config.ts's spa404Plugin
// comment) — that file still has to stay an exact copy of the real app
// shell so React Router can take over from a nonexistent physical path.
// This only covers the case where the app DID mount and React Router
// itself found no matching route.
export function NotFoundPage() {
  return (
    <div className="min-h-screen bg-cream flex items-center justify-center font-body px-6">
      <div className="flex flex-col items-center text-center gap-4 max-w-sm">
        <img src={sbDroplet} alt="" className="w-16 h-auto opacity-90" />
        <div className="flex flex-col gap-1">
          <p className="font-heading text-5xl font-bold text-navy tracking-wide">404</p>
          <p className="font-heading text-sm font-bold text-navy uppercase tracking-wide">Page not found</p>
        </div>
        <p className="text-xs text-inky leading-relaxed">
          This link doesn't match anything in SB Net — it may be out of date, or the page may have moved.
        </p>
        <Link to="/dashboard">
          <Button size="sm">Back to Dashboard</Button>
        </Link>
      </div>
    </div>
  )
}
