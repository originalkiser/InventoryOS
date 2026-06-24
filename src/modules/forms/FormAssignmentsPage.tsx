import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { loadFormWithFields } from '@/hooks/useForms'
import { useAuthStore } from '@/stores/authStore'
import { Button, Badge } from '@/components/ui'
import type { FormDefinition, FormAssignment } from '@/types/forms'
import type { Profile } from '@/types'
import { format, isPast, parseISO } from 'date-fns'
import toast from 'react-hot-toast'

const sb = supabase as any

interface AssignmentRow extends FormAssignment {
  profile?: Profile
  location?: { name: string }
}

export function FormAssignmentsPage() {
  const { formId } = useParams<{ formId: string }>()
  const navigate = useNavigate()
  const { profile: myProfile } = useAuthStore()
  const [form, setForm] = useState<FormDefinition | null>(null)
  const [assignments, setAssignments] = useState<AssignmentRow[]>([])
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([])
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [loading, setLoading] = useState(true)

  // Drawer state
  const [assignTo, setAssignTo] = useState<'user' | 'location'>('user')
  const [selectedUser, setSelectedUser] = useState('')
  const [selectedLocation, setSelectedLocation] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!formId || !myProfile?.company_id) return
    ;(async () => {
      const res = await loadFormWithFields(formId)
      if (res) setForm(res.form)

      const [asgRes, profRes, locRes] = await Promise.all([
        sb.schema('forms').from('assignments').select('*').eq('form_id', formId).order('created_at', { ascending: false }),
        sb.schema('platform').from('user_profiles').select('id, full_name, email').eq('company_id', myProfile.company_id).order('full_name'),
        sb.schema('core').from('locations').select('id, name').eq('company_id', myProfile.company_id).eq('active', true).order('name'),
      ])

      const profs: Profile[] = profRes.data ?? []
      const locs: { id: string; name: string }[] = locRes.data ?? []
      setProfiles(profs)
      setLocations(locs)

      const rows: AssignmentRow[] = (asgRes.data ?? []).map((a: any) => ({
        ...a,
        profile: profs.find((p) => p.id === a.assigned_to),
        location: locs.find((l) => l.id === a.assigned_to_location),
      }))
      setAssignments(rows)
      setLoading(false)
    })()
  }, [formId, myProfile?.company_id])

  async function saveAssignment() {
    if (!formId || !myProfile?.id) return
    if (assignTo === 'user' && !selectedUser) { toast.error('Select a user'); return }
    if (assignTo === 'location' && !selectedLocation) { toast.error('Select a location'); return }
    setSaving(true)
    const { data, error } = await sb.schema('forms').from('assignments').insert({
      form_id: formId,
      assigned_to: assignTo === 'user' ? selectedUser : null,
      assigned_to_location: assignTo === 'location' ? selectedLocation : null,
      due_date: dueDate || null,
      assigned_by: myProfile.id,
    }).select().single()
    setSaving(false)
    if (error) { toast.error(error.message); return }
    const profile = profiles.find((p) => p.id === data.assigned_to)
    const location = locations.find((l) => l.id === data.assigned_to_location)
    setAssignments((p) => [{ ...data, profile, location }, ...p])
    setDrawerOpen(false)
    setSelectedUser(''); setSelectedLocation(''); setDueDate('')
    toast.success('Assignment created')
  }

  async function deleteAssignment(id: string) {
    await sb.schema('forms').from('assignments').delete().eq('id', id)
    setAssignments((p) => p.filter((a) => a.id !== id))
    toast.success('Assignment removed')
  }

  function assignmentStatus(a: AssignmentRow): { label: string; color: 'green' | 'red' | 'amber' | 'gray' } {
    if (a.is_completed) return { label: 'Completed', color: 'green' }
    if (a.due_date && isPast(parseISO(a.due_date + 'T23:59:59'))) return { label: 'Overdue', color: 'red' }
    if (a.due_date) return { label: 'Pending', color: 'amber' }
    return { label: 'Pending', color: 'gray' }
  }

  if (loading) return <div className="py-8 text-xs font-mono text-inky">Loading…</div>
  if (!form) return <div className="py-8 text-xs font-mono text-inky">Form not found.</div>

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/forms')} className="text-xs font-mono text-inky hover:text-navy">← Forms</button>
        <h1 className="flex-1 text-sm font-heading font-bold text-navy">{form.title} — Assignments</h1>
        <Button size="sm" onClick={() => setDrawerOpen(true)}>+ Assign Form</Button>
      </div>

      {assignments.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded border border-dashed border-navy/30 py-12">
          <p className="text-sm font-mono text-inky">No assignments yet</p>
          <Button size="sm" onClick={() => setDrawerOpen(true)}>+ Assign Form</Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {assignments.map((a) => {
            const { label, color } = assignmentStatus(a)
            return (
              <div key={a.id} className="flex items-center gap-3 rounded border border-navy/20 bg-cream px-4 py-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-heading text-navy">
                    {a.profile?.full_name ?? a.location?.name ?? 'Unknown'}
                  </div>
                  <div className="text-[10px] font-mono text-inky/50">
                    {a.due_date ? `Due: ${format(parseISO(a.due_date), 'MMM d, yyyy')}` : 'No due date'}
                    {a.completed_at && ` · Completed ${format(new Date(a.completed_at), 'MMM d, yyyy')}`}
                  </div>
                </div>
                <Badge color={color}>{label}</Badge>
                <button onClick={() => deleteAssignment(a.id)} className="text-xs font-mono text-inky/40 hover:text-red-500">✕</button>
              </div>
            )
          })}
        </div>
      )}

      {/* Assign drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-navy/60 backdrop-blur-sm">
          <div className="w-full max-w-md bg-cream rounded-t-2xl sm:rounded-lg border border-navy/30 shadow-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-heading font-bold text-navy uppercase tracking-wide">Assign Form</h3>
              <button onClick={() => setDrawerOpen(false)} className="text-inky/50 hover:text-navy">✕</button>
            </div>

            <div className="flex gap-2">
              {(['user', 'location'] as const).map((t) => (
                <button key={t} onClick={() => setAssignTo(t)}
                  className={['flex-1 py-1.5 rounded border text-xs font-mono capitalize', assignTo === t ? 'bg-navy text-cream border-navy' : 'border-navy/20 text-inky hover:border-navy/40'].join(' ')}>
                  {t === 'user' ? 'User' : 'Location'}
                </button>
              ))}
            </div>

            {assignTo === 'user' ? (
              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-mono text-inky uppercase tracking-wide">Assign To</label>
                <select value={selectedUser} onChange={(e) => setSelectedUser(e.target.value)}
                  className="rounded border border-navy/30 bg-cream px-2 py-1.5 text-xs font-mono text-navy focus:border-[#00e5ff] focus:outline-none">
                  <option value="">Select user…</option>
                  {profiles.map((p) => <option key={p.id} value={p.id}>{p.full_name ?? p.email}</option>)}
                </select>
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-mono text-inky uppercase tracking-wide">Location</label>
                <select value={selectedLocation} onChange={(e) => setSelectedLocation(e.target.value)}
                  className="rounded border border-navy/30 bg-cream px-2 py-1.5 text-xs font-mono text-navy focus:border-[#00e5ff] focus:outline-none">
                  <option value="">Select location…</option>
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>
            )}

            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-mono text-inky uppercase tracking-wide">Due Date (optional)</label>
              <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)}
                className="rounded border border-navy/30 bg-cream px-2 py-1.5 text-xs font-mono text-navy focus:border-[#00e5ff] focus:outline-none" />
            </div>

            <div className="flex justify-end gap-2 pt-1 border-t border-navy/10">
              <button onClick={() => setDrawerOpen(false)} className="text-xs font-mono border border-navy/20 rounded px-3 py-1.5 text-inky hover:border-navy/40">Cancel</button>
              <button onClick={saveAssignment} disabled={saving} className="text-xs font-mono bg-navy text-cream rounded px-3 py-1.5 hover:bg-inky disabled:opacity-40">
                {saving ? 'Saving…' : 'Assign'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
