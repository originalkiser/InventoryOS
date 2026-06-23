import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'

interface Dept { id: string; name: string; description?: string }

export function OutlierPage() {
  const navigate = useNavigate()
  const [depts, setDepts] = useState<Dept[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    ;(supabase as any).schema('outlier').from('departments').select('id, name, description').order('name')
      .then(({ data, error: err }: any) => {
        if (err) setError(true)
        else setDepts(data ?? [])
        setLoading(false)
      })
  }, [])

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-bold text-navy dark:text-cream tracking-wide uppercase">OutlierOS</h1>
        <p className="text-xs text-inky/70 dark:text-[#F2F1E6]/50 mt-0.5">Operations reporting by department</p>
      </div>

      {loading && (
        <div className="text-xs font-mono text-inky/50 animate-pulse">Loading departments…</div>
      )}

      {!loading && error && (
        <div className="rounded border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/10 px-4 py-3 text-xs font-mono text-red-600 dark:text-red-400">
          Could not connect to OutlierOS. Make sure the <code>outlier</code> schema is configured in Supabase.
        </div>
      )}

      {!loading && !error && depts.length === 0 && (
        <div className="text-center py-16">
          <p className="text-sm font-body text-inky/40 dark:text-[#F2F1E6]/30">No departments found.</p>
          <p className="text-xs font-mono text-inky/30 dark:text-[#F2F1E6]/20 mt-1">Add rows to the <code>outlier.departments</code> table to get started.</p>
        </div>
      )}

      {!loading && depts.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {depts.map((d) => (
            <button
              key={d.id}
              onClick={() => navigate(`/operations/outlier/${d.id}`)}
              className="text-left rounded border border-navy/15 dark:border-[#F2F1E6]/10 bg-cream dark:bg-navy/20 p-5 hover:border-sky hover:bg-sky/5 transition-colors flex flex-col gap-1.5"
            >
              <div className="text-sm font-heading font-semibold text-navy dark:text-cream">{d.name}</div>
              {d.description && (
                <div className="text-xs font-body text-inky/60 dark:text-[#F2F1E6]/50 leading-relaxed">{d.description}</div>
              )}
              <div className="mt-1 text-[10px] font-mono text-sky">View reports →</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
