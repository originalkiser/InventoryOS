import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { canAddOutlierNotes } from '@/lib/roles'
import toast from 'react-hot-toast'

interface OutlierReport {
  id: string
  name: string
  description?: string
  created_at: string
  [key: string]: unknown
}

interface OutlierDept {
  id: string
  name: string
}

export function OutlierDeptPage() {
  const { deptId } = useParams<{ deptId: string }>()
  const { profile } = useAuthStore()
  const canNote = canAddOutlierNotes(profile?.role)

  const [dept, setDept] = useState<OutlierDept | null>(null)
  const [reports, setReports] = useState<OutlierReport[]>([])
  const [loading, setLoading] = useState(true)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [savingNote, setSavingNote] = useState<string | null>(null)

  useEffect(() => {
    if (!deptId) return
    load()
  }, [deptId])

  async function load() {
    setLoading(true)
    const sb = supabase as any
    const [deptRes, reportsRes] = await Promise.all([
      sb.schema('outlier').from('departments').select('id, name').eq('id', deptId).maybeSingle(),
      sb.schema('outlier').from('reports').select('*').eq('department_id', deptId).order('name'),
    ])
    if (deptRes.data) setDept(deptRes.data)
    setReports(reportsRes.data ?? [])
    setLoading(false)
  }

  async function saveNote(reportId: string) {
    const note = notes[reportId] ?? ''
    setSavingNote(reportId)
    const sb = supabase as any
    const { error } = await sb.schema('outlier').from('report_notes').upsert({
      report_id: reportId,
      author_id: profile?.id,
      note,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'report_id,author_id' })
    setSavingNote(null)
    if (error) toast.error(error.message)
    else toast.success('Note saved')
  }

  if (loading) {
    return (
      <div className="p-6">
        <div className="text-xs font-mono text-inky/50 animate-pulse">Loading…</div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-lg font-heading font-bold text-navy dark:text-cream uppercase tracking-wide">
          {dept?.name ?? 'Department'}
        </h1>
        <p className="text-xs text-inky mt-0.5">OutlierOS reporting</p>
      </div>

      {reports.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-sm font-body text-inky/40">No reports in this department.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {reports.map((report) => (
            <div key={report.id} className="rounded border border-navy/15 bg-cream dark:bg-navy/20 p-4 flex flex-col gap-3">
              <div className="text-sm font-heading text-navy dark:text-cream font-semibold">{report.name}</div>
              {report.description && (
                <p className="text-xs font-body text-inky dark:text-[#F2F1E6]/70">{String(report.description)}</p>
              )}
              {canNote && (
                <div className="flex flex-col gap-1.5 pt-2 border-t border-navy/10">
                  <label className="text-[10px] font-heading text-inky uppercase tracking-wide">Your Note</label>
                  <div className="flex gap-2">
                    <textarea
                      value={notes[report.id] ?? ''}
                      onChange={(e) => setNotes((p) => ({ ...p, [report.id]: e.target.value }))}
                      rows={2}
                      placeholder="Add a note…"
                      className="flex-1 rounded border border-navy/20 bg-cream dark:bg-navy/30 px-3 py-2 text-xs font-body text-navy dark:text-cream placeholder-inky/40 focus:border-sky focus:outline-none resize-none"
                    />
                    <button
                      onClick={() => saveNote(report.id)}
                      disabled={savingNote === report.id || !notes[report.id]?.trim()}
                      className="self-end px-3 py-1.5 rounded border border-navy/20 text-xs font-mono text-inky hover:border-navy/40 disabled:opacity-40 transition-colors"
                    >
                      {savingNote === report.id ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
