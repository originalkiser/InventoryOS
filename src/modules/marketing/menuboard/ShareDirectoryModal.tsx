// Admin side of the shareable Shop Links directory — mint / list / revoke the
// tokenized links behind menu.sboc.app/directory/<token> (see
// PublicMenuBoardDirectoryPage.tsx and migration 20260930ce). Any number of
// links can be live at once, each revocable on its own; emails are opt-in
// per link.
import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { Button, Modal, Toggle, SbLoader } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'

const sb = () => supabase as any

interface DirectoryShareRow { token: string; label: string | null; include_emails: boolean; scope: 'active' | 'upcoming'; group_filter: string | null; include_recent: boolean; created_at: string }

export function ShareDirectoryModal({ baseUrl, onClose }: { baseUrl: string; onClose: () => void }) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [rows, setRows] = useState<DirectoryShareRow[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [label, setLabel] = useState('')
  const [includeEmails, setIncludeEmails] = useState(false)
  // 'upcoming' = shops not open yet (inactive, no Date Opened) with whatever package pricing is filled in.
  const [scope, setScope] = useState<'active' | 'upcoming'>('active')
  const [groupFilter, setGroupFilter] = useState('Pre-Opening')
  // Upcoming links only: a second table underneath of shops opened or acquired in the last 90 days.
  const [includeRecent, setIncludeRecent] = useState(false)

  const urlFor = (token: string) => `${baseUrl}directory/${token}`

  const load = useCallback(async () => {
    if (!companyId) { setLoading(false); return }
    const { data } = await sb().schema('marketing').from('menu_board_directory_shares')
      .select('token, label, include_emails, scope, group_filter, include_recent, created_at').eq('company_id', companyId).eq('active', true)
      .order('created_at', { ascending: false })
    setRows((data ?? []) as DirectoryShareRow[])
    setLoading(false)
  }, [companyId])
  useEffect(() => { load() }, [load])

  async function create() {
    if (!companyId) return
    setCreating(true)
    const { data, error } = await sb().schema('marketing').from('menu_board_directory_shares')
      .insert({
        company_id: companyId, label: label.trim() || null, include_emails: includeEmails, scope,
        group_filter: scope === 'upcoming' ? (groupFilter.trim() || null) : null,
        include_recent: scope === 'upcoming' && includeRecent, created_by: profile?.id ?? null,
      })
      .select('token').single()
    setCreating(false)
    if (error) { toast.error(error.message); return }
    await navigator.clipboard.writeText(urlFor(data.token)).catch(() => {})
    toast.success('Link created and copied')
    setLabel('')
    load()
  }

  async function revoke(token: string) {
    const { error } = await sb().schema('marketing').from('menu_board_directory_shares').update({ active: false }).eq('token', token)
    if (error) { toast.error(error.message); return }
    setRows((r) => r.filter((x) => x.token !== token))
  }

  return (
    <Modal open onClose={onClose} title="Share shop links table" size="md">
      <div className="flex flex-col gap-4">
        <p className="text-xs font-mono text-inky">
          Creates a no-login page listing every active shop's menu board link, QR code and PDF link. It stays current on
          its own — new shops show up automatically — so the same link can be shared once and reused.
        </p>

        <div className="flex flex-col gap-2">
          <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">New link</span>
          <div className="flex flex-col gap-1.5">
            {([
              ['active', 'Active shops', 'Every open shop — board link, QR code and PDF.'],
              ['upcoming', 'Upcoming shops', 'Shops not open yet (inactive, no Date Opened) — listed once package pricing is added for them.'],
            ] as const).map(([key, title, desc]) => (
              <label key={key} className={`flex items-start gap-2 text-xs font-mono rounded border p-2 cursor-pointer ${scope === key ? 'border-sky bg-sky/5' : 'border-navy/20'}`}>
                <input type="radio" checked={scope === key} onChange={() => setScope(key)} className="mt-0.5 accent-sky" />
                <span><span className="text-navy font-bold">{title}</span><span className="block text-inky/60">{desc}</span></span>
              </label>
            ))}
          </div>
          {scope === 'upcoming' && (
            <label className="flex flex-col gap-1 text-[10px] font-mono text-inky/70">
              Only Monday groups containing (leave blank for all upcoming shops)
              <input value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} placeholder="e.g. Pre-Opening"
                className="w-full bg-cream border border-navy/40 rounded px-3 py-2 text-sm font-body text-navy placeholder-inky/60 focus:outline-none focus:ring-2 focus:ring-sky" />
            </label>
          )}
          {scope === 'upcoming' && (
            <label className="flex items-center gap-2 text-xs font-mono text-inky cursor-pointer">
              <Toggle checked={includeRecent} onChange={setIncludeRecent} size="sm" />
              Add a second table: shops opened or acquired in the last 90 days
            </label>
          )}
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (e.g. Project Management)"
            className="w-full bg-cream border border-navy/40 rounded px-3 py-2 text-sm font-body text-navy placeholder-inky/60 focus:outline-none focus:ring-2 focus:ring-sky" />
          <label className="flex items-center gap-2 text-xs font-mono text-inky cursor-pointer">
            <Toggle checked={includeEmails} onChange={setIncludeEmails} size="sm" />
            Include shop and area manager emails
          </label>
          <Button size="sm" onClick={create} disabled={creating}>{creating ? 'Creating…' : 'Create link'}</Button>
        </div>

        <div className="flex flex-col gap-2 border-t border-navy/10 pt-3">
          <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Active links</span>
          {loading ? (
            <div className="py-3 flex justify-center"><SbLoader size={22} /></div>
          ) : rows.length === 0 ? (
            <span className="text-xs font-mono text-inky/40 italic">None yet.</span>
          ) : rows.map((r) => (
            <div key={r.token} className="flex items-center gap-2 rounded border border-navy/15 px-2 py-1.5">
              <div className="flex-1 min-w-0">
                <div className="text-[11px] font-mono text-navy truncate">
                  {r.label || (r.scope === 'upcoming' ? 'Upcoming shops' : 'Shop links table')}
                  {r.scope === 'upcoming' && <span className="ml-1.5 text-inky/40">(upcoming{r.group_filter ? `: ${r.group_filter}` : ''}{r.include_recent ? ' + last 90 days' : ''})</span>}
                  {r.include_emails && <span className="ml-1.5 text-inky/40">(includes emails)</span>}
                </div>
                <div className="text-[10px] font-mono text-inky/50 truncate">{urlFor(r.token)}</div>
              </div>
              <button onClick={() => { navigator.clipboard.writeText(urlFor(r.token)); toast.success('Copied') }}
                className="text-[10px] font-mono text-sky hover:underline shrink-0">copy</button>
              <button onClick={() => revoke(r.token)} className="text-[10px] font-mono text-[#C0392B] hover:underline shrink-0">revoke</button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  )
}
