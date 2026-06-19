import { useEffect, useState } from 'react'
import { OrderConfigImportPanel } from '@/components/integrations/OrderConfigImportPanel'
import { getOrderConfig } from '@/services/orderConfigService'
import type { OrderConfigRow } from '@/types/integrations'

export function OrderConfigPage() {
  const [config, setConfig] = useState<OrderConfigRow[]>([])
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    try {
      const data = await getOrderConfig()
      setConfig(data)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Order Config</h1>
          <p className="text-xs text-inky mt-0.5">
            Manage product ordering parameters. Upload the shared XLSX to sync changes.
          </p>
        </div>
      </div>

      <OrderConfigImportPanel />

      {/* Current Config Table */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="font-heading text-sm uppercase tracking-wider text-navy">Current Config</h2>
          <button onClick={load} className="text-xs font-mono text-sky hover:underline">Refresh</button>
        </div>

        {loading ? (
          <p className="text-xs font-mono text-inky/40 py-6 text-center">Loading…</p>
        ) : config.length === 0 ? (
          <p className="text-xs font-mono text-inky/40 py-6 text-center">
            No config loaded yet. Upload an XLSX file above to import.
          </p>
        ) : (
          <div className="overflow-x-auto border border-inky/20 rounded">
            <table className="w-full text-xs font-mono border-collapse">
              <thead>
                <tr className="border-b-2 border-inky/20 bg-inky/5">
                  <th className="text-left px-3 py-2 font-heading text-xs uppercase tracking-wider text-inky/60">Product</th>
                  <th className="text-left px-3 py-2 font-heading text-xs uppercase tracking-wider text-inky/60">SKU</th>
                  <th className="text-left px-3 py-2 font-heading text-xs uppercase tracking-wider text-inky/60">UOM</th>
                  <th className="text-right px-3 py-2 font-heading text-xs uppercase tracking-wider text-inky/60">Trigger</th>
                  <th className="text-right px-3 py-2 font-heading text-xs uppercase tracking-wider text-inky/60">Min Order</th>
                  <th className="text-left px-3 py-2 font-heading text-xs uppercase tracking-wider text-inky/60">Shops</th>
                </tr>
              </thead>
              <tbody>
                {config.map((row, i) => (
                  <tr
                    key={row.id ?? i}
                    className={['border-b border-inky/10', i % 2 === 0 ? '' : 'bg-inky/5'].join(' ')}
                  >
                    <td className="px-3 py-2 text-navy font-bold">{row.product_name}</td>
                    <td className="px-3 py-2 text-inky/60">{row.sku ?? '—'}</td>
                    <td className="px-3 py-2">{row.uom}</td>
                    <td className="px-3 py-2 text-right">{row.trigger_qty}</td>
                    <td className="px-3 py-2 text-right">{row.min_order_qty}</td>
                    <td className="px-3 py-2 text-inky/60">{row.shop_ids?.join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
