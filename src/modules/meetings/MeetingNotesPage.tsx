import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { createColumnHelper } from '@tanstack/react-table'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { DataTable } from '@/components/shared/DataTable'
import { type VisibilityValue } from '@/components/shared/VisibilitySelector'
import { RichTextDisplay } from '@/components/shared/RichTextEditor'
import { Button } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import { MeetingModal } from './MeetingModal'
import type { MeetingNote } from '@/types'
import { format } from 'date-fns'
import toast from 'react-hot-toast'

const VISIBILITY_OPTIONS: { value: VisibilityValue; label: string; icon: string }[] = [
  { value: 'private', label: 'Private', icon: '🔒' },
  { value: 'department', label: 'Department', icon: '🏢' },
  { value: 'attendees', label: 'Attendees', icon: '🤝' },
  { value: 'specific_users', label: 'Specific Users', icon: '👥' },
]

const col = createColumnHelper<MeetingNote>()

function stripHtml(html: string): string {
  const el = document.createElement('div')
  el.innerHTML = html
  return el.textContent ?? ''
}

function ExpandableDisplay({ value, clamp = 1, isHtml = false }: { value: string | null; clamp?: 1 | 2; isHtml?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const [canExpand, setCanExpand] = useState(false)
  const textRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (expanded) return
    const el = textRef.current
    if (!el) return
    setCanExpand(el.scrollHeight > el.clientHeight + 1)
  })

  const raw = value ?? ''
  const text = isHtml ? stripHtml(raw) : raw

  return (
    <div className="whitespace-normal">
      <div
        ref={textRef}
        className={[
          'text-xs font-mono',
          text ? 'text-navy' : 'text-inky/40',
          expanded ? (isHtml ? '' : 'whitespace-pre-wrap break-words') : clamp === 2 ? 'line-clamp-2' : 'line-clamp-1',
        ].join(' ')}
      >
        {expanded && isHtml ? <RichTextDisplay html={raw} className="text-xs" /> : (text || '—')}
      </div>
      {(canExpand || expanded) && (
        <button onClick={() => setExpanded((e) => !e)} className="mt-0.5 text-[10px] font-mono text-inky hover:underline">
          {expanded ? 'less' : 'more'}
        </button>
      )}
    </div>
  )
}

function to12hr(time: string): string {
  const [h, m] = time.slice(0, 5).split(':').map(Number)
  const ampm = h < 12 ? 'AM' : 'PM'
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ampm}`
}

export function MeetingNotesPage() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const myId = profile?.id ?? null
  const [searchParams, setSearchParams] = useSearchParams()
  const [meetings, setMeetings] = useState<MeetingNote[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<MeetingNote | null>(null)
  const [quick, setQuick] = useState(false)
  const [viewFilter, setViewFilter] = useState<'all' | 'mine' | 'shared'>('all')

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const { data, error } = await (supabase as any).schema('inventory').from('meeting_notes').select('*').eq('company_id', companyId)
      .order('meeting_date', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
    if (error) toast.error(error.message)
    else setMeetings((data ?? []) as MeetingNote[])
    setLoading(false)
  }, [companyId])

  useEffect(() => { load() }, [load])

  function openNew(isQuick = false) { setEditing(null); setQuick(isQuick); setModalOpen(true) }
  const openEdit = useCallback((m: MeetingNote) => { setEditing(m); setQuick(false); setModalOpen(true) }, [])

  // Auto-open a quick meeting if navigated to with ?quick=1
  useEffect(() => {
    if (searchParams.get('quick') === '1') {
      setSearchParams({}, { replace: true })
      openNew(true)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  const visibleMeetings = useMemo(() => {
    const accessible = meetings.filter((m) => {
      const vis: VisibilityValue = (m as any).visibility ?? (m.shared ? 'department' : 'private')
      return vis !== 'private' || m.created_by === myId
    })
    if (viewFilter === 'mine') return accessible.filter((m) => m.created_by === myId)
    if (viewFilter === 'shared') return accessible.filter((m) => m.created_by !== myId)
    return accessible
  }, [meetings, viewFilter, myId])

  const columns = useMemo(() => [
    col.accessor('title', {
      header: 'Meeting',
      size: 140,
      meta: { noClip: true },
      cell: (i) => (
        <div className="flex items-center gap-1.5 group/title">
          <ExpandableDisplay value={i.getValue()} clamp={2} />
          <button
            onClick={(e) => { e.stopPropagation(); openEdit(i.row.original as MeetingNote) }}
            title="Edit meeting"
            className="opacity-0 group-hover/title:opacity-100 transition-opacity flex-shrink-0 p-0.5 rounded hover:bg-navy/10 text-inky/60 hover:text-navy"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </button>
        </div>
      ),
    }),
    col.accessor('meeting_date', {
      header: 'Date',
      size: 120,
      cell: (i) => {
        const date = i.getValue()
        const time = (i.row.original as MeetingNote).meeting_time
        if (!date) return <span className="text-inky/40 text-xs font-mono">—</span>
        try {
          const d = format(new Date(date + 'T00:00:00'), 'MMM d, yyyy')
          return (
            <div className="flex flex-col text-xs font-mono leading-snug">
              <span>{d}</span>
              {time && <span className="text-inky/60">{to12hr(time)}</span>}
            </div>
          )
        } catch { return <span className="text-xs font-mono">{date}</span> }
      },
    }),
    col.accessor('vendor', { header: 'Vendor', size: 100, meta: { noClip: true }, cell: (i) => <ExpandableDisplay value={i.getValue() ?? null} /> }),
    col.accessor('category', { header: 'Category', size: 110, meta: { noClip: true }, cell: (i) => <ExpandableDisplay value={i.getValue() ?? null} /> }),
    col.accessor('shared', {
      header: 'Visibility',
      size: 95,
      cell: (i) => {
        const vis: VisibilityValue = (i.row.original as any).visibility ?? (i.getValue() ? 'department' : 'private')
        const opt = VISIBILITY_OPTIONS.find((o) => o.value === vis)
        return (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded text-inky/70 bg-navy/5 whitespace-nowrap">
            {opt?.icon} {opt?.label ?? 'Private'}
          </span>
        )
      },
    }),
    col.accessor('notes', { header: 'Notes', size: 200, meta: { noClip: true, fill: true }, cell: (i) => <ExpandableDisplay value={i.getValue() ?? null} clamp={2} isHtml /> }),
  ], [openEdit])

  const { table, globalFilter, setGlobalFilter } = useTable(visibleMeetings, columns)

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-heading font-bold text-navy uppercase tracking-wide">Meeting Notes</h1>
          <p className="text-xs text-inky mt-0.5">Your meetings are private by default — share individual meetings with the org as needed.</p>
        </div>
      </div>

      <div className="flex gap-0 border-b border-navy/15 -mb-4">
        {(['all', 'mine', 'shared'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setViewFilter(f)}
            className={[
              'px-4 py-2 text-xs font-heading uppercase tracking-wide transition-colors border-b-2',
              viewFilter === f ? 'border-sky text-navy' : 'border-transparent text-inky/50 hover:text-navy',
            ].join(' ')}
          >
            {f === 'all' ? 'All' : f === 'mine' ? 'My Notes' : 'Shared with Me'}
          </button>
        ))}
      </div>

      <DataTable
        table={table}
        globalFilter={globalFilter}
        onGlobalFilterChange={setGlobalFilter}
        exportFilename="meeting_notes.csv"
        exportData={visibleMeetings}
        loading={loading}
        actions={<Button size="sm" onClick={() => openNew()}>+ New Meeting</Button>}
      />

      <MeetingModal
        open={modalOpen}
        existing={editing}
        quick={quick}
        onClose={() => { setModalOpen(false); setEditing(null); load() }}
        onSaved={load}
      />
    </div>
  )
}
