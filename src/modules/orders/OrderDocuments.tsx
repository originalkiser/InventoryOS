import { useEffect, useRef, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import type { OrderDocument } from '@/types'
import { format } from 'date-fns'
import toast from 'react-hot-toast'

interface Props {
  companyId: string
  sessionId: string | null
  stage: 'start' | 'export'
  uploadedBy: string | null
}

// Document uploads available at both start and export stages (order_documents +
// the 'order-documents' storage bucket). Path: <company_id>/<session|stage>/<file>.
export function OrderDocuments({ companyId, sessionId, stage, uploadedBy }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [docs, setDocs] = useState<OrderDocument[]>([])
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const sb = supabase as any
    let q = sb.from('order_documents').select('*').eq('company_id', companyId).eq('stage', stage)
    q = sessionId ? q.eq('order_session_id', sessionId) : q.is('order_session_id', null)
    const { data } = await q.order('created_at', { ascending: false })
    setDocs((data ?? []) as OrderDocument[])
  }, [companyId, sessionId, stage])

  useEffect(() => { load() }, [load])

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBusy(true)
    const folder = sessionId ?? stage
    const path = `${companyId}/${folder}/${Date.now()}_${file.name}`
    const sb = supabase as any
    const { error: upErr } = await sb.storage.from('order-documents').upload(path, file)
    if (upErr) { setBusy(false); toast.error(upErr.message); return }
    const { error: rowErr } = await sb.from('order_documents').insert({
      company_id: companyId,
      order_session_id: sessionId,
      stage,
      file_name: file.name,
      storage_path: path,
      uploaded_by: uploadedBy,
    })
    setBusy(false)
    if (rowErr) toast.error(rowErr.message)
    else { toast.success('Document attached'); load() }
  }

  async function remove(doc: OrderDocument) {
    const sb = supabase as any
    await sb.storage.from('order-documents').remove([doc.storage_path])
    await sb.from('order_documents').delete().eq('id', doc.id)
    toast.success('Document removed'); load()
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-gray-500 uppercase tracking-wide">
          {stage === 'start' ? 'Supporting Documents' : 'Export Documents'} ({docs.length})
        </span>
        <button
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="text-xs font-mono text-[#00e5ff] border border-[#00e5ff]/30 rounded px-2 py-1 hover:bg-[#00e5ff]/10 disabled:opacity-40"
        >
          {busy ? 'Uploading…' : '+ Attach file'}
        </button>
        <input ref={inputRef} type="file" className="hidden" onChange={onPick} />
      </div>
      {docs.length > 0 && (
        <div className="flex flex-col gap-1">
          {docs.map((d) => (
            <div key={d.id} className="flex items-center justify-between gap-2 px-2 py-1 border border-[#2a2d3e] rounded bg-[#0f1117]">
              <span className="text-xs font-mono text-gray-300 truncate">{d.file_name}</span>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="text-[10px] font-mono text-gray-600">{format(new Date(d.created_at), 'MMM d, h:mm a')}</span>
                <button onClick={() => remove(d)} className="text-xs font-mono text-red-400 hover:text-red-300">×</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
