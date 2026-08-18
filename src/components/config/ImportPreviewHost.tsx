import { useEffect, useState } from 'react'
import { Button, Modal } from '@/components/ui'

// Summary of what an import is about to do, computed before anything is written.
export interface ImportSummary {
  mode: 'merge' | 'replace'
  total: number
  updates: number
  creates: number
  deletes: number      // replace mode only — rows about to be wiped
  newRows: string[]    // identifiers of the rows that will be created
}

// Single mounted host (like react-hot-toast's <Toaster/>) so any import can
// raise the confirmation without every config tab having to render a modal.
let openFn: ((s: ImportSummary) => Promise<boolean>) | null = null

/**
 * Show the pre-import review and resolve with the user's choice. If the host
 * isn't mounted (tests, isolated renders) this resolves true rather than
 * silently swallowing the import.
 */
export function requestImportConfirm(summary: ImportSummary): Promise<boolean> {
  if (!openFn) return Promise.resolve(true)
  return openFn(summary)
}

const MAX_LISTED = 200

export function ImportPreviewHost() {
  const [pending, setPending] = useState<{ s: ImportSummary; resolve: (ok: boolean) => void } | null>(null)

  useEffect(() => {
    openFn = (s) => new Promise<boolean>((resolve) => setPending({ s, resolve }))
    return () => { openFn = null }
  }, [])

  function close(ok: boolean) {
    pending?.resolve(ok)
    setPending(null)
  }

  const s = pending?.s
  const listed = s ? s.newRows.slice(0, MAX_LISTED) : []
  const extra = s ? s.newRows.length - listed.length : 0
  // A merge that creates far more rows than it updates usually means the key
  // column was mapped wrong — the rows get added as duplicates instead of
  // updating the existing ones.
  const suspiciousMerge = !!s && s.mode === 'merge' && s.creates > 0 && s.creates >= s.updates

  return (
    <Modal open={!!pending} onClose={() => close(false)} title="Review Import" size="lg">
      {s && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Rows in file" value={s.total} />
            <Stat label="Existing rows updated" value={s.updates} />
            <Stat label="New rows added" value={s.creates} tone={s.creates > 0 ? 'warn' : undefined} />
          </div>

          {s.mode === 'replace' && (
            <div className="rounded border border-[#C0392B]/40 bg-[#C0392B]/5 px-3 py-2">
              <span className="text-[10px] font-mono uppercase tracking-widest text-[#C0392B]">Replace all</span>
              <p className="text-xs font-body text-navy leading-relaxed mt-1">
                All <strong>{s.deletes.toLocaleString()}</strong> existing row{s.deletes !== 1 ? 's' : ''} will be
                deleted first, then re-created from the file with <strong>new internal ids</strong>. Anything
                referencing the current rows will be orphaned. Use <strong>"Update changes only"</strong> unless you
                genuinely intend that.
              </p>
            </div>
          )}

          {suspiciousMerge && (
            <div className="rounded border border-[#E67E22]/40 bg-[#E67E22]/10 px-3 py-2">
              <span className="text-[10px] font-mono uppercase tracking-widest text-[#E67E22]">Check the mapping</span>
              <p className="text-xs font-body text-navy leading-relaxed mt-1">
                Most rows in this file didn't match anything existing, so they'll be added as new records rather than
                updating current ones. If you expected these to update, cancel and re-check the column you mapped as
                the identifier — a mismatched key creates duplicates instead.
              </p>
            </div>
          )}

          {s.creates > 0 ? (
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">
                New records being added ({s.creates.toLocaleString()})
              </span>
              <div className="max-h-60 overflow-auto rounded border border-navy/20 divide-y divide-navy/10">
                {listed.map((label, i) => (
                  <div key={`${label}-${i}`} className="px-2 py-1 text-xs font-mono text-navy break-all">
                    {label || <span className="text-inky/40 italic">(blank identifier)</span>}
                  </div>
                ))}
              </div>
              {extra > 0 && (
                <span className="text-[10px] font-mono text-inky/50">…and {extra.toLocaleString()} more not listed</span>
              )}
            </div>
          ) : (
            <p className="text-xs font-body text-inky">
              No new records — every row in this file matches something that already exists and will be updated in place.
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => close(false)}>Cancel</Button>
            <Button
              variant={s.mode === 'replace' ? 'danger' : 'primary'}
              size="sm"
              onClick={() => close(true)}
            >
              {s.mode === 'replace'
                ? `Replace all ${s.deletes.toLocaleString()} rows`
                : s.creates > 0
                  ? `Update ${s.updates.toLocaleString()} · Add ${s.creates.toLocaleString()}`
                  : `Update ${s.updates.toLocaleString()} rows`}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'warn' }) {
  return (
    <div className={[
      'rounded border px-2 py-1.5 flex flex-col',
      tone === 'warn' ? 'border-[#E67E22]/40 bg-[#E67E22]/10' : 'border-navy/20 bg-navy/[0.03]',
    ].join(' ')}>
      <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">{label}</span>
      <span className="text-lg font-heading font-bold text-navy">{value.toLocaleString()}</span>
    </div>
  )
}
