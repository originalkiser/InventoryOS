import { useState } from 'react'
import { Modal } from '@/components/ui'
import type { CustomColumnType } from '@/hooks/useCustomColumns'

interface Props {
  open: boolean
  onClose: () => void
  onAdd: (label: string, type: CustomColumnType, options: { label: string; color?: string }[]) => Promise<void>
}

const TYPE_OPTIONS: { value: CustomColumnType; label: string; description: string }[] = [
  { value: 'text', label: 'Text', description: 'Free-form text entry' },
  { value: 'number', label: 'Number', description: 'Numeric value' },
  { value: 'date', label: 'Date', description: 'Date picker' },
  { value: 'status', label: 'Status Pill', description: 'Colored status badge with options' },
  { value: 'checkbox', label: 'Checkbox', description: 'True/false toggle' },
  { value: 'select', label: 'Dropdown', description: 'Select from a list of options' },
  { value: 'user', label: 'User', description: 'Select a team member from the directory' },
]

const DEFAULT_COLORS = ['#00e5ff', '#39ff14', '#ffb300', '#C0392B', '#4F7489', '#002745', '#F2F1E6']

export function CustomColumnBuilder({ open, onClose, onAdd }: Props) {
  const [label, setLabel] = useState('')
  const [type, setType] = useState<CustomColumnType>('text')
  const [options, setOptions] = useState<{ label: string; color: string }[]>([])
  const [newOption, setNewOption] = useState('')
  const [saving, setSaving] = useState(false)

  function reset() {
    setLabel('')
    setType('text')
    setOptions([])
    setNewOption('')
  }

  function handleClose() {
    reset()
    onClose()
  }

  function addOption() {
    const t = newOption.trim()
    if (!t) return
    setOptions((prev) => [...prev, { label: t, color: DEFAULT_COLORS[prev.length % DEFAULT_COLORS.length] }])
    setNewOption('')
  }

  function removeOption(i: number) {
    setOptions((prev) => prev.filter((_, idx) => idx !== i))
  }

  function setOptionColor(i: number, color: string) {
    setOptions((prev) => prev.map((o, idx) => (idx === i ? { ...o, color } : o)))
  }

  async function handleSave() {
    const l = label.trim()
    if (!l) return
    setSaving(true)
    await onAdd(l, type, (type === 'status' || type === 'select') ? options : [])
    setSaving(false)
    handleClose()
  }

  const needsOptions = type === 'status' || type === 'select'

  return (
    <Modal open={open} onClose={handleClose} title="Add Column">
      <div className="flex flex-col gap-4">
        {/* Column name */}
        <div className="flex flex-col gap-1">
          <label className="text-xs font-mono text-inky uppercase tracking-wide">Column Name *</label>
          <input
            autoFocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !needsOptions) handleSave() }}
            placeholder="e.g. Priority, Region, Notes"
            className="rounded border border-navy/30 bg-cream px-3 py-1.5 text-sm font-body text-navy placeholder-inky/40 focus:border-[#00e5ff] focus:outline-none"
          />
        </div>

        {/* Column type */}
        <div className="flex flex-col gap-2">
          <label className="text-xs font-mono text-inky uppercase tracking-wide">Column Type</label>
          <div className="grid grid-cols-2 gap-1.5">
            {TYPE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setType(opt.value)}
                className={[
                  'flex flex-col items-start px-3 py-2 rounded border text-left transition-colors',
                  type === opt.value
                    ? 'border-[#00e5ff] bg-[#00e5ff]/5 text-navy'
                    : 'border-navy/20 bg-cream text-inky hover:border-navy/40',
                ].join(' ')}
              >
                <span className="text-xs font-heading font-bold">{opt.label}</span>
                <span className="text-[10px] font-mono opacity-60">{opt.description}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Options (for status/select) */}
        {needsOptions && (
          <div className="flex flex-col gap-2">
            <label className="text-xs font-mono text-inky uppercase tracking-wide">Options</label>
            {options.length > 0 && (
              <ul className="flex flex-col gap-1">
                {options.map((opt, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <input
                      type="color"
                      value={opt.color}
                      onChange={(e) => setOptionColor(i, e.target.value)}
                      className="w-6 h-6 rounded border-none cursor-pointer"
                    />
                    <span className="flex-1 text-sm font-body text-navy">{opt.label}</span>
                    <button onClick={() => removeOption(i)} className="text-inky/40 hover:text-[#C0392B] text-xs">✕</button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex gap-2">
              <input
                value={newOption}
                onChange={(e) => setNewOption(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addOption() }}
                placeholder="Add option…"
                className="flex-1 rounded border border-navy/30 bg-cream px-2 py-1 text-sm font-body text-navy placeholder-inky/40 focus:border-[#00e5ff] focus:outline-none"
              />
              <button onClick={addOption} className="text-xs font-mono text-inky hover:text-navy border border-navy/30 rounded px-2">Add</button>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={handleClose} className="text-xs font-mono text-inky hover:text-navy px-3 py-1.5 border border-navy/20 rounded">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!label.trim() || saving}
            className="text-xs font-mono text-cream bg-navy hover:bg-inky px-3 py-1.5 rounded disabled:opacity-40"
          >
            {saving ? 'Adding…' : 'Add Column'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
