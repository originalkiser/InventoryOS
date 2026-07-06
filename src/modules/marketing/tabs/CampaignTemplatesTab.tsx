import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { Button, Badge } from '@/components/ui'
import toast from 'react-hot-toast'
import type { MarketingCampaignTemplate, MarketingCampaignTemplateTask } from '@/types/marketing'
import { DEFAULT_TEMPLATES } from '@/types/marketing'

export function CampaignTemplatesTab() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id
  const userId = profile?.id
  const sb = supabase as any

  const [templates, setTemplates] = useState<MarketingCampaignTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [seeding, setSeeding] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [editingTask, setEditingTask] = useState<{ templateId: string; task: Partial<MarketingCampaignTemplateTask> } | null>(null)
  const [addingTemplate, setAddingTemplate] = useState(false)
  const [newTemplate, setNewTemplate] = useState({ name: '', category: '', description: '' })

  useEffect(() => {
    if (!companyId) return
    load()
  }, [companyId]) // eslint-disable-line

  async function load() {
    setLoading(true)
    const { data, error } = await sb.schema('marketing').from('campaign_templates')
      .select('*, campaign_template_tasks(*)')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .order('sort_order')
    if (error) toast.error('Failed to load templates')
    else setTemplates(data ?? [])
    setLoading(false)
  }

  async function seedDefaults() {
    if (templates.length > 0) return
    setSeeding(true)
    let successCount = 0
    try {
      for (let i = 0; i < DEFAULT_TEMPLATES.length; i++) {
        const tpl = DEFAULT_TEMPLATES[i]
        const { data: created, error } = await sb.schema('marketing').from('campaign_templates')
          .insert({ company_id: companyId, name: tpl.name, category: tpl.category, description: tpl.description, sort_order: i, created_by: userId })
          .select('id')
          .single()
        if (error || !created) continue
        const taskInserts = tpl.tasks.map((t, j) => ({
          campaign_template_id: created.id,
          name: t.name,
          description: t.description,
          sort_order: j,
          created_by: userId,
        }))
        await sb.schema('marketing').from('campaign_template_tasks').insert(taskInserts)
        successCount++
      }
      if (successCount > 0) {
        toast.success(`${successCount} template${successCount > 1 ? 's' : ''} seeded`)
        load()
      } else {
        toast.error('Seeding failed — add "marketing" to Supabase API exposed schemas, then retry')
      }
    } finally {
      setSeeding(false)
    }
  }

  async function toggleTemplate(id: string, is_active: boolean) {
    const { error } = await sb.schema('marketing').from('campaign_templates')
      .update({ is_active, updated_at: new Date().toISOString(), updated_by: userId })
      .eq('id', id)
    if (error) toast.error('Failed to update template')
    else setTemplates(ts => ts.map(t => t.id === id ? { ...t, is_active } : t))
  }

  async function saveNewTemplate() {
    if (!newTemplate.name.trim()) return
    const { data, error } = await sb.schema('marketing').from('campaign_templates')
      .insert({ company_id: companyId, name: newTemplate.name.trim(), category: newTemplate.category.trim() || 'Other', description: newTemplate.description.trim() || null, sort_order: templates.length, created_by: userId })
      .select('*, campaign_template_tasks(*)')
      .single()
    if (error) { toast.error('Failed to create template'); return }
    setTemplates(ts => [...ts, data])
    setNewTemplate({ name: '', category: '', description: '' })
    setAddingTemplate(false)
    toast.success('Template created')
  }

  async function saveTask() {
    if (!editingTask) return
    const { templateId, task } = editingTask
    if (!task.name?.trim()) return
    if (task.id) {
      const { error } = await sb.schema('marketing').from('campaign_template_tasks')
        .update({ name: task.name.trim(), description: task.description?.trim() || null, is_required: task.is_required ?? true, updated_at: new Date().toISOString(), updated_by: userId })
        .eq('id', task.id)
      if (error) { toast.error('Failed to save task'); return }
      setTemplates(ts => ts.map(t => t.id === templateId ? {
        ...t,
        campaign_template_tasks: (t.campaign_template_tasks ?? []).map(tk => tk.id === task.id ? { ...tk, ...task } as MarketingCampaignTemplateTask : tk)
      } : t))
    } else {
      const existing = templates.find(t => t.id === templateId)?.campaign_template_tasks ?? []
      const { data, error } = await sb.schema('marketing').from('campaign_template_tasks')
        .insert({ campaign_template_id: templateId, name: task.name.trim(), description: task.description?.trim() || null, is_required: task.is_required ?? true, sort_order: existing.length, created_by: userId })
        .select('*')
        .single()
      if (error) { toast.error('Failed to add task'); return }
      setTemplates(ts => ts.map(t => t.id === templateId ? { ...t, campaign_template_tasks: [...(t.campaign_template_tasks ?? []), data] } : t))
    }
    setEditingTask(null)
    toast.success('Task saved')
  }

  async function deleteTask(templateId: string, taskId: string) {
    const { error } = await sb.schema('marketing').from('campaign_template_tasks')
      .update({ is_active: false, updated_at: new Date().toISOString(), updated_by: userId })
      .eq('id', taskId)
    if (error) { toast.error('Failed to remove task'); return }
    setTemplates(ts => ts.map(t => t.id === templateId ? {
      ...t,
      campaign_template_tasks: (t.campaign_template_tasks ?? []).filter(tk => tk.id !== taskId)
    } : t))
  }

  if (loading) return <div className="py-8 text-center text-inky/60 font-mono text-xs">Loading templates…</div>

  return (
    <div className="flex flex-col gap-4 mt-4">
      {templates.length === 0 && (
        <div className="border border-dashed border-sky/40 rounded-lg p-8 text-center">
          <p className="text-inky/60 font-mono text-xs mb-3">No campaign templates yet.</p>
          <Button variant="primary" size="sm" onClick={seedDefaults} disabled={seeding}>
            {seeding ? 'Seeding…' : 'Seed Default Templates'}
          </Button>
        </div>
      )}

      {templates.map(tpl => (
        <div key={tpl.id} className="border border-sky/30 rounded-lg overflow-hidden">
          <button
            className="w-full flex items-center justify-between px-4 py-3 bg-cream/50 hover:bg-sky/10 text-left"
            onClick={() => setExpanded(e => e === tpl.id ? null : tpl.id)}
          >
            <div className="flex items-center gap-3">
              <span className="font-heading font-bold text-navy text-sm">{tpl.name}</span>
              <Badge color="inky">{tpl.category}</Badge>
              <Badge color={tpl.is_active ? 'green' : 'inky'}>{tpl.is_active ? 'Active' : 'Inactive'}</Badge>
            </div>
            <span className="text-inky/60 text-xs">{tpl.campaign_template_tasks?.length ?? 0} tasks · {expanded === tpl.id ? '▲' : '▼'}</span>
          </button>

          {expanded === tpl.id && (
            <div className="px-4 py-3 flex flex-col gap-3">
              {tpl.description && <p className="text-xs font-mono text-inky/60">{tpl.description}</p>}

              <table className="w-full text-xs font-mono border-collapse">
                <thead>
                  <tr className="border-b border-sky/20">
                    <th className="text-left py-1 pr-3 text-inky/60 font-normal">Task</th>
                    <th className="text-left py-1 pr-3 text-inky/60 font-normal w-20">Required</th>
                    <th className="w-16" />
                  </tr>
                </thead>
                <tbody>
                  {(tpl.campaign_template_tasks ?? []).map(tk => (
                    <tr key={tk.id} className="border-b border-sky/20">
                      <td className="py-1.5 pr-3 text-navy">{tk.name}</td>
                      <td className="py-1.5 pr-3 text-inky/60">{tk.is_required ? 'Yes' : 'No'}</td>
                      <td className="py-1.5">
                        <div className="flex gap-2">
                          <button className="text-inky/60 hover:text-navy" onClick={() => setEditingTask({ templateId: tpl.id, task: { ...tk } })}>Edit</button>
                          <button className="text-inky/60 hover:text-sb-red" onClick={() => deleteTask(tpl.id, tk.id)}>✕</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="flex gap-2 mt-1">
                <Button size="sm" variant="secondary" onClick={() => setEditingTask({ templateId: tpl.id, task: { is_required: true } })}>+ Add Task</Button>
                <Button size="sm" variant="ghost" onClick={() => toggleTemplate(tpl.id, !tpl.is_active)}>
                  {tpl.is_active ? 'Deactivate' : 'Activate'}
                </Button>
              </div>
            </div>
          )}
        </div>
      ))}

      {templates.length > 0 && (
        <div>
          {addingTemplate ? (
            <div className="border border-sky/30 rounded-lg p-4 flex flex-col gap-3">
              <p className="font-heading font-bold text-navy text-sm">New Template</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-mono text-inky/60 block mb-1">Name *</label>
                  <input className="w-full border border-sky/30 rounded px-2 py-1.5 text-xs font-mono bg-cream focus:outline-none focus:ring-1 focus:ring-sky"
                    value={newTemplate.name} onChange={e => setNewTemplate(p => ({ ...p, name: e.target.value }))} placeholder="Template name" />
                </div>
                <div>
                  <label className="text-xs font-mono text-inky/60 block mb-1">Category</label>
                  <input className="w-full border border-sky/30 rounded px-2 py-1.5 text-xs font-mono bg-cream focus:outline-none focus:ring-1 focus:ring-sky"
                    value={newTemplate.category} onChange={e => setNewTemplate(p => ({ ...p, category: e.target.value }))} placeholder="Direct Mail, Digital…" />
                </div>
              </div>
              <div>
                <label className="text-xs font-mono text-inky/60 block mb-1">Description</label>
                <input className="w-full border border-sky/30 rounded px-2 py-1.5 text-xs font-mono bg-cream focus:outline-none focus:ring-1 focus:ring-sky"
                  value={newTemplate.description} onChange={e => setNewTemplate(p => ({ ...p, description: e.target.value }))} placeholder="Optional" />
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="primary" onClick={saveNewTemplate}>Create</Button>
                <Button size="sm" variant="ghost" onClick={() => setAddingTemplate(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => setAddingTemplate(true)}>+ New Template</Button>
          )}
        </div>
      )}

      {/* Task edit modal */}
      {editingTask && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-cream dark:bg-[#0e2638] rounded-lg shadow-xl w-full max-w-md p-6 flex flex-col gap-4">
            <p className="font-heading font-bold text-navy">{editingTask.task.id ? 'Edit Task' : 'Add Task'}</p>
            <div>
              <label className="text-xs font-mono text-inky/60 block mb-1">Task Name *</label>
              <input className="w-full border border-sky/30 rounded px-3 py-2 text-sm font-mono bg-white dark:bg-[#122b40] text-navy focus:outline-none focus:ring-1 focus:ring-sky"
                value={editingTask.task.name ?? ''} onChange={e => setEditingTask(et => et ? { ...et, task: { ...et.task, name: e.target.value } } : null)} />
            </div>
            <div>
              <label className="text-xs font-mono text-inky/60 block mb-1">Description</label>
              <input className="w-full border border-sky/30 rounded px-3 py-2 text-sm font-mono bg-white dark:bg-[#122b40] text-navy focus:outline-none focus:ring-1 focus:ring-sky"
                value={editingTask.task.description ?? ''} onChange={e => setEditingTask(et => et ? { ...et, task: { ...et.task, description: e.target.value } } : null)} />
            </div>
            <label className="flex items-center gap-2 text-sm font-mono cursor-pointer text-navy">
              <input type="checkbox" checked={editingTask.task.is_required ?? true}
                onChange={e => setEditingTask(et => et ? { ...et, task: { ...et.task, is_required: e.target.checked } } : null)} />
              Required task
            </label>
            <div className="flex gap-2 justify-end">
              <Button size="sm" variant="ghost" onClick={() => setEditingTask(null)}>Cancel</Button>
              <Button size="sm" variant="primary" onClick={saveTask}>Save</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
