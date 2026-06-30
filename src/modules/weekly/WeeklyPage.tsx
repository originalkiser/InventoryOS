import { useEffect, useState, useCallback, useMemo } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useWeeklyStore } from '@/stores/weeklyStore'
import { DataTable } from '@/components/shared/DataTable'
import { NotSubmittedPanel } from '@/components/shared/NotSubmittedPanel'
import { useTable } from '@/hooks/useTable'
import { useAppSetting } from '@/hooks/useAppSetting'
import { Button, Modal, Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui'
import { CountSummaryUpload } from '@/modules/monthend/CountSummaryUpload'
import { weeklySummaryTarget, locationLabel } from '@/modules/monthend/countsShared'
import type { Location, WeeklyCount } from '@/types'
import { startOfWeek, addDays, format } from 'date-fns'
import toast from 'react-hot-toast'

// weekStart is a Monday 'yyyy-MM-dd'. Range = [weekStart, weekStart+7).
function weekRange(weekStart: string) {
  const start = new Date(`${weekStart}T00:00:00`)
  const endExclusive = addDays(start, 7)
  const endInclusive = addDays(start, 6)
  return {
    startISO: `${weekStart}T00:00:00.000Z`,
    endExclusiveISO: format(endExclusive, "yyyy-MM-dd'T'00:00:00.000'Z'"),
    label: `Week of ${format(start, 'MMM d')} – ${format(endInclusive, 'MMM d, yyyy')}`,
    weekEndDate: format(endInclusive, 'yyyy-MM-dd'),
  }
}

function windowRange(windowStart: string, windowEnd: string) {
  return {
    startISO: `${windowStart}T00:00:00.000Z`,
    endExclusiveISO: format(addDays(new Date(`${windowEnd}T00:00:00`), 1), "yyyy-MM-dd'T'00:00:00.000'Z'"),
  }
}

const inputCls = 'bg-cream border border-navy/30 rounded px-2 py-1 text-xs font-mono text-navy focus:outline-none focus:border-sky'
const badgeCls = 'text-[10px] font-mono text-inky/70 bg-navy/[0.07] rounded px-1.5 py-0.5'

interface WindowFilters {
  windowEnabled: boolean
  windowStart: string
  windowEnd: string
}

// ---------------------------------------------------------------------------
// Exclusion manager modal
// ---------------------------------------------------------------------------
function ExclusionManagerModal({
  open,
  onClose,
  locations,
  exclusions,
  onChange,
}: {
  open: boolean
  onClose: () => void
  locations: Location[]
  exclusions: Set<string>
  onChange: (next: Set<string>) => void
}) {
  const [search, setSearch] = useState('')

  const sorted = useMemo(() => {
    const q = search.toLowerCase()
    const filtered = q
      ? locations.filter(
          (l) =>
            l.location_code?.toLowerCase().includes(q) ||
            l.name?.toLowerCase().includes(q),
        )
      : locations
    return [...filtered].sort((a, b) => {
      const aEx = exclusions.has(a.id)
      const bEx = exclusions.has(b.id)
      if (aEx && !bEx) return -1
      if (!aEx && bEx) return 1
      return (a.location_code ?? '').localeCompare(b.location_code ?? '')
    })
  }, [locations, exclusions, search])

  function toggle(id: string) {
    const next = new Set(exclusions)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange(next)
  }

  return (
    <Modal open={open} onClose={onClose} title="Manage Shop Exclusions" size="md">
      <div className="flex flex-col gap-3">
        <p className="text-xs font-mono text-inky">
          Excluded shops are hidden from counts, not-submitted tracking, and exports. Selections persist across weeks.
        </p>
        <input
          type="text"
          placeholder="Search by code or name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={`${inputCls} w-full`}
        />
        <div className="flex flex-col gap-0 max-h-80 overflow-y-auto border border-navy/10 rounded">
          {sorted.map((loc) => (
            <label
              key={loc.id}
              className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-navy/5 select-none border-b border-navy/5 last:border-0"
            >
              <input
                type="checkbox"
                checked={exclusions.has(loc.id)}
                onChange={() => toggle(loc.id)}
                className="w-3.5 h-3.5 accent-navy flex-shrink-0"
              />
              <span className="text-xs font-mono text-navy font-semibold w-16 flex-shrink-0">
                {loc.location_code}
              </span>
              <span className="text-xs font-mono text-inky truncate">{loc.name}</span>
              {(loc.metadata as any)?.owner && (
                <span className="ml-auto text-[10px] font-mono text-inky/50 flex-shrink-0">
                  {(loc.metadata as any).owner}
                </span>
              )}
            </label>
          ))}
          {sorted.length === 0 && (
            <p className="text-xs font-mono text-inky/50 italic px-3 py-3">No shops match.</p>
          )}
        </div>
        <div className="flex items-center justify-between pt-1">
          {exclusions.size > 0 ? (
            <button
              onClick={() => onChange(new Set())}
              className="text-xs font-mono text-[#C0392B] hover:underline"
            >
              Clear all ({exclusions.size})
            </button>
          ) : (
            <span />
          )}
          <Button size="sm" onClick={onClose}>Done</Button>
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------
export function WeeklyPage() {
  const { selectedWeek, setSelectedWeek } = useWeeklyStore()
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const { label, weekEndDate } = weekRange(selectedWeek)

  // Filters
  const [corporateOnly, setCorporateOnly] = useState(false)
  const [windowEnabled, setWindowEnabled] = useState(false)
  const [windowStart, setWindowStart] = useState(selectedWeek)
  const [windowEnd, setWindowEnd] = useState(weekEndDate)

  // Manual shop exclusions — persisted in localStorage per company
  const storageKey = companyId ? `weekly_exclusions_${companyId}` : null
  const [manualExclusions, setManualExclusions] = useState<Set<string>>(new Set())
  const [exclusionPanelOpen, setExclusionPanelOpen] = useState(false)

  // All active locations — loaded once at page level
  const [locations, setLocations] = useState<Location[]>([])

  useEffect(() => {
    if (!companyId) return
    const sb = supabase as any
    sb.schema('core').from('locations')
      .select('*').eq('company_id', companyId).eq('active', true).order('location_code')
      .then(({ data }: any) => setLocations((data ?? []) as Location[]))
  }, [companyId])

  // Load persisted exclusions — Supabase primary, localStorage fallback.
  useEffect(() => {
    if (!profile?.id) return
    const sb = supabase as any
    sb.schema('core').from('user_sidebar_prefs')
      .select('weekly_shop_exclusions')
      .eq('user_id', profile.id)
      .maybeSingle()
      .then(({ data }: any) => {
        const ids: string[] | null = data?.weekly_shop_exclusions ?? null
        if (ids && ids.length > 0) {
          setManualExclusions(new Set(ids))
          if (storageKey) {
            try { localStorage.setItem(storageKey, JSON.stringify(ids)) } catch { /* ignore */ }
          }
        } else if (storageKey) {
          // Column not yet in DB or empty — fall back to localStorage
          try {
            const raw = localStorage.getItem(storageKey)
            if (raw) setManualExclusions(new Set(JSON.parse(raw) as string[]))
          } catch { /* ignore */ }
        }
      })
      .catch(() => {
        // Network / RLS failure — fall back to localStorage
        if (!storageKey) return
        try {
          const raw = localStorage.getItem(storageKey)
          if (raw) setManualExclusions(new Set(JSON.parse(raw) as string[]))
        } catch { /* ignore */ }
      })
  }, [profile?.id, storageKey])

  function updateExclusions(next: Set<string>) {
    setManualExclusions(next)
    const ids = [...next]
    // localStorage — immediate, always
    if (storageKey) {
      try { localStorage.setItem(storageKey, JSON.stringify(ids)) } catch { /* ignore */ }
    }
    // Supabase — best-effort (column may be pending migration)
    if (profile?.id) {
      const sb = supabase as any
      sb.schema('core').from('user_sidebar_prefs')
        .upsert(
          { user_id: profile.id, weekly_shop_exclusions: ids, updated_at: new Date().toISOString() },
          { onConflict: 'user_id' },
        )
        .then(() => {})
    }
  }

  // Reset window to full week when week changes
  useEffect(() => {
    const { weekEndDate: end } = weekRange(selectedWeek)
    setWindowStart(selectedWeek)
    setWindowEnd(end)
  }, [selectedWeek])

  function shiftWeek(deltaDays: number) {
    const d = addDays(new Date(`${selectedWeek}T00:00:00`), deltaDays)
    setSelectedWeek(format(startOfWeek(d, { weekStartsOn: 1 }), 'yyyy-MM-dd'))
  }

  // Effective locations after all filters
  const effectiveLocations = useMemo(() => {
    let locs = locations
    if (corporateOnly) locs = locs.filter((l) => (l.metadata as any)?.owner === 'Corporate')
    if (manualExclusions.size > 0) locs = locs.filter((l) => !manualExclusions.has(l.id))
    return locs
  }, [locations, corporateOnly, manualExclusions])

  const nonCorporateCount = useMemo(
    () => locations.filter((l) => (l.metadata as any)?.owner !== 'Corporate').length,
    [locations],
  )

  const windowFilters: WindowFilters = { windowEnabled, windowStart, windowEnd }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Weekly Counts</h1>
          <p className="text-xs text-inky mt-0.5">Track weekly count submissions across shops</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => shiftWeek(-7)} className="px-2 py-1.5 border border-navy/30 rounded text-inky hover:border-navy/60 font-mono text-xs">‹ Prev</button>
          <div className="flex flex-col">
            <span className="text-[10px] font-mono text-inky uppercase tracking-wide">Week</span>
            <input
              type="date"
              value={selectedWeek}
              onChange={(e) => {
                if (!e.target.value) return
                setSelectedWeek(format(startOfWeek(new Date(`${e.target.value}T00:00:00`), { weekStartsOn: 1 }), 'yyyy-MM-dd'))
              }}
              className={inputCls}
            />
          </div>
          <button onClick={() => shiftWeek(7)} className="px-2 py-1.5 border border-navy/30 rounded text-inky hover:border-navy/60 font-mono text-xs">Next ›</button>
        </div>
      </div>

      <p className="text-xs font-mono text-inky">Selected: <span className="text-navy">{label}</span></p>

      {/* Filter bar */}
      <div className="flex flex-col gap-2.5 px-3 py-2.5 border border-navy/10 rounded bg-navy/[0.03]">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          {/* Corporate only */}
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={corporateOnly}
                onChange={(e) => setCorporateOnly(e.target.checked)}
                className="w-3.5 h-3.5 accent-navy"
              />
              <span className="text-xs font-mono text-inky">Corporate shops only</span>
            </label>
            {corporateOnly && nonCorporateCount > 0 && (
              <span className={badgeCls}>{nonCorporateCount} excluded</span>
            )}
          </div>

          <div className="hidden sm:block w-px h-4 bg-navy/15" />

          {/* Count window — no min on start, allowing dates before the week */}
          <div className="flex items-center gap-2 flex-wrap">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={windowEnabled}
                onChange={(e) => setWindowEnabled(e.target.checked)}
                className="w-3.5 h-3.5 accent-navy"
              />
              <span className="text-xs font-mono text-inky">Count window</span>
            </label>
            {windowEnabled && (
              <div className="flex items-center gap-1.5">
                <input
                  type="date"
                  value={windowStart}
                  max={windowEnd}
                  onChange={(e) => e.target.value && setWindowStart(e.target.value)}
                  className={inputCls}
                />
                <span className="text-[10px] font-mono text-inky/50">to</span>
                <input
                  type="date"
                  value={windowEnd}
                  min={windowStart}
                  onChange={(e) => e.target.value && setWindowEnd(e.target.value)}
                  className={inputCls}
                />
              </div>
            )}
          </div>
        </div>

        {/* Manual exclusions row */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setExclusionPanelOpen(true)}
            className="text-xs font-mono text-inky hover:text-navy transition-colors underline decoration-dotted underline-offset-2"
          >
            Manage shop exclusions
          </button>
          {manualExclusions.size > 0 && (
            <span className={badgeCls}>{manualExclusions.size} excluded</span>
          )}
        </div>
      </div>

      <Tabs defaultValue="counts">
        <TabsList>
          <TabsTrigger value="counts">Counts</TabsTrigger>
          <TabsTrigger value="not_submitted">Not Submitted</TabsTrigger>
        </TabsList>
        <TabsContent value="counts">
          <WeeklyCountsTab effectiveLocations={effectiveLocations} windowFilters={windowFilters} />
        </TabsContent>
        <TabsContent value="not_submitted">
          <WeeklyNotSubmittedTab effectiveLocations={effectiveLocations} windowFilters={windowFilters} />
        </TabsContent>
      </Tabs>

      <ExclusionManagerModal
        open={exclusionPanelOpen}
        onClose={() => setExclusionPanelOpen(false)}
        locations={locations}
        exclusions={manualExclusions}
        onChange={updateExclusions}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Counts tab
// ---------------------------------------------------------------------------
interface WeeklyRow extends WeeklyCount {
  location_label: string
}

const col = createColumnHelper<WeeklyRow>()
const num = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: 2 })

function WeeklyCountsTab({
  effectiveLocations,
  windowFilters,
}: {
  effectiveLocations: Location[]
  windowFilters: WindowFilters
}) {
  const { profile } = useAuthStore()
  const { selectedWeek } = useWeeklyStore()
  const companyId = profile?.company_id ?? null
  const { windowEnabled, windowStart, windowEnd } = windowFilters

  const { startISO, endExclusiveISO } = windowEnabled
    ? windowRange(windowStart, windowEnd)
    : weekRange(selectedWeek)

  const [counts, setCounts] = useState<WeeklyCount[]>([])
  const [loading, setLoading] = useState(true)

  // Allowable count type rules — company-wide, cross-user via app_settings
  type TypeRuleMode = 'include' | 'exclude' | 'allow_if_over'
  interface TypeRule { mode: TypeRuleMode; threshold: number | null }
  const [typeRules, setTypeRules] = useAppSetting<Record<string, TypeRule>>('weekly.allowableTypeRules', {})
  const [rulePopover, setRulePopover] = useState<string | null>(null)
  const [thresholdDraft, setThresholdDraft] = useState<Record<string, string>>({})

  const distinctTypes = useMemo(
    () => Array.from(new Set(counts.map((c) => c.count_type ?? '—'))).sort(),
    [counts],
  )

  function getTypeRule(t: string): TypeRule { return typeRules[t] ?? { mode: 'include', threshold: null } }
  function saveTypeRule(t: string, rule: TypeRule) { setTypeRules({ ...typeRules, [t]: rule }); setRulePopover(null) }

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const sb = supabase as any
    const { data } = await sb.schema('inventory').from('weekly_counts').select('*')
      .eq('company_id', companyId)
      .gte('count_date', startISO)
      .lt('count_date', endExclusiveISO)
      .order('count_date', { ascending: false })
    setCounts((data ?? []) as WeeklyCount[])
    setLoading(false)
  }, [companyId, startISO, endExclusiveISO])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!companyId) return
    const channel = supabase
      .channel('weekly-counts-rt')
      .on('postgres_changes', { event: '*', schema: 'inventory', table: 'weekly_counts', filter: `company_id=eq.${companyId}` },
        () => { toast('Weekly counts updated', { icon: '📊' }); load() })
      .subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [companyId, load])

  const allowedIds = useMemo(() => new Set(effectiveLocations.map((l) => l.id)), [effectiveLocations])

  const rows: WeeklyRow[] = useMemo(() =>
    counts
      .filter((c) => {
        if (!allowedIds.has(c.location_id ?? '')) return false
        const rule = typeRules[c.count_type ?? '—'] ?? { mode: 'include' as TypeRuleMode, threshold: null }
        if (rule.mode === 'exclude') return false
        if (rule.mode === 'allow_if_over') return rule.threshold == null || (c.total_adjustments ?? 0) > rule.threshold
        return true
      })
      .map((c) => ({ ...c, location_label: locationLabel(c.location_id, effectiveLocations) })),
    [counts, allowedIds, effectiveLocations, typeRules], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const columns = useMemo(() => [
    col.accessor('location_label', { header: 'Location' }),
    col.accessor('count_type', { header: 'Type', cell: (i) => i.getValue() ?? '—' }),
    col.accessor('count_date', {
      header: 'Count Date',
      cell: (i) => (i.getValue() ? format(new Date(i.getValue()!), 'MMM d, yyyy') : '—'),
    }),
    col.accessor('total_adjustments', { header: 'Adjustments', cell: (i) => num(i.getValue()) }),
    col.accessor('adjustment_value', { header: 'Adj Value', cell: (i) => num(i.getValue()) }),
    col.accessor('abs_adjustment_value', { header: 'Abs Adj Value', cell: (i) => num(i.getValue()) }),
    col.accessor('ending_inventory_cost', {
      header: 'Ending Balance',
      cell: (i) => <span className="text-navy">{num(i.getValue())}</span>,
    }),
  ], [])

  const { table, globalFilter, setGlobalFilter } = useTable(rows, columns)

  const exportRows = useMemo(() => rows.map((r) => ({
    location: r.location_label,
    count_type: r.count_type ?? '',
    count_date: r.count_date ?? '',
    total_adjustments: r.total_adjustments ?? '',
    adjustment_value: r.adjustment_value ?? '',
    abs_adjustment_value: r.abs_adjustment_value ?? '',
    ending_inventory_cost: r.ending_inventory_cost ?? '',
  })), [rows])

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <CountSummaryUpload
          locations={effectiveLocations}
          companyId={companyId}
          target={weeklySummaryTarget(selectedWeek)}
          uploadedBy={profile?.id ?? null}
          onImported={load}
        />
      </div>
      {/* Allowable count types */}
      {distinctTypes.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded border border-navy/30 bg-cream px-3 py-2">
          <span className="text-xs font-mono uppercase tracking-wide text-inky">Allowable types:</span>
          {distinctTypes.map((t) => {
            const rule = getTypeRule(t)
            const chipColor =
              rule.mode === 'exclude' ? 'border-red-300 bg-red-50 text-red-600' :
              rule.mode === 'allow_if_over' ? 'border-amber-400 bg-amber-50 text-amber-700' :
              'border-navy bg-navy/10 text-navy'
            const chipLabel =
              rule.mode === 'exclude' ? `✕ ${t}` :
              rule.mode === 'allow_if_over' ? `≥${rule.threshold ?? '?'} adj · ${t}` :
              `✓ ${t}`
            return (
              <div key={t} className="relative">
                <button
                  onClick={() => {
                    setRulePopover(rulePopover === t ? null : t)
                    setThresholdDraft((d) => ({ ...d, [t]: String(getTypeRule(t).threshold ?? '') }))
                  }}
                  className={['rounded border px-2 py-0.5 text-xs font-mono transition-colors', chipColor].join(' ')}
                >
                  {chipLabel}
                </button>
                {rulePopover === t && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setRulePopover(null)} />
                    <div className="absolute z-50 top-full mt-1 left-0 min-w-[220px] rounded border border-navy/30 bg-cream shadow-xl p-3 flex flex-col gap-2">
                      <p className="text-[10px] font-mono text-inky uppercase tracking-wide mb-1">{t}</p>
                      <button
                        onClick={() => saveTypeRule(t, { mode: 'include', threshold: null })}
                        className={['flex items-center gap-2 text-xs font-mono px-2 py-1.5 rounded border transition-colors', rule.mode === 'include' ? 'border-navy bg-navy/10 text-navy' : 'border-navy/20 text-inky hover:border-navy/40'].join(' ')}
                      >
                        <span className="text-green-600">✓</span> Include (always allowed)
                      </button>
                      <button
                        onClick={() => saveTypeRule(t, { mode: 'exclude', threshold: null })}
                        className={['flex items-center gap-2 text-xs font-mono px-2 py-1.5 rounded border transition-colors', rule.mode === 'exclude' ? 'border-red-400 bg-red-50 text-red-600' : 'border-navy/20 text-inky hover:border-navy/40'].join(' ')}
                      >
                        <span className="text-red-500">✕</span> Don't allow
                      </button>
                      <div className={['flex flex-col gap-1.5 rounded border px-2 py-2 transition-colors', rule.mode === 'allow_if_over' ? 'border-amber-400 bg-amber-50' : 'border-navy/20'].join(' ')}>
                        <button
                          onClick={() => saveTypeRule(t, { mode: 'allow_if_over', threshold: Number(thresholdDraft[t]) || null })}
                          className="flex items-center gap-2 text-xs font-mono text-left"
                        >
                          <span className={rule.mode === 'allow_if_over' ? 'text-amber-600' : 'text-inky/40'}>◎</span>
                          <span className={rule.mode === 'allow_if_over' ? 'text-amber-700' : 'text-inky'}>Allow if over X adjustments</span>
                        </button>
                        <div className="flex items-center gap-1.5 pl-5">
                          <span className="text-[10px] font-mono text-inky">Threshold:</span>
                          <input
                            type="number"
                            min={0}
                            value={thresholdDraft[t] ?? ''}
                            onChange={(e) => setThresholdDraft((d) => ({ ...d, [t]: e.target.value }))}
                            onClick={(e) => e.stopPropagation()}
                            placeholder="e.g. 5"
                            className="w-16 rounded border border-navy/30 bg-cream px-1.5 py-0.5 text-xs font-mono text-navy focus:border-[#00e5ff] focus:outline-none"
                          />
                          <button
                            onClick={() => saveTypeRule(t, { mode: 'allow_if_over', threshold: Number(thresholdDraft[t]) || null })}
                            className="text-[10px] font-mono border border-navy/20 rounded px-1.5 py-0.5 text-inky hover:border-navy/40"
                          >
                            Set
                          </button>
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )
          })}
          {(() => {
            const excluded = counts.filter((c) => allowedIds.has(c.location_id ?? '') && (() => {
              const rule = typeRules[c.count_type ?? '—'] ?? { mode: 'include' as TypeRuleMode, threshold: null }
              if (rule.mode === 'exclude') return true
              if (rule.mode === 'allow_if_over') return !(rule.threshold == null || (c.total_adjustments ?? 0) > rule.threshold)
              return false
            })()).length
            return excluded > 0 ? (
              <span className="text-xs font-mono text-orange-600">{excluded} row{excluded !== 1 ? 's' : ''} excluded</span>
            ) : null
          })()}
        </div>
      )}

      <div>
        <h2 className="text-xs font-mono text-inky uppercase tracking-wide mb-3">Results</h2>
        <DataTable
          table={table}
          globalFilter={globalFilter}
          onGlobalFilterChange={setGlobalFilter}
          exportFilename={`weekly_counts_${selectedWeek}.csv`}
          exportData={exportRows}
          loading={loading}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Not Submitted tab
// ---------------------------------------------------------------------------
function WeeklyNotSubmittedTab({
  effectiveLocations,
  windowFilters,
}: {
  effectiveLocations: Location[]
  windowFilters: WindowFilters
}) {
  const { profile } = useAuthStore()
  const { selectedWeek } = useWeeklyStore()
  const companyId = profile?.company_id ?? null
  const { windowEnabled, windowStart, windowEnd } = windowFilters
  const { startISO, endExclusiveISO, label } = weekRange(selectedWeek)

  const submitCheckStart = windowEnabled ? `${windowStart}T00:00:00.000Z` : startISO
  const submitCheckEnd = windowEnabled
    ? format(addDays(new Date(`${windowEnd}T00:00:00`), 1), "yyyy-MM-dd'T'00:00:00.000'Z'")
    : endExclusiveISO

  const periodLabel = windowEnabled
    ? `${format(new Date(`${windowStart}T00:00:00`), 'MMM d')} – ${format(new Date(`${windowEnd}T00:00:00`), 'MMM d, yyyy')}`
    : label

  const [missing, setMissing] = useState<Location[]>([])
  const [lastSubmitted, setLastSubmitted] = useState<Record<string, string | null>>({})
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const sb = supabase as any
    const [weekRes, priorRes] = await Promise.all([
      sb.schema('inventory').from('weekly_counts').select('location_id').eq('company_id', companyId)
        .gte('count_date', submitCheckStart).lt('count_date', submitCheckEnd),
      sb.schema('inventory').from('weekly_counts').select('location_id, count_date').eq('company_id', companyId)
        .lt('count_date', startISO).order('count_date', { ascending: false }),
    ])

    const submittedIds = new Set(
      ((weekRes.data ?? []) as { location_id: string | null }[]).map((r) => r.location_id).filter(Boolean),
    )
    setMissing(effectiveLocations.filter((l) => !submittedIds.has(l.id)))

    const lastMap: Record<string, string | null> = {}
    for (const r of (priorRes.data ?? []) as { location_id: string | null; count_date: string }[]) {
      if (r.location_id && !lastMap[r.location_id]) lastMap[r.location_id] = r.count_date
    }
    setLastSubmitted(lastMap)
    setLoading(false)
  }, [companyId, startISO, submitCheckStart, submitCheckEnd, effectiveLocations])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!companyId) return
    const channel = supabase
      .channel('weekly-notsubmitted-rt')
      .on('postgres_changes', { event: '*', schema: 'inventory', table: 'weekly_counts', filter: `company_id=eq.${companyId}` }, () => load())
      .subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [companyId, load])

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  return (
    <NotSubmittedPanel
      companyId={companyId}
      periodStartISO={selectedWeek}
      periodLabel={periodLabel}
      missing={missing}
      totalActive={effectiveLocations.length}
      lastSubmittedByLoc={lastSubmitted}
      reminderTitle={`Weekly counts outstanding — ${periodLabel}`}
      exportPrefix="weekly_not_submitted"
      lastSubmittedFormat="MMM d, yyyy"
      loading={loading}
    />
  )
}
