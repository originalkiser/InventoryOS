import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useDarkMode } from '@/hooks/useDarkMode'
import { useProfilePref } from '@/hooks/useProfilePrefs'
import { useDeptAccess } from '@/hooks/useDeptAccess'
import { isAdminOrDeveloper, getRoleLabel } from '@/lib/roles'
import { normalizeBlockedDays, formatBlockedDayLabel, upsertBlockedDay, removeBlockedDay } from '@/utils/blockedDays'
import { LocationExclusionsConfig } from './LocationExclusionsConfig'
import { ICONS, SECTION_ITEMS, QUICK_FAB_META, QUICK_FAB_DEFAULT, type QuickFabPosition } from './Sidebar'
import type { NotifPrefs, NotifType } from '@/hooks/useNotifications'

// Moved out of Sidebar.tsx (2026-09-23) — the profile drawer is now opened
// from the TopBar (next to End Day) instead of a sidebar footer button, and
// is a centered modal instead of a right-edge slide-out drawer. Widened to
// a 3-column layout (2026-09-23 follow-up) instead of one long scrolling
// column — grouped by theme (identity/frequent, workspace, schedule) rather
// than by section order; a full-width row below the columns holds the
// rarely-touched Outlook placeholder, Administration, and Sign out.

const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Anchorage',
  'Pacific/Honolulu',
]

const QUICK_FAB_POSITIONS: { value: QuickFabPosition; label: string }[] = [
  { value: 'bottom-right', label: 'Bottom right corner' },
  { value: 'bottom-left', label: 'Bottom left corner' },
  { value: 'topbar-left', label: 'Top bar — left' },
]

interface ProfilePanelProps {
  onClose: () => void
  // Notification settings — TopBar's own live useNotifications() instance,
  // passed down so this panel edits the SAME state rather than a second,
  // independently-stale copy (TopBar still calls notify() itself).
  canNotify: boolean
  permission: NotificationPermission
  notifPrefs: NotifPrefs
  setNotifPrefs: (p: NotifPrefs) => void
  requestPermission: () => Promise<NotificationPermission>
}

export function ProfilePanel({ onClose, canNotify, permission, notifPrefs, setNotifPrefs, requestPermission }: ProfilePanelProps) {
  const { profile, setProfile } = useAuthStore()
  const { dark, toggle } = useDarkMode()
  const isAdmin = isAdminOrDeveloper(profile?.role)
  const allowedSections = useDeptAccess()
  const [enabledFabs, setEnabledFabs] = useProfilePref<string[]>('quickfab:enabled', QUICK_FAB_DEFAULT)
  const [fabPosition, setFabPosition] = useProfilePref<QuickFabPosition>('quickfab:position', 'bottom-right')
  const [hiddenSections, setHiddenSections] = useProfilePref<string[]>('sidebar:hiddenSections', [])
  const accessibleSections = Object.keys(SECTION_ITEMS).filter((k) => (k === 'global-config' ? isAdmin : allowedSections !== null ? allowedSections.has(k) : true))
  const sectionLabel = (k: string) => k.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

  // Schedule state — initialized from profile
  const [workStart, setWorkStart] = useState(profile?.work_start_time?.slice(0, 5) ?? '08:00')
  const [workEnd, setWorkEnd] = useState(profile?.work_end_time?.slice(0, 5) ?? '17:00')
  const [eodEnabled, setEodEnabled] = useState(profile?.eod_review_enabled ?? true)
  const [eodTime, setEodTime] = useState(profile?.eod_review_time?.slice(0, 5) ?? '16:45')
  const [taskPopups, setTaskPopups] = useState(profile?.task_popups_enabled ?? true)
  const [timezone, setTimezone] = useState(profile?.popup_timezone ?? 'America/Chicago')
  const [autoPush, setAutoPush] = useState(profile?.auto_push_tasks ?? false)
  const [skipWeekends, setSkipWeekends] = useState(profile?.skip_weekends_holidays ?? false)
  const [schedSaving, setSchedSaving] = useState(false)
  const [schedSaved, setSchedSaved] = useState(false)
  const [blockedDays, setBlockedDays] = useState(() => normalizeBlockedDays(profile?.blocked_days))
  const [newBlockedDate, setNewBlockedDate] = useState('')
  const [newBlockedNote, setNewBlockedNote] = useState('')

  async function saveSchedule() {
    if (!profile?.id) return
    setSchedSaving(true)
    const updates = {
      work_start_time: workStart,
      work_end_time: workEnd,
      eod_review_enabled: eodEnabled,
      eod_review_time: eodTime,
      task_popups_enabled: taskPopups,
      popup_timezone: timezone,
      auto_push_tasks: autoPush,
      skip_weekends_holidays: skipWeekends,
      updated_at: new Date().toISOString(),
    }
    const { data, error } = await (supabase as any).schema('platform').from('user_profiles')
      .update(updates).eq('id', profile.id).select().single()
    setSchedSaving(false)
    if (error) { console.error(error); return }
    setProfile({ ...profile, ...data })
    setSchedSaved(true)
    setTimeout(() => setSchedSaved(false), 2000)
  }

  async function addBlockedDay() {
    if (!newBlockedDate || !profile?.id) return
    const updated = upsertBlockedDay(blockedDays, {
      date: newBlockedDate,
      ...(newBlockedNote.trim() ? { note: newBlockedNote.trim() } : {}),
    })
    const { data, error } = await (supabase as any).schema('platform').from('user_profiles')
      .update({ blocked_days: updated }).eq('id', profile.id).select().single()
    if (error) { console.error(error); return }
    setProfile({ ...profile, ...data })
    setBlockedDays(updated)
    setNewBlockedDate('')
    setNewBlockedNote('')
  }

  async function removeBlockedDayEntry(date: string) {
    if (!profile?.id) return
    const updated = removeBlockedDay(blockedDays, date)
    const { data, error } = await (supabase as any).schema('platform').from('user_profiles')
      .update({ blocked_days: updated }).eq('id', profile.id).select().single()
    if (error) { console.error(error); return }
    setProfile({ ...profile, ...data })
    setBlockedDays(updated)
  }

  const initials = (profile?.full_name ?? profile?.email ?? '?')
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose} aria-hidden="true">
      <div
        className="profile-panel relative w-full max-w-4xl max-h-[85vh] bg-[#F2F1E6] dark:bg-[#002745] shadow-2xl border border-navy/20 dark:border-[#F2F1E6]/10 rounded-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-navy/10 dark:border-[#F2F1E6]/10 flex-shrink-0">
          <span className="text-xs font-heading text-navy dark:text-[#F2F1E6] uppercase tracking-widest">Profile</span>
          <button
            onClick={onClose}
            className="text-inky hover:text-navy dark:text-[#F2F1E6]/60 dark:hover:text-[#F2F1E6] transition-colors p-1"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Scrollable content — grows with the number of profile options */}
        <div className="flex-1 min-h-0 overflow-y-auto">
        {/* User info */}
        <div className="px-4 py-4 border-b border-navy/10 dark:border-[#F2F1E6]/10 flex items-start gap-3">
          <div className="w-12 h-12 rounded-full bg-navy dark:bg-[#4F7489] flex items-center justify-center text-cream text-sm font-heading flex-shrink-0">
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-heading text-navy dark:text-[#F2F1E6] truncate">
              {profile?.full_name ?? '—'}
            </div>
            <div className="text-xs font-mono text-inky dark:text-[#F2F1E6]/60 truncate">
              {profile?.email}
            </div>
            <div className="mt-1 inline-block text-[10px] font-heading text-[#F2F1E6] bg-[#4F7489] rounded px-1.5 py-0.5 uppercase tracking-wide">
              {getRoleLabel(profile?.role)}
            </div>
          </div>
        </div>

        {/* 3 columns: identity/frequent, workspace, schedule. Each column
            stacks its own sections with divide-y instead of each section
            carrying its own border-b, since that border now needs to stop
            at the column edge, not run the modal's full width. */}
        <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-navy/10 dark:divide-[#F2F1E6]/10">
          {/* Column 1 — identity / frequently touched */}
          <div className="flex flex-col divide-y divide-navy/10 dark:divide-[#F2F1E6]/10">
            {/* Appearance */}
            <div className="px-4 py-4">
              <div className="text-[10px] font-heading text-navy/60 dark:text-[#F2F1E6]/90 uppercase tracking-widest mb-3">
                Appearance
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-body text-navy dark:text-[#F2F1E6]">
                  {dark ? 'Dark mode' : 'Light mode'}
                </span>
                <button
                  onClick={toggle}
                  className={[
                    'relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 focus:outline-none',
                    dark ? 'bg-[#4F7489]' : 'bg-navy/20',
                  ].join(' ')}
                >
                  <span className={[
                    'inline-block h-3.5 w-3.5 rounded-full bg-white shadow transform transition-transform duration-200',
                    dark ? 'translate-x-[18px]' : 'translate-x-0.5',
                  ].join(' ')} />
                </button>
              </div>
            </div>

            {/* Notifications — moved in from the TopBar's own bell popover */}
            {canNotify && (
              <div className="px-4 py-4">
                <div className="text-[10px] font-heading text-navy/60 dark:text-[#F2F1E6]/90 uppercase tracking-widest mb-3">
                  Notifications
                </div>
                {permission === 'denied' ? (
                  <p className="text-xs font-mono text-inky dark:text-[#F2F1E6]/60 leading-relaxed">
                    Blocked in your browser. Enable notifications for this site in your browser settings, then reload.
                  </p>
                ) : permission !== 'granted' ? (
                  <button
                    onClick={async () => { await requestPermission() }}
                    className="w-full rounded bg-sky/20 border border-sky/40 px-2 py-1.5 text-[11px] font-heading uppercase tracking-wide text-navy dark:text-[#F2F1E6] hover:bg-sky/30"
                  >
                    Enable desktop notifications
                  </button>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    <label className="flex items-center gap-2 text-xs font-body text-navy dark:text-[#F2F1E6] cursor-pointer">
                      <input type="checkbox" checked={notifPrefs.enabled}
                        onChange={() => setNotifPrefs({ ...notifPrefs, enabled: !notifPrefs.enabled })}
                        className="accent-sky" />
                      All notifications
                    </label>
                    <div className="border-t border-navy/10 dark:border-[#F2F1E6]/10 my-0.5" />
                    {([['eod', 'End of Day'], ['tasks', "Today's Tasks"], ['events', 'Calendar Events']] as [NotifType, string][]).map(([key, label]) => (
                      <label key={key} className={['flex items-center gap-2 text-xs font-body text-navy dark:text-[#F2F1E6] ml-3', notifPrefs.enabled ? 'cursor-pointer' : 'opacity-40'].join(' ')}>
                        <input type="checkbox" disabled={!notifPrefs.enabled} checked={notifPrefs.types[key]}
                          onChange={() => setNotifPrefs({ ...notifPrefs, types: { ...notifPrefs.types, [key]: !notifPrefs.types[key] } })}
                          className="accent-sky" />
                        {label}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Column 2 — workspace */}
          <div className="flex flex-col divide-y divide-navy/10 dark:divide-[#F2F1E6]/10">
            {/* Quick Access hover buttons */}
            <div className="px-4 py-4">
              <div className="text-[10px] font-heading text-navy/60 dark:text-[#F2F1E6]/90 uppercase tracking-widest mb-1">Quick Access Buttons</div>
              <p className="text-[10px] font-mono text-inky/60 dark:text-[#F2F1E6]/50 mb-2">Which buttons show, and where.</p>
              <div className="flex flex-col gap-1.5 mb-3">
                {QUICK_FAB_META.map((f) => (
                  <label key={f.key} className="flex items-center gap-2 text-xs font-body text-navy dark:text-[#F2F1E6] cursor-pointer">
                    <input type="checkbox" checked={enabledFabs.includes(f.key)} onChange={() => setEnabledFabs(enabledFabs.includes(f.key) ? enabledFabs.filter((x) => x !== f.key) : [...enabledFabs, f.key])} className="accent-sky" />
                    {f.label}
                  </label>
                ))}
              </div>
              <div className="text-[10px] font-heading text-navy/50 dark:text-[#F2F1E6]/60 uppercase tracking-widest mb-1">Position</div>
              <div className="flex flex-col gap-1.5">
                {QUICK_FAB_POSITIONS.map((p) => (
                  <label key={p.value} className="flex items-center gap-2 text-xs font-body text-navy dark:text-[#F2F1E6] cursor-pointer">
                    <input type="radio" name="quickfab-position" checked={fabPosition === p.value} onChange={() => setFabPosition(p.value)} className="accent-sky" />
                    {p.label}
                  </label>
                ))}
              </div>
            </div>

            {/* Sidebar sections */}
            <div className="px-4 py-4">
              <div className="text-[10px] font-heading text-navy/60 dark:text-[#F2F1E6]/90 uppercase tracking-widest mb-1">Sidebar Sections</div>
              <p className="text-[10px] font-mono text-inky/60 dark:text-[#F2F1E6]/50 mb-2">Uncheck a section to hide it from the sidebar.</p>
              <div className="flex flex-col gap-1.5">
                {accessibleSections.map((k) => (
                  <label key={k} className="flex items-center gap-2 text-xs font-body text-navy dark:text-[#F2F1E6] cursor-pointer">
                    <input type="checkbox" checked={!hiddenSections.includes(k)} onChange={() => setHiddenSections(hiddenSections.includes(k) ? hiddenSections.filter((x) => x !== k) : [...hiddenSections, k])} className="accent-sky" />
                    {sectionLabel(k)}
                  </label>
                ))}
              </div>
            </div>

            {/* Location Exclusions */}
            <LocationExclusionsConfig />
          </div>

          {/* Column 3 — schedule */}
          <div className="flex flex-col divide-y divide-navy/10 dark:divide-[#F2F1E6]/10">
            {/* Daily Schedule */}
            <div className="px-4 py-4">
              <div className="text-[10px] font-heading text-navy/60 dark:text-[#F2F1E6]/90 uppercase tracking-widest mb-3">
                Daily Schedule
              </div>
              <div className="flex flex-col gap-2.5">
                <div className="flex items-center justify-between gap-2">
                  <label className="text-xs font-mono text-navy dark:text-[#F2F1E6] whitespace-nowrap">Work Start</label>
                  <input type="time" value={workStart} onChange={(e) => setWorkStart(e.target.value)}
                    style={{ colorScheme: dark ? 'dark' : 'light' }}
                    className="text-xs font-mono rounded border border-navy/20 dark:border-[#F2F1E6]/20 bg-[#F2F1E6] dark:bg-navy text-navy dark:text-[#F2F1E6] px-2 py-1 focus:border-[#00e5ff] focus:outline-none" />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <label className="text-xs font-mono text-navy dark:text-[#F2F1E6] whitespace-nowrap">Work End</label>
                  <input type="time" value={workEnd} onChange={(e) => setWorkEnd(e.target.value)}
                    style={{ colorScheme: dark ? 'dark' : 'light' }}
                    className="text-xs font-mono rounded border border-navy/20 dark:border-[#F2F1E6]/20 bg-[#F2F1E6] dark:bg-navy text-navy dark:text-[#F2F1E6] px-2 py-1 focus:border-[#00e5ff] focus:outline-none" />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <label className="text-xs font-mono text-navy dark:text-[#F2F1E6]">Timezone</label>
                  <select value={timezone} onChange={(e) => setTimezone(e.target.value)}
                    className="text-xs font-mono rounded border border-navy/20 dark:border-[#F2F1E6]/20 bg-cream dark:bg-navy/40 text-navy dark:text-cream px-2 py-1 focus:border-[#00e5ff] focus:outline-none max-w-[160px]">
                    {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz.replace('America/', '').replace('Pacific/', '')}</option>)}
                  </select>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono text-navy dark:text-[#F2F1E6]">Task Popups</span>
                  <button onClick={() => setTaskPopups((v) => !v)}
                    className={['relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 focus:outline-none', taskPopups ? 'bg-[#4F7489]' : 'bg-navy/20'].join(' ')}>
                    <span className={['inline-block h-3.5 w-3.5 rounded-full bg-white shadow transform transition-transform duration-200', taskPopups ? 'translate-x-[18px]' : 'translate-x-0.5'].join(' ')} />
                  </button>
                </div>
              </div>
            </div>

            {/* End of Day Review */}
            <div className="px-4 py-4">
              <div className="text-[10px] font-heading text-navy/60 dark:text-[#F2F1E6]/90 uppercase tracking-widest mb-3">
                End of Day Review
              </div>
              <div className="flex flex-col gap-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono text-navy dark:text-[#F2F1E6]">Enable EOD Prompt</span>
                  <button onClick={() => setEodEnabled((v) => !v)}
                    className={['relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 focus:outline-none', eodEnabled ? 'bg-[#4F7489]' : 'bg-navy/20'].join(' ')}>
                    <span className={['inline-block h-3.5 w-3.5 rounded-full bg-white shadow transform transition-transform duration-200', eodEnabled ? 'translate-x-[18px]' : 'translate-x-0.5'].join(' ')} />
                  </button>
                </div>
                {eodEnabled && (
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-xs font-mono text-navy dark:text-[#F2F1E6] whitespace-nowrap">Prompt at</label>
                    <input type="time" value={eodTime} onChange={(e) => setEodTime(e.target.value)}
                      style={{ colorScheme: dark ? 'dark' : 'light' }}
                      className="text-xs font-mono rounded border border-navy/20 dark:border-[#F2F1E6]/20 bg-[#F2F1E6] dark:bg-navy text-navy dark:text-[#F2F1E6] px-2 py-1 focus:border-[#00e5ff] focus:outline-none" />
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono text-navy dark:text-[#F2F1E6]">Auto-push incomplete</span>
                  <button onClick={() => setAutoPush((v) => !v)}
                    className={['relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 focus:outline-none', autoPush ? 'bg-[#4F7489]' : 'bg-navy/20'].join(' ')}>
                    <span className={['inline-block h-3.5 w-3.5 rounded-full bg-white shadow transform transition-transform duration-200', autoPush ? 'translate-x-[18px]' : 'translate-x-0.5'].join(' ')} />
                  </button>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono text-navy dark:text-[#F2F1E6]">Skip weekends &amp; holidays</span>
                  <button onClick={() => setSkipWeekends((v) => !v)}
                    className={['relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 focus:outline-none', skipWeekends ? 'bg-[#4F7489]' : 'bg-navy/20'].join(' ')}>
                    <span className={['inline-block h-3.5 w-3.5 rounded-full bg-white shadow transform transition-transform duration-200', skipWeekends ? 'translate-x-[18px]' : 'translate-x-0.5'].join(' ')} />
                  </button>
                </div>
              </div>
              <button onClick={saveSchedule} disabled={schedSaving}
                className={['mt-3 w-full text-xs font-mono rounded px-3 py-1.5 transition-colors', schedSaved ? 'bg-green-600 text-white' : 'bg-navy dark:bg-[#4F7489] text-cream hover:bg-inky disabled:opacity-40'].join(' ')}>
                {schedSaving ? 'Saving…' : schedSaved ? '✓ Saved' : 'Save Schedule'}
              </button>
            </div>

            {/* My Blocked Days */}
            <div className="px-4 py-4">
              <div className="text-[10px] font-heading text-navy/60 dark:text-[#F2F1E6]/90 uppercase tracking-widest mb-1">
                My Blocked Days
              </div>
              <p className="text-[10px] font-mono text-inky/70 dark:text-[#F2F1E6]/50 mb-3">
                Tasks won&apos;t push to these dates.
              </p>
              <div className="flex flex-col gap-2 mb-3">
                <input
                  type="date"
                  value={newBlockedDate}
                  onChange={(e) => setNewBlockedDate(e.target.value)}
                  style={{ colorScheme: dark ? 'dark' : 'light' }}
                  className="text-xs font-mono rounded border border-navy/20 dark:border-[#F2F1E6]/20 bg-[#F2F1E6] dark:bg-[#0D3555] text-navy dark:text-[#F2F1E6] px-2 py-1 focus:border-[#00e5ff] focus:outline-none"
                />
                <input
                  type="text"
                  value={newBlockedNote}
                  onChange={(e) => setNewBlockedNote(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addBlockedDay()}
                  placeholder="Note (optional)"
                  className="text-xs font-mono rounded border border-navy/20 dark:border-[#F2F1E6]/20 bg-[#F2F1E6] dark:bg-[#0D3555] text-navy dark:text-[#F2F1E6] placeholder-inky/50 px-2 py-1 focus:border-[#00e5ff] focus:outline-none"
                />
                <button
                  onClick={addBlockedDay}
                  disabled={!newBlockedDate}
                  className="text-xs font-mono rounded px-2 py-1 bg-navy dark:bg-[#4F7489] text-cream hover:bg-inky disabled:opacity-40 transition-colors"
                >
                  + Add
                </button>
              </div>
              {blockedDays.length === 0 ? (
                <p className="text-[10px] font-mono text-inky/50 dark:text-[#F2F1E6]/40 italic">No blocked days.</p>
              ) : (
                <div className="flex flex-col gap-1.5 max-h-40 overflow-y-auto">
                  {blockedDays.map((bd) => (
                    <div key={bd.date} className="flex items-center justify-between gap-2">
                      <span className="text-[10px] font-mono text-navy dark:text-[#F2F1E6] flex-1 min-w-0 break-words">
                        {formatBlockedDayLabel(bd)}
                      </span>
                      <button
                        onClick={() => removeBlockedDayEntry(bd.date)}
                        className="text-[10px] font-mono text-inky/50 hover:text-[#C0392B] dark:text-[#F2F1E6]/40 dark:hover:text-[#C0392B] transition-colors flex-shrink-0"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Full-width footer — rarely touched once set */}
        <div className="border-t border-navy/10 dark:border-[#F2F1E6]/10 grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-navy/10 dark:divide-[#F2F1E6]/10">
          {/* Outlook Sync (placeholder for Phase 9) */}
          <div className="px-4 py-4">
            <div className="text-[10px] font-heading text-navy/60 dark:text-[#F2F1E6]/90 uppercase tracking-widest mb-3">
              Integrations
            </div>
            <div className="flex items-center justify-between opacity-40 cursor-not-allowed" title="Available after Microsoft login is configured">
              <div>
                <div className="text-sm font-body text-navy dark:text-cream">Outlook Calendar Sync</div>
                <div className="text-[10px] font-mono text-inky dark:text-[#F2F1E6]/70 mt-0.5 leading-relaxed">
                  Sync your Outlook calendar to SB Net
                </div>
              </div>
              <div className="h-5 w-9 rounded-full bg-navy/20 flex-shrink-0" />
            </div>
          </div>

          {/* Admin link */}
          {isAdminOrDeveloper(profile?.role) ? (
            <div className="px-4 py-4">
              <div className="text-[10px] font-heading text-navy/60 dark:text-[#F2F1E6]/90 uppercase tracking-widest mb-3">
                Administration
              </div>
              <NavLink
                to="/admin/users"
                onClick={onClose}
                className="flex items-center gap-2 text-sm font-body text-navy dark:text-[#F2F1E6] hover:text-inky dark:hover:text-[#F2F1E6]/80 transition-colors"
              >
                {ICONS.users}
                User Management
              </NavLink>
              <NavLink
                to="/dev-hub"
                onClick={onClose}
                className="flex items-center gap-2 mt-2 text-sm font-body text-navy dark:text-[#F2F1E6] hover:text-inky dark:hover:text-[#F2F1E6]/80 transition-colors"
              >
                <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
                </svg>
                Developer Hub
              </NavLink>
            </div>
          ) : <div />}

          {/* Sign out */}
          <div className="px-4 py-4 flex items-start">
            <button
              onClick={() => supabase.auth.signOut()}
              className="flex items-center gap-2 text-sm font-body text-[#C0392B] hover:text-[#A93226] transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
              Sign out
            </button>
          </div>
        </div>
        </div>
      </div>
    </div>
  )
}
