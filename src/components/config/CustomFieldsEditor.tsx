import { useState } from 'react'
import { useCustomFields, type NewField } from '@/hooks/useCustomFields'
import { Button, Input, Select, Badge } from '@/components/ui'
import type { CustomFieldSection } from '@/types'

const TYPE_OPTIONS = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
]

interface Props {
  section: CustomFieldSection
  // Optional one-click recommended columns for this section
  recommended?: NewField[]
  // Optional cross-section linking (e.g. order_config can pull from locations)
  linkSections?: { value: CustomFieldSection; label: string }[]
}

// Reusable editor for a config section's custom columns. Values are stored in
// each row's metadata jsonb; same field_key across sections links them.
export function CustomFieldsEditor({ section, recommended, linkSections }: Props) {
  const { fields, loading, addField, updateField, removeField, move, seedDefaults } = useCustomFields(section)

  const [label, setLabel] = useState('')
  const [type, setType] = useState<'text' | 'number' | 'date'>('text')
  const [linkSection, setLinkSection] = useState('')

  function add() {
    if (!label.trim()) return
    addField({
      label,
      field_type: type,
      linked_section: linkSection || null,
      linked_match_key: linkSection ? 'location_code' : null, // default match key; refine per need
    })
    setLabel(''); setType('text'); setLinkSection('')
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end gap-2 flex-wrap">
        <div className="flex-1 min-w-[10rem]">
          <Input label="New Column" value={label} onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') add() }} placeholder="e.g. Area Manager" />
        </div>
        <div className="w-32">
          <Select label="Type" options={TYPE_OPTIONS} value={type} onChange={(e) => setType(e.target.value as 'text' | 'number' | 'date')} />
        </div>
        {linkSections && linkSections.length > 0 && (
          <div className="w-40">
            <Select label="Link From" value={linkSection} onChange={(e) => setLinkSection(e.target.value)}
              options={[{ value: '', label: 'Independent' }, ...linkSections]} />
          </div>
        )}
        <Button size="sm" onClick={add} disabled={!label.trim()}>+ Add</Button>
      </div>

      {recommended && recommended.length > 0 && (
        <button onClick={() => seedDefaults(recommended)}
          className="self-start text-xs font-mono text-[#00e5ff] border border-[#00e5ff]/30 rounded px-2 py-1 hover:bg-[#00e5ff]/10">
          + Add recommended columns
        </button>
      )}

      {loading ? (
        <p className="text-xs font-mono text-gray-500">Loading…</p>
      ) : fields.length === 0 ? (
        <p className="text-xs font-mono text-gray-600">No custom columns yet.</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {fields.map((f, i) => (
            <div key={f.id} className="flex items-center gap-2 px-3 py-2 border border-[#2a2d3e] rounded bg-[#0f1117]">
              <div className="flex flex-col">
                <button onClick={() => move(f.id, -1)} disabled={i === 0} className="text-gray-600 hover:text-gray-300 disabled:opacity-20 leading-none text-[10px]">▲</button>
                <button onClick={() => move(f.id, 1)} disabled={i === fields.length - 1} className="text-gray-600 hover:text-gray-300 disabled:opacity-20 leading-none text-[10px]">▼</button>
              </div>
              <input
                value={f.label}
                onChange={(e) => updateField(f.id, { label: e.target.value })}
                className="flex-1 bg-transparent border-b border-transparent hover:border-[#2a2d3e] focus:border-[#00e5ff] text-sm font-mono text-white focus:outline-none px-1"
              />
              <Badge color="gray">{f.field_type}</Badge>
              {f.linked_section && <Badge color="magenta">← {f.linked_section}</Badge>}
              <span className="text-[10px] font-mono text-gray-600">{f.field_key}</span>
              <button onClick={() => updateField(f.id, { active: !f.active })}
                className={['text-xs font-mono px-2 py-0.5 rounded border', f.active ? 'border-[#39ff14]/30 text-[#39ff14]' : 'border-gray-600 text-gray-500'].join(' ')}>
                {f.active ? 'on' : 'off'}
              </button>
              <button onClick={() => { if (confirm(`Remove column "${f.label}"? Existing values stay in the data but won't show.`)) removeField(f.id) }}
                className="text-xs font-mono text-red-400 hover:text-red-300">×</button>
            </div>
          ))}
        </div>
      )}
      <p className="text-xs font-mono text-gray-600">
        Columns map on upload and appear across InventoryOS. Same-named columns in other sections link by key.
      </p>
    </div>
  )
}
