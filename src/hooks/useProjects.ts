import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import type { Project, ProjectTask } from '@/types'
import toast from 'react-hot-toast'

const sb = supabase as any

// Data layer for the Projects module: projects + their sub-tasks, with
// optimistic local updates that roll back on a Supabase error, plus realtime.
export function useProjects() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [projects, setProjects] = useState<Project[]>([])
  const [tasks, setTasks] = useState<ProjectTask[]>([])
  const [loading, setLoading] = useState(true)
  const loadedOnce = useRef(false)

  const load = useCallback(async () => {
    if (!companyId) return
    if (!loadedOnce.current) setLoading(true)
    // Lazy purge projects deleted > 30 days ago
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    void sb.schema('inventory').from('projects').delete().eq('company_id', companyId).lt('deleted_at', cutoff).not('deleted_at', 'is', null)
    const [p, t] = await Promise.all([
      sb.schema('inventory').from('projects').select('*').eq('company_id', companyId).is('deleted_at', null).order('sort_order').order('created_at'),
      sb.schema('inventory').from('project_tasks').select('*').eq('company_id', companyId).order('sort_order').order('created_at'),
    ])
    if (p.error) toast.error('Failed to load projects')
    else setProjects((p.data ?? []) as Project[])
    setTasks((t.data ?? []) as ProjectTask[])
    setLoading(false)
    loadedOnce.current = true
  }, [companyId])

  useEffect(() => { load() }, [load])

  // Realtime: any change to either table reloads (cheap; tables are small).
  useEffect(() => {
    if (!companyId) return
    const ch = supabase
      .channel('projects-rt')
      .on('postgres_changes', { event: '*', schema: 'inventory', table: 'projects', filter: `company_id=eq.${companyId}` }, () => load())
      .on('postgres_changes', { event: '*', schema: 'inventory', table: 'project_tasks', filter: `company_id=eq.${companyId}` }, () => load())
      .subscribe()
    return () => { void supabase.removeChannel(ch) }
  }, [companyId, load])

  // --- Projects --------------------------------------------------------------
  async function addProject(): Promise<Project | null> {
    if (!companyId) { toast.error('No workspace loaded'); return null }
    const maxOrder = projects.reduce((m, p) => Math.max(m, p.sort_order ?? 0), 0)
    const { data, error } = await sb.schema('inventory').from('projects')
      .insert({ company_id: companyId, project_name: '', status: 'Not Started', sort_order: maxOrder + 1, updated_by: profile?.id ?? null })
      .select().single()
    if (error || !data) { toast.error(error?.message ?? 'Could not add project'); return null }
    setProjects((prev) => [...prev, data as Project])
    return data as Project
  }

  async function updateProject(id: string, patch: Partial<Project>) {
    const snapshot = projects
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch, last_update: new Date().toISOString() } : p)))
    const { error } = await sb.schema('inventory').from('projects')
      .update({ ...patch, last_update: new Date().toISOString(), updated_by: profile?.id ?? null }).eq('id', id)
    if (error) { setProjects(snapshot); toast.error(error.message) }
  }

  async function deleteProject(id: string) {
    const snapshot = projects
    setProjects((prev) => prev.filter((p) => p.id !== id))
    const { error } = await sb.schema('inventory').from('projects').update({ deleted_at: new Date().toISOString() }).eq('id', id)
    if (error) { setProjects(snapshot); toast.error(error.message) }
    else toast.success('Project moved to deleted items')
  }

  async function restoreProject(id: string) {
    const { error } = await sb.schema('inventory').from('projects').update({ deleted_at: null }).eq('id', id)
    if (error) { toast.error(error.message); return }
    toast.success('Project restored')
    load()
  }

  async function hardDeleteProject(id: string) {
    const { error } = await sb.schema('inventory').from('projects').delete().eq('id', id)
    if (error) { toast.error(error.message); return }
    toast.success('Project permanently deleted')
    load()
  }

  // Persist a reordered list of projects (sort_order = index).
  async function reorderProjects(ordered: Project[]) {
    setProjects(ordered)
    const updates = ordered.map((p, i) => sb.schema('inventory').from('projects').update({ sort_order: i }).eq('id', p.id))
    const results = await Promise.all(updates)
    if (results.some((r: any) => r.error)) toast.error('Failed to save order')
  }

  // Bump the parent project's last_update when any of its sub-tasks change
  // (no per-task "last updated" column — the project row reflects it).
  async function touchProject(projectId: string | null | undefined) {
    if (!projectId) return
    const now = new Date().toISOString()
    setProjects((prev) => prev.map((p) => (p.id === projectId ? { ...p, last_update: now } : p)))
    await sb.schema('inventory').from('projects').update({ last_update: now, updated_by: profile?.id ?? null }).eq('id', projectId)
  }

  // --- Tasks -----------------------------------------------------------------
  async function addTask(projectId: string): Promise<ProjectTask | null> {
    if (!companyId) return null
    const siblings = tasks.filter((t) => t.project_id === projectId)
    const maxOrder = siblings.reduce((m, t) => Math.max(m, t.sort_order ?? 0), 0)
    const { data, error } = await sb.schema('inventory').from('project_tasks')
      .insert({ company_id: companyId, project_id: projectId, task_name: '', status: 'Not Started', sort_order: maxOrder + 1 })
      .select().single()
    if (error || !data) { toast.error(error?.message ?? 'Could not add task'); return null }
    setTasks((prev) => [...prev, data as ProjectTask])
    void touchProject(projectId)
    return data as ProjectTask
  }

  async function updateTask(id: string, patch: Partial<ProjectTask>) {
    const snapshot = tasks
    const projectId = tasks.find((t) => t.id === id)?.project_id
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)))
    const { error } = await sb.schema('inventory').from('project_tasks').update(patch).eq('id', id)
    if (error) { setTasks(snapshot); toast.error(error.message) }
    else void touchProject(projectId)
  }

  async function deleteTask(id: string) {
    const snapshot = tasks
    const projectId = tasks.find((t) => t.id === id)?.project_id
    setTasks((prev) => prev.filter((t) => t.id !== id))
    const { error } = await sb.schema('inventory').from('project_tasks').delete().eq('id', id)
    if (error) { setTasks(snapshot); toast.error(error.message) }
    else void touchProject(projectId)
  }

  async function reorderTasks(projectId: string, ordered: ProjectTask[]) {
    setTasks((prev) => [...prev.filter((t) => t.project_id !== projectId), ...ordered])
    const updates = ordered.map((t, i) => sb.schema('inventory').from('project_tasks').update({ sort_order: i }).eq('id', t.id))
    const results = await Promise.all(updates)
    if (results.some((r: any) => r.error)) toast.error('Failed to save task order')
    else void touchProject(projectId)
  }

  return {
    projects, tasks, loading, companyId, load,
    addProject, updateProject, deleteProject, restoreProject, hardDeleteProject, reorderProjects,
    addTask, updateTask, deleteTask, reorderTasks,
  }
}
