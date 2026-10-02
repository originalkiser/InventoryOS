// Admin side of the shareable Shop Links directory — mint / list / revoke the
// tokenized links behind menu.sboc.app/directory/<token> (see
// PublicMenuBoardDirectoryPage.tsx and migrations 20260930ce/cg/ci/cl). Any
// number of links can be live at once, each revocable on its own.
//
// Three text fields, on purpose kept separate: the PAGE TITLE (`label`) is
// what the person who opens the link sees at the top of the page; the LINK
// LABEL and NOTES (`link_label`, `notes`) are internal-only — never returned
// by get_menu_board_directory — so admins can tell links apart and remember
// when/why each was made (the creation date and creator are shown with them).
import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { Button, Modal, Toggle, SbLoader } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useUserNames } from '@/modules/orders-v2/useLookups'

const sb = () => supabase as any

interface DirectoryShareRow {
  token: string; label: string | null; link_label: string | null; notes: string | null
  include_emails: boolean; scope: 'active' | 'upcoming'; group_filter: string | null; include_recent: boolean
  created_by: string | null; created_at: string
}

const FIELD = 'w-full bg-cream border border-navy/40 rounded px-3 py-2 text-sm font-body text-navy placeholder-inky/60 focus:outline-none focus:ring-2 focus:ring-sky'
const FIELD_LABEL = 'text-[10px] font-mono uppercase tracking-widest text-inky/70'
const whenFmt = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export function ShareDirectoryModal({ baseUrl, onClose }: { baseUrl: string; onClose: () => void }) {
  const { profile } = useAuthStore()
  const names = useUserNames()
  const companyId = profile?.company_id ?? null
  const [rows, setRows] = useState<DirectoryShareRow[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [label, setLabel] = useState('')           // page title (shown on the shared page)
  const [linkLabel, setLinkLabel] = useState('')   // internal
  const [notes, setNotes] = useState('')           // internal
  const [includeEmails, setIncludeEmails] = useState(false)
  // 'upcoming' = shops not open yet (inactive, no Date Opened) with whatever package pricing is filled in.
  const [scope, setScope] = useState<'active' | 'upcoming'>('active')
  const [groupFilter, setGroupFilter] = useState('Pre-Opening')
  // Upcoming links only: a second table underneath of shops opened or acquired in the last 90 days.
  const [includeRecent, setIncludeRecent] = useState(false)
  // Inline edit of an existing link's three text fields.
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ label: string; link_label: string; notes: string }>({ label: '', link_label: '', notes: '' })

  const urlFor = (token: string) => `${baseUrl}directory/${token}`

  const load = useCallback(async () => {
    if (!companyId) { setLoading(false); return }
    const { data } = await sb().schema('marketing').from('menu_board_directory_shares')
      .select('token, label, link_label, notes, include_emails, scope, group_filter, include_recent, created_by, created_at')
      .eq('company_id', companyId).eq('active', true).order('created_at', { ascending: false })
    setRows((data ?? []) as DirectoryShareRow[])
    setLoading(false)
  }, [companyId])
  useEffect(() => { load() }, [load])

  async function create() {
    if (!companyId) return
    setCreating(true)
    const { data, error } = await sb().schema('marketing').from('menu_board_directory_shares')
      .insert({
        company_id: companyId, label: label.trim() || null, link_label: linkLabel.trim() || null, notes: notes.trim() || null,
        include_emails: includeEmails, scope,
        group_filter: scope === 'upcoming' ? (groupFilter.trim() || null) : null,
        include_recent: scope === 'upcoming' && includeRecent, created_by: profile?.id ?? null,
      })
      .select('token').single()
    setCreating(false)
    if (error) { toast.error(error.message); return }
    await navigator.clipboard.writeText(urlFor(data.token)).catch(() => {})
    toast.success('Link created and copied')
    setLabel(''); setLinkLabel(''); setNotes('')
    load()
  }

  async function saveEdit(token: string) {
    const patch = { label: draft.label.trim() || null, link_label: draft.link_label.trim() || null, notes: draft.notes.trim() || null }
    const { error } = await sb().schema('marketing').from('menu_board_directory_shares').update(patch).eq('token', token)
    if (error) { toast.error(error.message); return }
    setRows((r) => r.map((x) => (x.token === token ? { ...x, ...patch } : x)))
    setEditing(null)
  }

  async function revoke(token: string) {
    const { error } = await sb().schema('marketing').from('menu_board_directory_shares').update({ active: false }).eq('token', token)
    if (error) { toast.error(error.message); return }
    setRows((r) => r.filter((x) => x.token !== token))
  }

  return (
    <Modal open onClose={onClose} title="Share shop links table" size="2xl">
      <div className="flex flex-col gap-4">
        <p className="text-xs font-mono text-inky">
          Creates a no-login page listing shops' menu board links, QR codes and PDF links. It stays current on its own —
          new shops show up automatically — so the same link can be shared once and reused.
        </p>

        <div className="flex flex-col gap-3">
          <span className={FIELD_LABEL}>New link</span>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className={FIELD_LABEL}>Page title <span className="normal-case text-inky/50">— shown on the shared page</span></span>
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. PM Pre-Opening" className={FIELD} />
            </label>
            <label className="flex flex-col gap-1">
              <span className={FIELD_LABEL}>Link label <span className="normal-case text-inky/50">— internal, not shown on the page</span></span>
              <input value={linkLabel} onChange={(e) => setLinkLabel(e.target.value)} placeholder="e.g. Project Management — Oct 2026" className={FIELD} />
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className={FIELD_LABEL}>Notes <span className="normal-case text-inky/50">— internal: why this link was made, who it went to</span></span>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="e.g. Sent to the PM team to distribute boards for new shops" className={`${FIELD} resize-y`} />
          </label>

          <span className={`${FIELD_LABEL} mt-1`}>Link settings</span>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
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
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 items-start">
            {scope === 'upcoming' && (
              <label className="flex flex-col gap-1 text-[10px] font-mono text-inky/70 md:col-span-2">
                Only Monday groups containing (leave blank for all upcoming shops)
                <input value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} placeholder="e.g. Pre-Opening" className={FIELD} />
              </label>
            )}
            {scope === 'upcoming' && (
              <label className="flex items-center gap-2 text-xs font-mono text-inky cursor-pointer">
                <Toggle checked={includeRecent} onChange={setIncludeRecent} size="sm" />
                Add a second table: shops opened or acquired in the last 90 days
              </label>
            )}
            <label className="flex items-center gap-2 text-xs font-mono text-inky cursor-pointer">
              <Toggle checked={includeEmails} onChange={setIncludeEmails} size="sm" />
              Include shop and area manager emails
            </label>
          </div>
          <div><Button size="sm" onClick={create} disabled={creating}>{creating ? 'Creating…' : 'Create link'}</Button></div>
        </div>

        <div className="flex flex-col gap-2 border-t border-navy/10 pt-3">
          <span className={FIELD_LABEL}>Active links</span>
          {loading ? (
            <div className="py-3 flex justify-center"><SbLoader size={22} /></div>
          ) : rows.length === 0 ? (
            <span className="text-xs font-mono text-inky/40 italic">None yet.</span>
          ) : rows.map((r) => {
            const title = r.label || (r.scope === 'upcoming' ? 'Upcoming shops' : 'Shop links table')
            const creator = r.created_by ? names.nameOf(r.created_by) : ''
            const chips = [
              r.scope === 'upcoming' ? `Upcoming shops${r.group_filter ? ` · group: ${r.group_filter}` : ''}` : 'Active shops',
              ...(r.include_recent ? ['+ last 90 days table'] : []),
              ...(r.include_emails ? ['includes emails'] : []),
            ]
            return (
              <div key={r.token} className="rounded border border-navy/15 px-3 py-2 flex flex-col gap-1.5">
                {editing === r.token ? (
                  <div className="flex flex-col gap-2">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                      <label className="flex flex-col gap-1"><span className={FIELD_LABEL}>Page title (shown on page)</span>
                        <input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} className={FIELD} /></label>
                      <label className="flex flex-col gap-1"><span className={FIELD_LABEL}>Link label (internal)</span>
                        <input value={draft.link_label} onChange={(e) => setDraft({ ...draft, link_label: e.target.value })} className={FIELD} /></label>
                    </div>
                    <label className="flex flex-col gap-1"><span className={FIELD_LABEL}>Notes (internal)</span>
                      <textarea value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} rows={2} className={`${FIELD} resize-y`} /></label>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => saveEdit(r.token)}>Save</Button>
                      <Button size="sm" variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-mono text-navy font-bold truncate">{r.link_label || title}</div>
                        <div className="text-[10px] font-mono text-inky/60">
                          Created {whenFmt(r.created_at)}{creator ? ` by ${creator}` : ''}
                          {r.link_label && <> · page title: <span className="text-navy">{title}</span></>}
                        </div>
                        {r.notes && <div className="text-[11px] font-mono text-inky mt-0.5 whitespace-pre-wrap">{r.notes}</div>}
                      </div>
                      <button onClick={() => { setEditing(r.token); setDraft({ label: r.label ?? '', link_label: r.link_label ?? '', notes: r.notes ?? '' }) }}
                        className="text-[10px] font-mono text-sky hover:underline shrink-0">edit</button>
                      <button onClick={() => { navigator.clipboard.writeText(urlFor(r.token)); toast.success('Copied') }}
                        className="text-[10px] font-mono text-sky hover:underline shrink-0">copy</button>
                      <button onClick={() => revoke(r.token)} className="text-[10px] font-mono text-[#C0392B] hover:underline shrink-0">revoke</button>
                    </div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {chips.map((c) => <span key={c} className="text-[9px] font-mono rounded border border-navy/20 text-inky px-1.5 py-0.5">{c}</span>)}
                      <span className="text-[10px] font-mono text-inky/50 truncate">{urlFor(r.token)}</span>
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </Modal>
  )
}
