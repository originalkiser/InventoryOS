// Edge function: forms-assignment-scheduler
// Intended to run daily via pg_cron or Supabase scheduled functions.
// For each active assignment_rule, checks whether an assignment should fire today
// and inserts into forms.assignments, logging to assignment_rule_log to prevent duplicates.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const sb = createClient(supabaseUrl, supabaseKey, {
  db: { schema: 'forms' },
})

Deno.serve(async (_req) => {
  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD

  // Load all active rules
  const { data: rules, error: rulesErr } = await sb.from('assignment_rules').select('*').eq('is_active', true)
  if (rulesErr) return new Response(JSON.stringify({ error: rulesErr.message }), { status: 500 })

  let fired = 0
  let skipped = 0

  for (const rule of rules ?? []) {
    if (!shouldFireToday(rule, today)) { skipped++; continue }

    // Check if already fired today
    const { data: log } = await sb.from('assignment_rule_log')
      .select('id').eq('rule_id', rule.id).eq('fired_date', today).maybeSingle()
    if (log) { skipped++; continue }

    // Resolve assignees
    const assigneeIds: string[] = await resolveAssignees(rule)
    if (!assigneeIds.length) { skipped++; continue }

    // Compute due date
    const dueDate = rule.due_offset_days > 0
      ? addDays(today, rule.due_offset_days)
      : null

    // Insert assignments
    const inserts = assigneeIds.map((userId) => ({
      form_id: rule.form_id,
      assigned_to: userId,
      due_date: dueDate,
      assigned_by: rule.created_by,
    }))
    await sb.from('assignment_rules').select().limit(0) // no-op to ensure schema context
    const sbPublic = createClient(supabaseUrl, supabaseKey)
    const { error: insertErr } = await (sbPublic as any).schema('forms').from('assignments').insert(inserts)
    if (insertErr) { console.error('Insert error for rule', rule.id, insertErr.message); continue }

    // Log the fire
    await (sbPublic as any).schema('forms').from('assignment_rule_log').insert({
      rule_id: rule.id,
      fired_date: today,
      assignee_count: assigneeIds.length,
    })

    fired++
  }

  return new Response(JSON.stringify({ today, fired, skipped }), {
    headers: { 'Content-Type': 'application/json' },
  })
})

function shouldFireToday(rule: any, today: string): boolean {
  if (rule.rule_type === 'set_dates') {
    return (rule.set_dates ?? []).includes(today)
  }
  if (rule.rule_type === 'interval') {
    if (!rule.interval_start_date) return false
    const start = new Date(rule.interval_start_date)
    const current = new Date(today)
    const diffDays = Math.floor((current.getTime() - start.getTime()) / 86400000)
    if (diffDays < 0) return false
    const intervalDays = toIntervalDays(rule.interval_unit, rule.interval_value ?? 1)
    return diffDays % intervalDays === 0
  }
  return false
}

function toIntervalDays(unit: string, value: number): number {
  switch (unit) {
    case 'day': return value
    case 'week': return value * 7
    case 'month': return value * 30
    case 'quarter': return value * 91
    case 'year': return value * 365
    default: return value
  }
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr)
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

async function resolveAssignees(rule: any): Promise<string[]> {
  const sbPublic = createClient(supabaseUrl, supabaseKey)
  if (rule.assign_to_type === 'users') {
    return rule.assign_to_users ?? []
  }
  if (rule.assign_to_type === 'department') {
    // Fetch users in department — app uses company_id scope, not department column.
    // Stub: return empty until department field is added to user_profiles.
    return []
  }
  if (rule.assign_to_type === 'locations') {
    // Return location IDs as assignee placeholders; caller maps to assigned_to_location.
    return rule.assign_to_locations ?? []
  }
  return []
}
