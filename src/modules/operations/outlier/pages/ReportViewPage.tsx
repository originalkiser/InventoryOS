import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { ClipboardPaste } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { isAdminOrDeveloper } from '@/lib/roles'
import { useWeek } from '../WeekContext'
import { Report, ReportEntry, Week, ParsedRow } from '../types'
import { toDateString, getThisWeekFriday } from '../lib/weekUtils'
import ReportTable from '../components/tables/ReportTable'
import PasteModal from '../components/paste/PasteModal'
import toast from 'react-hot-toast'

export default function ReportViewPage() {
  const { slug } = useParams<{ slug: string }>()
  const { profile } = useAuthStore()
  const { weekStartStr, weekEndStr } = useWeek()

  const sb = supabase as any

  const role = profile?.role as string | undefined
  const canPaste = isAdminOrDeveloper(role) || role === 'department_user'
  const isAM = role === 'area_manager'

  const [report, setReport] = useState<Report | null>(null)
  const [currentWeek, setCurrentWeek] = useState<Week | null>(null)
  const [entries, setEntries] = useState<ReportEntry[]>([])
  const [allEntries, setAllEntries] = useState<ReportEntry[]>([])
  const [allWeeks, setAllWeeks] = useState<Week[]>([])
  const [loading, setLoading] = useState(true)
  const [showPaste, setShowPaste] = useState(false)
  const [flashedIds, setFlashedIds] = useState<Set<string>>(new Set())
  const [realtimeConnected, setRealtimeConnected] = useState(false)
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null)

  const loadData = useCallback(async () => {
    if (!slug) return
    setLoading(true)

    // Load report
    const { data: reportData } = await sb.schema('outlier').from('reports')
      .select('*, department:departments(*)')
      .eq('slug', slug)
      .single()

    if (!reportData) { setLoading(false); return }
    setReport(reportData as Report)

    // Get or create current week
    const { data: weekData } = await sb.schema('outlier').from('weeks')
      .select('*')
      .eq('week_start', weekStartStr)
      .single()

    setCurrentWeek(weekData ?? null)

    if (weekData) {
      // Load entries for this week
      const { data: entriesData } = await sb.schema('outlier').from('report_entries')
        .select('*')
        .eq('report_id', reportData.id)
        .eq('week_id', weekData.id)
      setEntries((entriesData ?? []) as ReportEntry[])
    } else {
      setEntries([])
    }

    // Load all entries for streak calc
    const { data: allE } = await sb.schema('outlier').from('report_entries')
      .select('*')
      .eq('report_id', reportData.id)
    setAllEntries((allE ?? []) as ReportEntry[])

    // Load all weeks
    const { data: weeksData } = await sb.schema('outlier').from('weeks')
      .select('*')
      .order('week_start', { ascending: false })
    setAllWeeks((weeksData ?? []) as Week[])

    setLoading(false)
  }, [slug, weekStartStr])

  useEffect(() => { loadData() }, [loadData])

  // Realtime subscription
  useEffect(() => {
    if (!report || !currentWeek) return

    if (channelRef.current) {
      supabase.removeChannel(channelRef.current)
    }

    const channel = supabase
      .channel(`outlier-entries:${report.id}:${currentWeek.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'outlier',
          table: 'report_entries',
          filter: `report_id=eq.${report.id}`,
        },
        (payload) => {
          const updated = payload.new as ReportEntry
          if (!updated || updated.week_id !== currentWeek.id) return
          setEntries(prev => {
            const idx = prev.findIndex(e => e.id === updated.id)
            if (idx >= 0) {
              const next = [...prev]
              next[idx] = updated
              return next
            }
            return [...prev, updated]
          })
          setFlashedIds(prev => new Set(prev).add(updated.id))
          setTimeout(() => {
            setFlashedIds(prev => {
              const next = new Set(prev)
              next.delete(updated.id)
              return next
            })
          }, 1500)
        }
      )
      .subscribe(status => {
        setRealtimeConnected(status === 'SUBSCRIBED')
      })

    channelRef.current = channel
    return () => { supabase.removeChannel(channel) }
  }, [report?.id, currentWeek?.id])

  async function handleCommit(rows: ParsedRow[], weekId: string) {
    if (!report) return

    // Ensure week exists
    let wId = weekId
    if (!currentWeek) {
      const { data: newWeek, error: wErr } = await sb.schema('outlier').from('weeks')
        .upsert({
          week_start: weekStartStr,
          week_end: weekEndStr,
          label: `Week of ${weekStartStr}`,
        }, { onConflict: 'week_start' })
        .select()
        .single()
      if (wErr) throw wErr
      wId = newWeek.id
      setCurrentWeek(newWeek)
    }

    const defaultDue = toDateString(getThisWeekFriday())

    const upsertData = rows.map(row => ({
      report_id: report.id,
      week_id: wId,
      row_key: row.row_key,
      row_label: row.row_label,
      row_type: row.row_type,
      data: row.data,
      due_date: (row.data.due_date as string) ?? defaultDue,
      submitted_by: profile?.id,
      updated_at: new Date().toISOString(),
    }))

    const { error } = await sb.schema('outlier').from('report_entries')
      .upsert(upsertData, { onConflict: 'report_id,week_id,row_key' })

    if (error) throw error

    // Log paste
    await sb.schema('outlier').from('paste_logs').insert({
      report_id: report.id,
      week_id: wId,
      parsed_row_count: rows.length,
      submitted_by: profile?.id,
    })

    toast.success(`${rows.length} rows imported`)
    await loadData()
  }

  async function handleCommentChange(id: string, comment: string) {
    const { error } = await sb.schema('outlier').from('report_entries')
      .update({
        am_comment: comment,
        am_comment_updated_at: new Date().toISOString(),
        am_comment_updated_by: profile?.id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
    if (error) toast.error('Failed to save comment')
  }

  async function handleDueDateChange(id: string, date: string) {
    const { error } = await sb.schema('outlier').from('report_entries')
      .update({ due_date: date, updated_at: new Date().toISOString() })
      .eq('id', id)
    if (error) toast.error('Failed to save due date')
  }

  async function handleCompleteToggle(id: string, val: boolean) {
    const { error } = await sb.schema('outlier').from('report_entries')
      .update({ is_complete: val, updated_at: new Date().toISOString() })
      .eq('id', id)
    if (error) toast.error('Failed to update')
    else toast.success(val ? 'Marked complete' : 'Marked incomplete')
  }

  if (loading) {
    return (
      <div className="p-8 space-y-3">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="h-9 bg-sb-inky/20 rounded animate-pulse" />
        ))}
      </div>
    )
  }

  if (!report) {
    return (
      <div className="p-8">
        <p className="font-mono text-sb-cream/40">Report not found.</p>
      </div>
    )
  }

  return (
    <div>
      {/* Report header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-sb-inky/30">
        <div>
          <h1 className="font-brand font-bold text-sb-cream text-[16px] tracking-wider uppercase">
            {report.name}
          </h1>
          {report.department && (
            <span className="font-mono text-[11px] text-sb-inky">{report.department.name}</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {realtimeConnected && (
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-sb-sky live-pulse" />
              <span className="font-mono text-[10px] text-sb-sky tracking-widest">LIVE</span>
            </div>
          )}
          {canPaste && (
            <button
              onClick={() => setShowPaste(true)}
              className="flex items-center gap-2 bg-sb-sky text-sb-navy font-brand font-bold text-[12px] tracking-wider px-3 py-2 rounded hover:brightness-105 transition"
            >
              <ClipboardPaste size={14} />
              PASTE DATA
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <ReportTable
        entries={entries}
        allEntries={allEntries}
        allWeeks={allWeeks}
        currentWeekId={currentWeek?.id ?? ''}
        columns={report.columns}
        isEmployeeReport={report.is_employee_report}
        flashedIds={flashedIds}
        onCommentChange={isAM || canPaste ? handleCommentChange : undefined}
        onDueDateChange={isAM || canPaste ? handleDueDateChange : undefined}
        onCompleteToggle={isAM || canPaste ? handleCompleteToggle : undefined}
        editableByAM={isAM || canPaste}
      />

      {showPaste && currentWeek !== undefined && (
        <PasteModal
          report={report}
          currentWeek={currentWeek}
          existingEntries={entries}
          onClose={() => setShowPaste(false)}
          onCommit={handleCommit}
        />
      )}
    </div>
  )
}
