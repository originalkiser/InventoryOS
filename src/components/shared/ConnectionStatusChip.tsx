import { useEffect, useState } from 'react'
import { getConnectionConfig, type DataConnection } from '@/lib/dataConnections'
import { NavLink } from 'react-router-dom'

interface ConnectionStatusChipProps {
  connectionKey: string
  showLink?: boolean
}

export function ConnectionStatusChip({ connectionKey, showLink = true }: ConnectionStatusChipProps) {
  const [conn, setConn] = useState<DataConnection | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getConnectionConfig(connectionKey)
      .then(setConn)
      .finally(() => setLoading(false))
  }, [connectionKey])

  if (loading) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-mono text-inky/40">
        <span className="w-1.5 h-1.5 rounded-full bg-inky/30 animate-pulse" />
        Checking…
      </span>
    )
  }

  if (!conn) return null

  const ready = conn.is_configured && conn.last_test_status === 'success'
  const configured = conn.is_configured
  const failed = conn.is_configured && conn.last_test_status === 'failed'

  const dot = ready
    ? 'bg-green-500'
    : failed
    ? 'bg-amber-400'
    : 'bg-inky/30'

  const label = ready
    ? `${conn.connection_name} — connected`
    : failed
    ? `${conn.connection_name} — needs attention`
    : `${conn.connection_name} — not configured`

  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] font-mono text-inky">
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dot}`} />
      <span>{label}</span>
      {!configured && showLink && (
        <NavLink to="/dev-hub" className="underline hover:text-navy ml-0.5">
          Configure →
        </NavLink>
      )}
    </span>
  )
}
