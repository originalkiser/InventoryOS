import { useState } from 'react'
import { useCommsConfig } from '@/modules/comms/useCommsConfig'
import { SYSTEM_COMM_TYPES } from '@/modules/comms/comms'
import { Card, CardHeader, CardBody, Button } from '@/components/ui'

type ListField = 'contactMethods' | 'whoContacted' | 'commTypes' | 'actionTaken'

const SECTIONS: { field: ListField; title: string; hint: string }[] = [
  {
    field: 'commTypes',
    title: 'Communication Types',
    hint: 'Shown in the Type column on Location Comms. "Offline Tank Monitor" and "Low VMI Coverage" are logged automatically by the Tank Monitors email workflow and always stay available here even if removed.',
  },
  { field: 'contactMethods', title: 'Contact Methods', hint: 'Shown in the Method column.' },
  { field: 'whoContacted', title: 'Who Contacted', hint: 'Shown in the Who column.' },
  { field: 'actionTaken', title: 'Action Taken', hint: 'Shown in the Action Taken column.' },
]

const chip = 'inline-flex items-center gap-1 px-2 py-0.5 text-xs font-mono bg-sky/10 text-navy border border-sky/30 rounded'
const inputCls = 'flex-1 bg-cream border border-navy/30 rounded px-2 py-1 text-xs font-mono text-navy placeholder-inky/40 focus:outline-none focus:border-sky'
const numCls = 'w-16 bg-cream border border-navy/30 rounded px-1.5 py-1 text-xs font-mono text-navy text-center focus:outline-none focus:border-sky'

export function LocationCommsConfigTab() {
  const { config, addOption, save, loaded } = useCommsConfig()
  const [drafts, setDrafts] = useState<Record<ListField, string>>({ contactMethods: '', whoContacted: '', commTypes: '', actionTaken: '' })

  function removeOption(field: ListField, value: string) {
    save({ ...config, [field]: config[field].filter((v) => v !== value) })
  }
  function commitDraft(field: ListField) {
    const v = drafts[field].trim()
    if (v) addOption(field, v)
    setDrafts((d) => ({ ...d, [field]: '' }))
  }

  if (!loaded) return <div className="text-xs font-mono text-inky py-8">Loading…</div>

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-sm font-bold text-navy uppercase tracking-wide">Location Comms — Options</h2>
        <p className="text-xs text-inky mt-0.5">
          Dropdown options for the Type / Method / Who / Action Taken columns on Location Comms, plus needs-action highlighting.
        </p>
      </div>

      {SECTIONS.map(({ field, title, hint }) => (
        <Card key={field}>
          <CardHeader><span className="text-xs font-mono text-navy uppercase tracking-wide">{title}</span></CardHeader>
          <CardBody className="flex flex-col gap-3">
            <p className="text-[11px] font-mono text-inky/60">{hint}</p>
            <div className="flex flex-wrap gap-1.5">
              {config[field].map((v) => {
                const isSystem = field === 'commTypes' && SYSTEM_COMM_TYPES.includes(v)
                return (
                  <span key={v} className={chip}>
                    {v}
                    {isSystem ? <span className="text-inky/40">(auto)</span> : (
                      <button onClick={() => removeOption(field, v)} className="text-inky/50 hover:text-[#C0392B]">×</button>
                    )}
                  </span>
                )
              })}
              {config[field].length === 0 && <span className="text-xs font-mono text-inky/40 italic">No options yet</span>}
            </div>
            <div className="flex gap-2 max-w-sm">
              <input
                value={drafts[field]}
                onChange={(e) => setDrafts((d) => ({ ...d, [field]: e.target.value }))}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitDraft(field) } }}
                placeholder="Add an option…"
                className={inputCls}
              />
              <Button size="sm" variant="secondary" onClick={() => commitDraft(field)} disabled={!drafts[field].trim()}>Add</Button>
            </div>
          </CardBody>
        </Card>
      ))}

      <Card>
        <CardHeader><span className="text-xs font-mono text-navy uppercase tracking-wide">Needs Action Highlighting</span></CardHeader>
        <CardBody className="flex flex-col gap-3">
          <p className="text-[11px] font-mono text-inky/60">
            A non-closed communication older than this highlights red and counts toward the nav badge, regardless of status otherwise.
          </p>
          <div className="flex items-center gap-2">
            <span className="text-xs font-body text-inky">Highlight red after</span>
            <input type="number" min={1} value={config.staleDays}
              onChange={(e) => save({ ...config, staleDays: Math.max(1, Number(e.target.value) || 1) })}
              className={numCls} />
            <span className="text-xs font-body text-inky">day(s) old.</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-body text-inky">"Bump" defers a red row for</span>
            <input type="number" min={1} value={config.bumpDays}
              onChange={(e) => save({ ...config, bumpDays: Math.max(1, Number(e.target.value) || 1) })}
              className={numCls} />
            <span className="text-xs font-body text-inky">day(s), then it highlights again.</span>
          </div>
        </CardBody>
      </Card>
    </div>
  )
}
