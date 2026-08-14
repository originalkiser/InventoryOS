import { useNavigate } from 'react-router-dom'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Card, CardBody, SbLoader, Button, Badge } from '@/components/ui'
import { useInventoryAlerts, type AlertGroup } from '@/hooks/useInventoryAlerts'

export function InventoryAlertsPage() {
  const { groups, count, loaded, loading, reload } = useInventoryAlerts()
  const navigate = useNavigate()

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-[#C0392B]" /> Inventory Alerts
          </h1>
          <p className="text-xs text-inky mt-0.5">Configuration gaps across shops. {count > 0 ? `${count} alert${count !== 1 ? 's' : ''} to review.` : 'All clear.'}</p>
        </div>
        <Button size="sm" variant="secondary" onClick={reload} disabled={loading}>
          <RefreshCw className={`w-3.5 h-3.5 mr-1 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </div>

      {!loaded && loading ? (
        <div className="py-12 flex justify-center"><SbLoader size={40} /></div>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((g) => <AlertGroupCard key={g.key} group={g} onOpenShop={(id) => navigate(`/location-lookup?shop=${id}`)} />)}
        </div>
      )}
    </div>
  )
}

function AlertGroupCard({ group, onOpenShop }: { group: AlertGroup; onOpenShop: (id: string) => void }) {
  const empty = group.shops.length === 0
  return (
    <Card className={empty ? '' : 'border-[#C0392B]/40'}>
      <CardBody className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <span className="text-sm font-heading font-bold text-navy">{group.title}</span>
          <Badge color={empty ? 'green' : 'red'}>{group.shops.length}</Badge>
        </div>
        {group.hint && <p className="text-[11px] font-mono text-inky/60">{group.hint}</p>}
        {empty ? (
          <p className="text-xs font-mono text-inky/50">No shops flagged. 🎉</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {group.shops.map((s) => (
              <button key={s.id} onClick={() => onOpenShop(s.id)} title={`${s.label} — ${s.detail} (open in Location Lookup)`}
                className="inline-flex items-center gap-1.5 rounded-full border border-navy/15 bg-navy/[0.03] hover:bg-navy/[0.07] px-2 py-0.5 text-[11px] font-mono text-navy">
                {s.label}<span className="text-inky/50">· {s.detail}</span>
              </button>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  )
}
