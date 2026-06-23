import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { Button, Input } from '@/components/ui'
import toast from 'react-hot-toast'

const DEPARTMENTS = ['Inventory', 'Operations', 'Finance', 'Accounting', 'All Departments']
const PRIORITIES = ['low', 'medium', 'high', 'critical'] as const
type Priority = typeof PRIORITIES[number]

const PRIORITY_LABELS: Record<Priority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
}

export function FeatureRequestForm() {
  const navigate = useNavigate()
  const { profile } = useAuthStore()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [departments, setDepartments] = useState<string[]>([])
  const [priority, setPriority] = useState<Priority>('medium')
  const [files, setFiles] = useState<File[]>([])
  const [saving, setSaving] = useState(false)

  function toggleDept(d: string) {
    setDepartments((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]
    )
  }

  function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files) return
    const picked = Array.from(e.target.files)
    const oversized = picked.filter((f) => f.size > 25 * 1024 * 1024)
    if (oversized.length > 0) {
      toast.error(`${oversized.length} file(s) exceed 25 MB limit`)
      return
    }
    setFiles((prev) => [...prev, ...picked])
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim() || !description.trim() || departments.length === 0) return
    if (!profile) return
    setSaving(true)
    try {
      const sb = supabase as any
      const { data, error } = await sb.schema('platform').from('feature_requests').insert({
        submitted_by: profile.id,
        title: title.trim(),
        description: description.trim(),
        departments,
        priority,
        status: 'submitted',
      }).select().single()
      if (error) throw error

      // Upload files
      for (const file of files) {
        const path = `${data.id}/${Date.now()}-${file.name}`
        const { error: uploadErr } = await supabase.storage
          .from('feature-request-files')
          .upload(path, file)
        if (uploadErr) {
          toast.error(`Failed to upload ${file.name}`)
          continue
        }
        await sb.schema('platform').from('feature_request_files').insert({
          request_id: data.id,
          uploaded_by: profile.id,
          file_name: file.name,
          storage_path: path,
          file_size_bytes: file.size,
        })
      }

      toast.success('Request submitted. You can track its status and add files from your requests list.')
      navigate('/feature-requests')
    } catch (err: any) {
      toast.error(err.message ?? 'Failed to submit request')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-2xl mx-auto py-8 px-6 flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-heading font-bold text-navy uppercase tracking-wide">New Feature Request</h1>
        <p className="text-xs text-inky mt-0.5">Describe the feature, the problem it solves, and any current workaround.</p>
      </div>

      <form onSubmit={onSubmit} className="flex flex-col gap-5">
        <Input
          label="Title *"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Brief summary of the feature"
          required
        />

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-mono text-inky uppercase tracking-wide">Department(s) *</label>
          <div className="flex flex-wrap gap-2">
            {DEPARTMENTS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => toggleDept(d)}
                className={[
                  'px-3 py-1.5 rounded border text-xs font-mono transition-colors',
                  departments.includes(d)
                    ? 'border-sky/60 bg-sky/10 text-navy'
                    : 'border-navy/20 bg-cream text-inky hover:border-navy/40',
                ].join(' ')}
              >
                {d}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-mono text-inky uppercase tracking-wide">Description *</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={6}
            required
            placeholder="Explain the feature, the problem it solves, and any current workaround…"
            className="rounded border border-navy/30 bg-cream px-3 py-2 text-sm font-body text-navy placeholder-inky/40 focus:border-sky focus:ring-1 focus:ring-sky focus:outline-none resize-y"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-mono text-inky uppercase tracking-wide">Priority</label>
          <div className="flex gap-2">
            {PRIORITIES.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPriority(p)}
                className={[
                  'px-3 py-1.5 rounded border text-xs font-mono transition-colors capitalize',
                  priority === p
                    ? 'border-sky/60 bg-sky/10 text-navy'
                    : 'border-navy/20 bg-cream text-inky hover:border-navy/40',
                ].join(' ')}
              >
                {PRIORITY_LABELS[p]}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-mono text-inky uppercase tracking-wide">Attachments</label>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFiles}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="self-start px-3 py-1.5 rounded border border-navy/20 bg-cream text-xs font-mono text-inky hover:border-navy/40 transition-colors"
          >
            + Add files
          </button>
          {files.length > 0 && (
            <ul className="flex flex-col gap-1 mt-1">
              {files.map((f, i) => (
                <li key={i} className="flex items-center gap-2 text-xs font-mono text-inky">
                  <span className="truncate max-w-xs">{f.name}</span>
                  <span className="text-inky/40">({(f.size / 1024).toFixed(0)} KB)</span>
                  <button
                    type="button"
                    onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                    className="text-inky/30 hover:text-[#C0392B] transition-colors"
                  >✕</button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between pt-2 border-t border-navy/10">
          <button
            type="button"
            onClick={() => navigate('/feature-requests')}
            className="text-xs font-mono text-inky hover:text-navy transition-colors"
          >
            Cancel
          </button>
          <Button
            type="submit"
            disabled={saving || !title.trim() || !description.trim() || departments.length === 0}
          >
            {saving ? 'Submitting…' : 'Submit Request'}
          </Button>
        </div>
      </form>
    </div>
  )
}
