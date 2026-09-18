// Non-login share links for a form's Results table (2026-09-18) — an admin
// can mint any number of tokenized links for one form, each independently
// 'read' (view only) or 'edit' (same override + tracking-column editing an
// internal canWrite user already has, gated server-side — see
// submission_share_save_override/_save_column_value in migration
// 20260930ag_forms_submission_shares.sql), with an optional expiration.
// Reachable at /results/:token on the main app domain (no new subdomain
// needed, unlike Menu Board/Forms' own custom-URL features — this route
// doesn't collide with anything and needs no Cloudflare/DNS setup).
import { useEffect, useState } from 'react'
import { Toggle } from '@/components/ui'
import { useAuthStore } from '@/stores/authStore'
import {
  loadSubmissionShares, createSubmissionShare, updateSubmissionShare, deleteSubmissionShare,
} from '@/hooks/useForms'
import type { SubmissionShare } from '@/types/forms'
import { format } from 'date-fns'
import toast from 'react-hot-toast'

const RESULTS_BASE_URL = `${window.location.origin}/results/`

export function ShareSubmissionsModal({ formId, onClose }: { formId: string; onClose: () => void }) {
  const { profile } = useAuthStore()
  const [shares, setShares] = useState<SubmissionShare[]>([])
  const [loading, setLoading] = useState(true)
  const [label, setLabel] = useState('')
  const [permission, setPermission] = useState<'read' | 'edit'>('read')
  const [expiresAt, setExpiresAt] = useState('')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    loadSubmissionShares(formId).then((rows) => { setShares(rows); setLoading(false) })
  }, [formId])

  async function create() {
    if (!profile?.company_id) return
    setCreating(true)
    const share = await createSubmissionShare({
      formId,
      companyId: profile.company_id,
      createdBy: profile.id ?? null,
      label: label.trim() || null,
      permission,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    })
    setCreating(false)
    if (!share) return
    setShares((p) => [share, ...p])
    setLabel(''); setPermission('read'); setExpiresAt('')
    toast.success('Share link created')
  }

  async function toggleActive(share: SubmissionShare) {
    const next = !share.active
    setShares((p) => p.map((s) => s.token === share.token ? { ...s, active: next } : s))
    await updateSubmissionShare(share.token, { active: next })
  }

  async function remove(share: SubmissionShare) {
    if (!confirm('Delete this share link? Anyone holding it will lose access immediately.')) return
    setShares((p) => p.filter((s) => s.token !== share.token))
    await deleteSubmissionShare(share.token)
  }

  function urlFor(share: SubmissionShare) {
    return `${RESULTS_BASE_URL}${share.token}`
  }

  function isExpired(share: SubmissionShare) {
    return !!share.expires_at && new Date(share.expires_at) < new Date()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy/60 backdrop-blur-sm">
      <div className="w-full max-w-lg bg-cream rounded-lg border border-navy/30 shadow-2xl p-6 flex flex-col gap-4 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-heading font-bold text-navy uppercase tracking-wide">Share Results</h3>
          <button onClick={onClose} className="text-inky/50 hover:text-navy">✕</button>
        </div>
        <p className="text-[10px] font-mono text-inky/60">
          Anyone with a link below can view (or, for an edit link, correct responses and update tracking columns) this form's results — no SB Net login required.
        </p>

        {/* New link form */}
        <div className="border border-navy/20 rounded p-3 flex flex-col gap-2">
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (optional) — e.g. Legal Team"
            className="rounded border border-navy/30 bg-cream px-2 py-1 text-xs font-mono text-navy focus:border-[#00e5ff] focus:outline-none" />
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex rounded border border-navy/20 overflow-hidden">
              {(['read', 'edit'] as const).map((p) => (
                <button key={p} onClick={() => setPermission(p)}
                  className={['px-2.5 py-1 text-[10px] font-mono uppercase tracking-wide', permission === p ? 'bg-navy text-cream' : 'text-inky hover:bg-navy/5'].join(' ')}>
                  {p === 'read' ? 'Read Only' : 'Can Edit'}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-1.5 text-[10px] font-mono text-inky">
              Expires
              <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)}
                className="rounded border border-navy/30 bg-cream px-1.5 py-1 text-[10px] font-mono text-navy focus:border-[#00e5ff] focus:outline-none" />
            </label>
            {expiresAt && (
              <button onClick={() => setExpiresAt('')} className="text-[10px] font-mono text-inky/50 hover:text-navy underline">clear</button>
            )}
            <div className="flex-1" />
            <button onClick={create} disabled={creating}
              className="text-xs font-mono bg-navy text-cream rounded px-3 py-1.5 hover:bg-inky disabled:opacity-40">
              {creating ? 'Creating…' : '+ New Link'}
            </button>
          </div>
        </div>

        {/* Existing links */}
        <div className="flex flex-col gap-2">
          {loading ? (
            <p className="text-xs font-mono text-inky/50 text-center py-4">Loading…</p>
          ) : shares.length === 0 ? (
            <p className="text-xs font-mono text-inky/50 text-center py-4">No share links yet.</p>
          ) : shares.map((share) => (
            <div key={share.token} className="border border-navy/10 rounded p-2.5 flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-heading font-bold text-navy truncate">{share.label || '(unlabeled link)'}</span>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className={['text-[9px] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded border', share.permission === 'edit' ? 'border-[#E67E22]/50 text-[#E67E22]' : 'border-navy/20 text-inky/60'].join(' ')}>
                    {share.permission === 'edit' ? 'Can Edit' : 'Read Only'}
                  </span>
                  <Toggle checked={share.active} onChange={() => toggleActive(share)} size="sm" />
                  <button onClick={() => remove(share)} className="text-[10px] font-mono text-red-500 hover:text-red-700">Delete</button>
                </div>
              </div>
              <div className="flex gap-2">
                <input readOnly value={urlFor(share)} className="flex-1 rounded border border-navy/30 bg-navy/5 px-2 py-1 text-[10px] font-mono text-navy focus:outline-none" />
                <button onClick={() => { navigator.clipboard.writeText(urlFor(share)); toast.success('Link copied') }}
                  className="text-[10px] font-mono border border-navy/20 rounded px-2 py-1 text-inky hover:border-navy/40">
                  Copy
                </button>
              </div>
              <div className="flex items-center gap-2 text-[9px] font-mono text-inky/50">
                <span>Created {format(new Date(share.created_at), 'MMM d, yyyy')}</span>
                {share.expires_at && (
                  <span className={isExpired(share) ? 'text-red-500' : ''}>
                    · {isExpired(share) ? 'Expired' : 'Expires'} {format(new Date(share.expires_at), 'MMM d, yyyy')}
                  </span>
                )}
                {!share.active && <span className="text-red-500">· Revoked</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
