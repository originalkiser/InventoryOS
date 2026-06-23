import { useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { supabase } from '@/lib/supabase'

interface Attachment {
  id: string
  file_name: string
  storage_path: string
  file_size: number | null
  content_type: string | null
  created_at: string
}

function formatSize(bytes: number | null): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)}KB`
  return `${(bytes / 1048576).toFixed(1)}MB`
}

interface Props {
  entityType: 'issue' | 'project'
  entityId: string
  companyId: string
}

export function AttachmentsCell({ entityType, entityId, companyId }: Props) {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<{ left: number; top: number } | null>(null)
  const [files, setFiles] = useState<Attachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    ;(supabase as any)
      .schema('platform').from('attachments')
      .select('*')
      .eq('entity_id', entityId)
      .order('created_at')
      .then(({ data }: any) => setFiles(data ?? []))
  }, [open, entityId])

  function toggle() {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect()
      setRect({ left: r.left, top: r.bottom + 4 })
    }
    setOpen((o) => !o)
  }

  async function handleUpload(file: File) {
    setUploading(true)
    try {
      const uid = crypto.randomUUID()
      const ext = file.name.includes('.') ? `.${file.name.split('.').pop()}` : ''
      const storagePath = `${companyId}/${entityType}/${entityId}/${uid}${ext}`

      const { error: storErr } = await supabase.storage.from('attachments').upload(storagePath, file)
      if (storErr) throw storErr

      const { error: dbErr } = await (supabase as any).schema('platform').from('attachments').insert({
        entity_type: entityType,
        entity_id: entityId,
        company_id: companyId,
        file_name: file.name,
        storage_path: storagePath,
        file_size: file.size,
        content_type: file.type || null,
      })
      if (dbErr) {
        await supabase.storage.from('attachments').remove([storagePath])
        throw dbErr
      }

      const { data } = await (supabase as any).schema('platform').from('attachments').select('*').eq('entity_id', entityId).order('created_at')
      setFiles(data ?? [])
      toast.success(`${file.name} uploaded`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function handleDownload(att: Attachment) {
    const { data, error } = await supabase.storage.from('attachments').createSignedUrl(att.storage_path, 120)
    if (error || !data) { toast.error('Could not generate download link'); return }
    const a = document.createElement('a')
    a.href = data.signedUrl
    a.download = att.file_name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  async function handleDelete(att: Attachment) {
    if (!confirm(`Remove "${att.file_name}"?`)) return
    setDeletingId(att.id)
    try {
      await supabase.storage.from('attachments').remove([att.storage_path])
      await (supabase as any).schema('platform').from('attachments').delete().eq('id', att.id)
      setFiles((prev) => prev.filter((f) => f.id !== att.id))
      toast.success('File removed')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggle}
        className="flex items-center gap-1 px-2 py-1 text-xs font-mono text-inky/60 hover:text-navy transition-colors"
        title="Attachments"
      >
        <span>Upload File</span>
        {files.length > 0 && <span className="text-[10px]">({files.length})</span>}
      </button>

      {open && rect && (
        <>
          <div className="fixed inset-0 z-[60]" onClick={() => setOpen(false)} />
          <div
            className="fixed z-[61] w-72 rounded border border-navy/30 bg-cream shadow-xl flex flex-col gap-0"
            style={{ left: Math.min(rect.left, window.innerWidth - 300), top: rect.top }}
          >
            <div className="flex items-center justify-between px-3 py-2 border-b border-inky/10">
              <span className="text-xs font-heading uppercase tracking-wider text-navy">Attachments</span>
              <div className="flex items-center gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f) }}
                />
                <button
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                  className="text-xs font-mono text-sky hover:underline disabled:opacity-40"
                >
                  {uploading ? 'Uploading…' : '+ Upload'}
                </button>
              </div>
            </div>

            {files.length === 0 && !uploading ? (
              <p className="px-3 py-4 text-xs font-mono text-inky/40 text-center">No files attached</p>
            ) : (
              <ul className="divide-y divide-inky/10 max-h-64 overflow-y-auto">
                {files.map((att) => (
                  <li key={att.id} className="flex items-center gap-2 px-3 py-2 group hover:bg-inky/5">
                    <span className="flex-1 min-w-0">
                      <span className="block text-xs font-mono text-navy truncate" title={att.file_name}>
                        {att.file_name}
                      </span>
                      {att.file_size && (
                        <span className="text-[10px] font-mono text-inky/40">{formatSize(att.file_size)}</span>
                      )}
                    </span>
                    <button
                      onClick={() => handleDownload(att)}
                      className="text-[10px] font-mono text-sky hover:underline flex-shrink-0"
                      title="Download"
                    >
                      ↓
                    </button>
                    <button
                      onClick={() => handleDelete(att)}
                      disabled={deletingId === att.id}
                      className="text-[10px] font-mono text-inky/30 hover:text-red-400 flex-shrink-0 disabled:opacity-40"
                      title="Remove"
                    >
                      ✕
                    </button>
                  </li>
                ))}
                {uploading && (
                  <li className="px-3 py-2 text-xs font-mono text-inky/40 animate-pulse">Uploading…</li>
                )}
              </ul>
            )}
          </div>
        </>
      )}
    </>
  )
}
