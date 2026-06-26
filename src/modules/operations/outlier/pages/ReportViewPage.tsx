import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ClipboardPaste, ArrowLeft, Settings } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { isAdminOrDeveloper } from '@/lib/roles'
import { useCustomFields } from '@/hooks/useCustomFields'
import { useWeek } from '../WeekContext'
import { Report, ReportEntry, Week, ParsedRow } from '../types'
import { toDateString, getThisWeekFriday } from '../lib/weekUtils'
import ReportTable from '../components/tables/ReportTable'
import PasteModal from '../components/paste/PasteModal'
import toast from 'react-hot-toast'

export default function ReportViewPage() {
  const { slug } = useParams<{ slug: string }>()
  const navigate = useNavigate()
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
  const [showFieldMap, setShowFieldMap] = useState(false)
  const [flashedIds, setFlashedIds] = useState<Set<string>>(new Set())
  const [realtimeConnected, setRealtimeConnected] = useState(false)
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null)
  const [appUsers, setAppUsers] = useState<{ id: string; full_name: string | null; email: string }[]>([])

  // Location custom fields — used to populate the AM/RDO field mapping dropdowns
  const { active: locationFields } = useCustomFields('locations')

  useEffect(() => {
    if (!profile?.company_id) return
    ;(sb as any).schema('platform').from('user_profiles')
      .select('id, full_name, email')
      .eq('company_id', profile.company_id)
      .is('deleted_at', null)
      .order('full_name')
      .then(({ data }: any) => { if (data) setAppUsers(data) })
  }, [profile?.company_id])

  const loadData = useCallback(async () => {
    if (!slug) return
    setLoading(true)

    const { data: reportData } = await sb.schema('outlier').from('reports')
      .select('*, department:departments(*)')
      .eq('slug', slug)
      .single()

    if (!reportData) { setLoading(false); return }
    setReport(reportData as Report)

    const { data: weekData } = await sb.schema('outlier').from('weeks')
      .select('*')
      .eq('week_start', weekStartStr)
      .single()

    setCurrentWeek(weekData ?? null)

    if (weekData) {
      const { data: entriesData } = await sb.schema('outlier').from('report_entries')
        .select('*')
        .eq('report_id', reportData.id)
        .eq('week_id', weekData.id)
      setEntries((entriesData ?? []) as ReportEntry[])
    } else {
      setEntries([])
    }

    const { data: allE } = await sb.schema('outlier').from('report_entries')
      .select('*')
      .eq('report_id', reportData.id)
    setAllEntries((allE ?? []) as ReportEntry[])

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

    if (channelRef.current) supabase.removeChannel(channelRef.current)

    const channel = supabase
      .channel(`outlier-entries:${report.id}:${currentWeek.id}`)
      .on('postgres_changes', {
        event: '*', schema: 'outlier', table: 'report_entries',
        filter: `report_id=eq.${report.id}`,
      }, (payload) => {
        const updated = payload.new as ReportEntry
        if (!updated || updated.week_id !== currentWeek.id) return
        setEntries(prev => {
          const idx = prev.findIndex(e => e.id === updated.id)
          if (idx >= 0) { const next = [...prev]; next[idx] = updated; return next }
          return [...prev, updated]
        })
        setFlashedIds(prev => new Set(prev).add(updated.id))
        setTimeout(() => {
          setFlashedIds(prev => { const next = new Set(prev); next.delete(updated.id); return next })
        }, 1500)
      })
      .subscribe(status => setRealtimeConnected(status === 'SUBSCRIBED'))

    channelRef.current = channel
    return () => { supabase.removeChannel(channel) }
  }, [report?.id, currentWeek?.id])

  async function saveFieldMap(amField: string, rdoField: string) {
    if (!report) return
    const { error } = await sb.schema('outlier').from('reports')
      .update({ am_location_field: amField, rdo_location_field: rdoField })
      .eq('id', report.id)
    if (error) { toast.error('Failed to save field mapping'); return }
    setReport(r => r ? { ...r, am_location_field: amField, rdo_location_field: rdoField } : r)
    toast.success('Field mapping saved')
    setShowFieldMap(false)
  }

  async function handleCommit(rows: ParsedRow[], weekId: string) {
    if (!report) return

    let wId = weekId
    if (!currentWeek) {
      const { data: newWeek, error: wErr } = await sb.schema('outlier').from('weeks')
        .upsert({ week_start: weekStartStr, week_end: weekEndStr, label: `Week of ${weekStartStr}` }, { onConflict: 'week_start' })
        .select().single()
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

    console.log('[Outlier Push] upserting', upsertData.length, 'entries')
    const { error } = await sb.schema('outlier').from('report_entries')
      .upsert(upsertData, { onConflict: 'report_id,week_id,row_key' })

    if (error) {
      console.error('[Outlier Push] upsert error:', error)
      throw new Error(`${error.message} (code: ${error.code ?? 'n/a'}, hint: ${error.hint ?? 'n/a'})`)
    }

    const { data: pushedEntries } = await sb.schema('outlier').from('report_entries')
      .select('id, row_key')
      .eq('report_id', report.id)
      .eq('week_id', wId)
      .in('row_key', rows.map(r => r.row_key))

    await sb.schema('outlier').from('paste_logs').insert({
      report_id: report.id,
      week_id: wId,
      parsed_row_count: rows.length,
      submitted_by: profile?.id,
    })

    toast.success(`${rows.length} rows imported`)
    await loadData()

    if (pushedEntries?.length) {
      enrichReportEntries(pushedEntries.map((e: any) => e.id)).catch(() => {})
    }
  }

  async function enrichReportEntries(entryIds: string[]) {
    if (!entryIds.length || !report) return

    const amField = report.am_location_field ?? 'area_manager'
    const rdoField = report.rdo_location_field ?? 'regional_director'

    const { data: entriesToEnrich } = await sb.schema('outlier').from('report_entries')
      .select('id, row_key, row_label, location_id')
      .in('id', entryIds)
      .is('location_id', null)

    if (!entriesToEnrich?.length) return

    const { data: locations } = await sb.schema('core').from('locations')
      .select('id, location_code, name, metadata')
      .eq('company_id', profile?.company_id)
      .or('active.eq.true,active.is.null')

    if (!locations?.length) return

    for (const entry of entriesToEnrich) {
      const codeDigits = String(entry.row_key ?? '').replace(/\D/g, '')
      const location = locations.find((loc: any) => {
        const locDigits = String(loc.location_code ?? '').replace(/\D/g, '')
        return locDigits && locDigits === codeDigits
      }) ?? locations.find((loc: any) => {
        const name = String(loc.name ?? '').toLowerCase()
        const label = String(entry.row_label ?? '').toLowerCase()
        return name === label || name.includes(label) || label.includes(name)
      })

      if (!location) continue

      const meta = (location.metadata as any) ?? {}

      // Pull AM from the configured field, with common-name fallbacks
      const amName: string | null =
        meta[amField] ??
        (amField !== 'area_manager' ? meta.area_manager : null) ??
        meta['Area Manager'] ??
        null

      // Pull RDO from the configured field, with common-name fallbacks
      const rdoName: string | null =
        meta[rdoField] ??
        (rdoField !== 'regional_director' ? meta.regional_director : null) ??
        meta['Regional Director'] ??
        meta.director ??
        meta['Director'] ??
        meta.rdo ??
        null

      await sb.schema('outlier').from('report_entries')
        .update({ location_id: location.id, area_manager_name: amName, rdo_name: rdoName })
        .eq('id', entry.id)
    }

    await loadData()
  }

  async function handleCommentChange(id: string, comment: string) {
    const { error } = await sb.schema('outlier').from('report_entries')
      .update({ am_comment: comment, updated_at: new Date().toISOString() })
      .eq('id', id)
    if (error) { console.error('[Comment save]', error); toast.error('Failed to save comment'); return }
    setEntries(prev => prev.map(e => e.id === id ? { ...e, am_comment: comment } : e))
    sb.schema('outlier').from('report_entries')
      .update({ am_comment_updated_at: new Date().toISOString(), am_comment_updated_by: profile?.id })
      .eq('id', id)
      .then(() => {})
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

  async function handleAMNameChange(id: string, name: string, userId?: string | null) {
    // Save the name first — this always works regardless of whether the
    // assignment columns exist in the current DB schema.
    const { error } = await sb.schema('outlier').from('report_entries')
      .update({ area_manager_name: name || null, updated_at: new Date().toISOString() })
      .eq('id', id)
    if (error) { toast.error('Failed to save area manager name'); return }
    setEntries(prev => prev.map(e => e.id === id ? { ...e, area_manager_name: name || null } : e))
    // Best-effort: also save user assignment (column may not exist in all envs yet)
    if (userId !== undefined) {
      sb.schema('outlier').from('report_entries')
        .update({ am_assigned_user_id: userId })
        .eq('id', id)
        .then(({ error: aErr }: any) => {
          if (!aErr) setEntries(prev => prev.map(e => e.id === id ? { ...e, am_assigned_user_id: userId } : e))
        })
    }
  }

  async function handleClearWeek() {
    if (!report || !currentWeek) return
    if (!window.confirm(`Delete all ${entries.length} entries for this week? This cannot be undone.`)) return
    const { error } = await sb.schema('outlier').from('report_entries')
      .delete()
      .eq('report_id', report.id)
      .eq('week_id', currentWeek.id)
    if (error) { toast.error('Failed to clear week'); return }
    toast.success('Week cleared — paste new data to start over')
    setEntries([])
  }

  async function handleAddReportColumns(newCols: import('../types').ColumnDef[]): Promise<import('../types').ColumnDef[]> {
    if (!report || !newCols.length) return report?.columns ?? []
    const merged = [...report.columns, ...newCols]
    const { error } = await sb.schema('outlier').from('reports')
      .update({ columns: merged })
      .eq('id', report.id)
    if (error) { toast.error('Failed to add columns'); return report.columns }
    setReport(r => r ? { ...r, columns: merged } : r)
    return merged
  }

  async function handleRDONameChange(id: string, name: string, userId?: string | null) {
    const { error } = await sb.schema('outlier').from('report_entries')
      .update({ rdo_name: name || null, updated_at: new Date().toISOString() })
      .eq('id', id)
    if (error) { toast.error('Failed to save regional director name'); return }
    setEntries(prev => prev.map(e => e.id === id ? { ...e, rdo_name: name || null } : e))
    if (userId !== undefined) {
      sb.schema('outlier').from('report_entries')
        .update({ rdo_assigned_user_id: userId })
        .eq('id', id)
        .then(({ error: rErr }: any) => {
          if (!rErr) setEntries(prev => prev.map(e => e.id === id ? { ...e, rdo_assigned_user_id: userId } : e))
        })
    }
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
      {/* Back */}
      <div className="px-6 pt-4">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-1.5 text-[11px] font-mono text-sb-inky hover:text-sb-cream transition-colors"
        >
          <ArrowLeft size={13} />
          Back
        </button>
      </div>

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
          {entries.length > 0 && (
            <button
              onClick={() => enrichReportEntries(entries.map(e => e.id))}
              className="flex items-center gap-1.5 font-mono text-[11px] text-sb-inky hover:text-sb-cream border border-sb-inky/40 hover:border-sb-inky px-2 py-1.5 rounded transition"
              title="Re-run AM / Regional Director lookup from location data"
            >
              ↺ Re-enrich
            </button>
          )}
          {entries.length > 0 && canPaste && (
            <button
              onClick={handleClearWeek}
              className="flex items-center gap-1.5 font-mono text-[11px] text-sb-red/70 hover:text-sb-red border border-sb-red/30 hover:border-sb-red/60 px-2 py-1.5 rounded transition"
              title="Delete all entries for this week and start over"
            >
              ✕ Clear week
            </button>
          )}
          {canPaste && !report.is_employee_report && (
            <button
              onClick={() => setShowFieldMap(v => !v)}
              className={`flex items-center gap-1.5 font-mono text-[11px] border px-2 py-1.5 rounded transition ${
                showFieldMap
                  ? 'text-sb-sky border-sb-sky/50'
                  : 'text-sb-inky border-sb-inky/40 hover:text-sb-cream hover:border-sb-inky'
              }`}
              title="Configure which location columns supply AM and Regional Director"
            >
              <Settings size={12} />
              Location fields
            </button>
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

      {/* Field mapping panel */}
      {showFieldMap && !report.is_employee_report && (
        <FieldMapPanel
          report={report}
          locationFields={locationFields}
          onSave={saveFieldMap}
          onClose={() => setShowFieldMap(false)}
        />
      )}

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
        onAMNameChange={canPaste ? handleAMNameChange : undefined}
        onRDONameChange={canPaste ? handleRDONameChange : undefined}
        appUsers={appUsers.length > 0 ? appUsers : undefined}
        editableByAM={isAM || canPaste}
      />

      {showPaste && currentWeek !== undefined && (
        <PasteModal
          report={report}
          currentWeek={currentWeek}
          existingEntries={entries}
          onClose={() => setShowPaste(false)}
          onCommit={handleCommit}
          onAddColumns={handleAddReportColumns}
        />
      )}
    </div>
  )
}

function FieldMapPanel({
  report,
  locationFields,
  onSave,
  onClose,
}: {
  report: Report
  locationFields: { field_key: string; label: string }[]
  onSave: (amField: string, rdoField: string) => Promise<void>
  onClose: () => void
}) {
  const [amField, setAmField] = useState(report.am_location_field ?? 'area_manager')
  const [rdoField, setRdoField] = useState(report.rdo_location_field ?? 'regional_director')
  const [saving, setSaving] = useState(false)

  // All keys to offer: well-known built-ins + whatever the company has defined
  const builtIn = [
    { field_key: 'area_manager', label: 'Area Manager' },
    { field_key: 'regional_director', label: 'Regional Director' },
    { field_key: 'director', label: 'Director' },
    { field_key: 'market', label: 'Market' },
  ]
  const allKeys = [
    ...builtIn,
    ...locationFields.filter(f => !builtIn.some(b => b.field_key === f.field_key)),
  ]

  async function handleSave() {
    setSaving(true)
    await onSave(amField, rdoField)
    setSaving(false)
  }

  return (
    <div className="mx-6 my-3 p-4 rounded border border-sb-sky/30 bg-sb-sky/5">
      <div className="flex items-center justify-between mb-3">
        <p className="font-brand font-bold text-sb-sky text-[11px] tracking-widest uppercase">
          Location Field Mapping
        </p>
        <button onClick={onClose} className="font-mono text-[11px] text-sb-inky hover:text-sb-cream">✕</button>
      </div>
      <p className="font-mono text-[11px] text-sb-cream/50 mb-3">
        Choose which field from your location list supplies the Area Manager and Regional Director when auto-enriching.
      </p>
      <div className="grid grid-cols-2 gap-4">
        <label className="flex flex-col gap-1">
          <span className="font-brand font-bold text-[10px] text-sb-inky tracking-widest uppercase">Area Manager from</span>
          <select
            value={amField}
            onChange={e => setAmField(e.target.value)}
            className="bg-sb-inky/20 text-sb-cream font-mono text-[12px] px-2 py-1.5 rounded border border-sb-inky/40 focus:outline-none focus:border-sb-sky"
          >
            {allKeys.map(f => (
              <option key={f.field_key} value={f.field_key}>{f.label} ({f.field_key})</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-brand font-bold text-[10px] text-sb-inky tracking-widest uppercase">Regional Director from</span>
          <select
            value={rdoField}
            onChange={e => setRdoField(e.target.value)}
            className="bg-sb-inky/20 text-sb-cream font-mono text-[12px] px-2 py-1.5 rounded border border-sb-inky/40 focus:outline-none focus:border-sb-sky"
          >
            {allKeys.map(f => (
              <option key={f.field_key} value={f.field_key}>{f.label} ({f.field_key})</option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex items-center gap-2 mt-4">
        <button
          onClick={handleSave}
          disabled={saving}
          className="font-brand font-bold text-[11px] tracking-wider bg-sb-sky text-sb-navy px-3 py-1.5 rounded hover:brightness-105 transition disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save & Re-enrich'}
        </button>
        <button onClick={onClose} className="font-mono text-[11px] text-sb-inky hover:text-sb-cream transition">
          Cancel
        </button>
      </div>
    </div>
  )
}
