// Public, no-auth landing page for menu.sboc.app's bare root — resolves to
// the nearest Strickland Brothers shop's board using the visitor's browser
// geolocation, or a manual shop picker if location access is denied,
// unavailable, or no shop has coordinates. Data comes from the
// get_menu_board_shop_list RPC (SECURITY DEFINER) — every active shop's
// share slug + coordinates; nothing keyed by a specific token since there's
// no share link to anchor this to yet (unlike every other public page in
// this module).

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { Combobox, SbLoader, Button } from '@/components/ui'
import { byNaturalLabel } from '@/lib/naturalSort'

const sb = () => supabase as any

interface ShopEntry {
  slug: string
  name: string | null
  shop_city: string | null
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  latitude: number | null
  longitude: number | null
}

// Standard great-circle distance — only used to RANK shops by proximity,
// so approximation error here doesn't matter.
function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export function NearestMenuBoardPage() {
  const navigate = useNavigate()
  const [shops, setShops] = useState<ShopEntry[] | null>(null)
  const [status, setStatus] = useState<'locating' | 'pick' | 'error'>('locating')
  const [selectedSlug, setSelectedSlug] = useState('')

  useEffect(() => {
    let cancelled = false

    async function run() {
      const { data, error } = await sb().rpc('get_menu_board_shop_list')
      if (cancelled) return
      if (error || !Array.isArray(data)) { setStatus('error'); return }
      const list = data as ShopEntry[]
      setShops(list)

      if (!('geolocation' in navigator)) { setStatus('pick'); return }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (cancelled) return
          const { latitude, longitude } = pos.coords
          const withCoords = list.filter((s) => s.latitude != null && s.longitude != null)
          if (withCoords.length === 0) { setStatus('pick'); return }
          let nearest = withCoords[0]
          let nearestDist = haversineMiles(latitude, longitude, nearest.latitude!, nearest.longitude!)
          for (const s of withCoords.slice(1)) {
            const d = haversineMiles(latitude, longitude, s.latitude!, s.longitude!)
            if (d < nearestDist) { nearest = s; nearestDist = d }
          }
          navigate(`/${nearest.slug}`, { replace: true })
        },
        () => { if (!cancelled) setStatus('pick') },
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 5 * 60 * 1000 },
      )
    }

    run().catch(() => { if (!cancelled) setStatus('error') })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const shopOptions = useMemo(() => (shops ?? []).map((s) => {
    const addr = [s.address, s.city, s.state].filter(Boolean).join(', ')
    return { value: s.slug, label: addr ? `${s.shop_city || s.name} — ${addr}` : (s.shop_city || s.name || s.slug) }
  }).sort(byNaturalLabel), [shops])

  if (status === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-sb-navy px-6">
        <p className="text-sm font-mono text-sb-cream/80 text-center">Couldn't load shop locations. Try again in a moment.</p>
      </div>
    )
  }

  if (status === 'locating') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-sb-navy px-6">
        <SbLoader size={40} />
        <p className="text-sm font-mono text-sb-cream/80 text-center">Finding your nearest Strickland Brothers…</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-sb-navy px-6">
      <div className="w-full max-w-sm flex flex-col gap-3">
        <p className="text-sm font-mono text-sb-cream/80 text-center">
          Couldn't use your location — pick your shop below.
        </p>
        <Combobox
          options={shopOptions} value={selectedSlug} onChange={setSelectedSlug}
          placeholder="Search by shop, address, or city…"
        />
        <Button
          disabled={!selectedSlug}
          onClick={() => navigate(`/${selectedSlug}`, { replace: true })}
          className="w-full justify-center"
        >
          View menu board
        </Button>
      </div>
    </div>
  )
}
