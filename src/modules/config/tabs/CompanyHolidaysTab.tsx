import { useEffect, useState } from 'react'
import { format } from 'date-fns'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { Button } from '@/components/ui'
import toast from 'react-hot-toast'
import type { CompanyHoliday } from '@/types'

export function CompanyHolidaysTab() {
  const { profile } = useAuthStore()
  const [holidays, setHolidays] = useState<CompanyHoliday[]>([])
  const [loading, setLoading] = useState(true)
  const [yearView, setYearView] = useState(new Date().getFullYear())
  const [addDate, setAddDate] = useState('')
  const [addName, setAddName] = useState('')
  const [adding, setAdding] = useState(false)

  useEffect(() => { if (profile?.company_id) load() }, [profile?.company_id])

  async function load() {
    if (!profile?.company_id) return
    setLoading(true)
    const { data, error } = await (supabase as any).schema('core').from('company_holidays')
      .select('*')
      .eq('company_id', profile.company_id)
      .order('date', { ascending: true })
    if (error) toast.error('Failed to load holidays')
    setHolidays(data ?? [])
    setLoading(false)
  }

  async function addHoliday() {
    if (!addDate || !profile?.company_id) return
    setAdding(true)
    const { error } = await (supabase as any).schema('core').from('company_holidays').insert({
      company_id: profile.company_id,
      date: addDate,
      name: addName.trim() || format(new Date(addDate + 'T00:00:00'), 'MMMM d'),
      created_by: profile.id,
    })
    if (error) toast.error(error.message)
    else { setAddDate(''); setAddName(''); await load() }
    setAdding(false)
  }

  async function removeHoliday(id: string) {
    const { error } = await (supabase as any).schema('core').from('company_holidays').delete().eq('id', id)
    if (error) toast.error(error.message)
    else { setHolidays((prev) => prev.filter((h) => h.id !== id)) }
  }

  const displayed = holidays.filter((h) => new Date(h.date + 'T00:00:00').getFullYear() === yearView)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-sm font-bold text-navy uppercase tracking-wide">Company Holidays</h2>
        <p className="text-xs text-inky mt-0.5">
          Shared holiday calendar for your company. Holidays are skipped when the
          &quot;Skip weekends &amp; holidays&quot; option is on in profile settings.
        </p>
      </div>

      {/* Add form */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-mono text-inky uppercase tracking-wide">Date</label>
          <input
            type="date"
            value={addDate}
            onChange={(e) => setAddDate(e.target.value)}
            className="text-xs font-mono rounded border border-navy/30 bg-cream px-2 py-1.5 text-navy focus:border-[#00e5ff] focus:outline-none"
          />
        </div>
        <div className="flex flex-col gap-1 flex-1 min-w-[160px]">
          <label className="text-[10px] font-mono text-inky uppercase tracking-wide">Name (optional)</label>
          <input
            type="text"
            value={addName}
            onChange={(e) => setAddName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addHoliday()}
            placeholder="e.g. Labor Day"
            className="text-xs font-mono rounded border border-navy/30 bg-cream px-2 py-1.5 text-navy placeholder-inky/50 focus:border-[#00e5ff] focus:outline-none"
          />
        </div>
        <Button size="sm" onClick={addHoliday} loading={adding} disabled={!addDate}>
          + Add Holiday
        </Button>
      </div>

      {/* Year navigation */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => setYearView((y) => y - 1)}
          className="text-xs font-mono text-inky hover:text-navy transition-colors"
        >
          ← {yearView - 1}
        </button>
        <span className="text-sm font-bold text-navy">{yearView}</span>
        <button
          onClick={() => setYearView((y) => y + 1)}
          className="text-xs font-mono text-inky hover:text-navy transition-colors"
        >
          {yearView + 1} →
        </button>
      </div>

      {/* List */}
      {loading ? (
        <p className="text-xs text-inky/60 italic">Loading…</p>
      ) : displayed.length === 0 ? (
        <p className="text-xs text-inky/60 italic">No holidays for {yearView}. Add one above.</p>
      ) : (
        <div className="rounded border border-navy/20 divide-y divide-navy/10">
          {displayed.map((h) => (
            <div key={h.id} className="flex items-center gap-3 px-4 py-2.5">
              <span className="text-xs font-mono text-navy w-36 flex-shrink-0">
                {format(new Date(h.date + 'T00:00:00'), 'EEE, MMM d, yyyy')}
              </span>
              <span className="text-xs font-body text-inky flex-1">{h.name}</span>
              <button
                onClick={() => removeHoliday(h.id)}
                className="text-[10px] font-mono text-inky/50 hover:text-[#C0392B] transition-colors flex-shrink-0"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
