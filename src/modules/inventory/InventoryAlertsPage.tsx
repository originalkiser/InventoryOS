import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Card, CardBody, SbLoader, Button, Badge } from '@/components/ui'
import { useInventoryAlerts, type AlertGroup } from '@/hooks/useInventoryAlerts'

export function InventoryAlertsPage() {
  const { groups, ignoredGroups, count, ignoredCount, loaded, loading, reload, ignore, unignore } = useInventoryAlerts()
  const navigate = useNavigate()
  const [showIgnored, setShowIgnored] = useState(false)

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
          {groups.map((g) => (
            <AlertGroupCard key={g.key} group={g}
              onOpenShop={(id) => navigate(`/location-lookup?shop=${id}`)}
              onIgnore={(id) => ignore(g.key, id)} />
          ))}

          {ignoredCount > 0 && (
            <div className="flex flex-col gap-2">
              <button onClick={() => setShowIgnored((o) => !o)} className="self-start text-[11px] font-mono uppercase tracking-widest text-inky/60 hover:text-navy">
                Ignored Alerts ({ignoredCount}) {showIgnored ? '▾' : '▸'}
              </button>
              {showIgnored && ignoredGroups.map((g) => (
                <Card key={g.key}>
                  <CardBody className="flex flex-col gap-2">
                    <span className="text-xs font-heading font-bold text-inky/70">{g.title}</span>
                    <div className="flex flex-wrap gap-1.5">
                      {g.shops.map((s) => (
                        <span key={s.id} className="inline-flex items-center gap-1.5 rounded-full border border-navy/15 bg-navy/[0.03] px-2 py-0.5 text-[11px] font-mono text-inky/70">
                          {s.label}<span className="text-inky/40">· {s.detail}</span>
                          <button onClick={() => unignore(g.key, s.id)} title="Restore this alert" className="text-inky/50 hover:text-navy">↺</button>
                        </span>
                      ))}
                    </div>
                  </CardBody>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function AlertGroupCard({ group, onOpenShop, onIgnore }: { group: AlertGroup; onOpenShop: (id: string) => void; onIgnore: (id: string) => void }) {
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
              <span key={s.id} className="inline-flex items-center gap-1.5 rounded-full border border-navy/15 bg-navy/[0.03] hover:bg-navy/[0.07] pl-2 pr-1 py-0.5 text-[11px] font-mono text-navy">
                <button onClick={() => onOpenShop(s.id)} title={`Open ${s.label} in Location Lookup`} className="inline-flex items-center gap-1.5">
                  {s.label}<span className="text-inky/50">· {s.detail}</span>
                </button>
                <button onClick={() => onIgnore(s.id)} title="Ignore this alert" className="text-inky/40 hover:text-[#C0392B] pl-0.5">✕</button>
              </span>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  )
}
