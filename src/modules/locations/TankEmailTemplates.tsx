import { useEffect, useRef, useState } from 'react'
import { Card, CardBody, Button, Input } from '@/components/ui'
import { TANK_EMAIL_TOKENS, type TankEmailKind, type TankEmailTemplate } from './tankEmail'
import toast from 'react-hot-toast'

interface Props {
  offline: TankEmailTemplate
  lowvmi: TankEmailTemplate
  onSave: (kind: TankEmailKind, tpl: TankEmailTemplate) => void
}

export function TankEmailTemplates({ offline, lowvmi, onSave }: Props) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs font-mono text-inky/60">
        Edit the email drafts used by “Start email communication”. Insert data fields with the tokens below — they’re replaced per shop when a draft is generated.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {TANK_EMAIL_TOKENS.map((t) => (
          <span key={t.token} className="inline-flex items-center gap-1 rounded border border-navy/15 bg-navy/[0.03] px-2 py-0.5 text-[11px] font-mono text-navy" title={t.label}>
            {`{{${t.token}}}`}
          </span>
        ))}
      </div>
      <TemplateEditor title="Offline Monitors" kind="offline" tpl={offline} onSave={onSave} withImage />
      <TemplateEditor title="Low VMI Coverage" kind="lowvmi" tpl={lowvmi} onSave={onSave} />
    </div>
  )
}

function TemplateEditor({ title, kind, tpl, onSave, withImage }: {
  title: string; kind: TankEmailKind; tpl: TankEmailTemplate; onSave: Props['onSave']; withImage?: boolean
}) {
  const [subject, setSubject] = useState(tpl.subject)
  const [to, setTo] = useState(tpl.to)
  const [body, setBody] = useState(tpl.body)
  const [image, setImage] = useState<string | null>(tpl.magnetImage ?? null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Re-sync when the stored template changes (e.g. after another device saves).
  useEffect(() => { setSubject(tpl.subject); setTo(tpl.to); setBody(tpl.body); setImage(tpl.magnetImage ?? null) }, [tpl])

  const dirty = subject !== tpl.subject || to !== tpl.to || body !== tpl.body || (image ?? null) !== (tpl.magnetImage ?? null)

  function pickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return
    if (!f.type.startsWith('image/')) { toast.error('Pick an image file'); return }
    if (f.size > 1_500_000) { toast.error('Image too large (max ~1.5 MB)'); return }
    const reader = new FileReader()
    reader.onload = () => setImage(String(reader.result))
    reader.readAsDataURL(f)
  }

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-heading font-bold text-navy">{title}</span>
          <div className="flex items-center gap-2">
            {dirty && <span className="text-[10px] font-mono text-[#E67E22]">unsaved</span>}
            <Button size="sm" disabled={!dirty} onClick={() => { onSave(kind, { subject, to, body, magnetImage: image }); toast.success('Template saved') }}>Save</Button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input label="To" value={to} onChange={(e) => setTo(e.target.value)} />
          <Input label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </div>
        <div>
          <label className="text-xs font-heading text-inky uppercase tracking-wide block mb-1">Body</label>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={12}
            className="w-full bg-cream dark:bg-[#0e2638] border border-navy/40 rounded px-3 py-2 text-sm font-mono text-navy dark:text-[#F2F1E6] focus:outline-none focus:ring-2 focus:ring-sky resize-y" />
        </div>
        {withImage && (
          <div className="flex items-center gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Magnet Photo</span>
              <div className="flex items-center gap-2">
                <input ref={fileRef} type="file" accept="image/*" onChange={pickImage} className="hidden" />
                <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()}>{image ? 'Replace' : 'Upload'} photo</Button>
                {image && <button onClick={() => setImage(null)} className="text-[11px] font-mono text-inky hover:text-[#C0392B] hover:underline">Remove</button>}
                <span className="text-[10px] font-mono text-inky/50">Embedded where {'{{magnet_image}}'} appears.</span>
              </div>
            </div>
            {image && <img src={image} alt="Magnet" className="h-20 w-auto rounded border border-navy/20" />}
          </div>
        )}
      </CardBody>
    </Card>
  )
}
