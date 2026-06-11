import { useState } from 'react'
import { InverseToggle } from '@/components/shared/InverseToggle'
import { Button } from '@/components/ui'
import type { ColumnMapping } from '@/types'

interface RequiredField {
  name: string
  label: string
  required?: boolean
}

interface ColumnMapperProps {
  headers: string[]
  requiredFields: RequiredField[]
  onConfirm: (mappings: ColumnMapping[]) => void
  onCancel?: () => void
  // Optional saved-template mappings; pre-fill any whose sourceColumn exists in the file.
  initialMappings?: ColumnMapping[]
}

export function ColumnMapper({ headers, requiredFields, onConfirm, onCancel, initialMappings }: ColumnMapperProps) {
  const headerOptions = ['', ...headers]

  const [mappings, setMappings] = useState<ColumnMapping[]>(
    requiredFields.map((f) => {
      const fromTemplate = initialMappings?.find(
        (m) => m.fieldName === f.name && headers.includes(m.sourceColumn)
      )
      if (fromTemplate) return { ...fromTemplate }
      const auto = headers.find(
        (h) => h.toLowerCase().replace(/[^a-z0-9]/g, '') === f.name.toLowerCase().replace(/[^a-z0-9]/g, '')
      )
      return { fieldName: f.name, sourceColumn: auto ?? '', invert: false }
    })
  )

  function setColumn(fieldName: string, sourceColumn: string) {
    setMappings((prev) =>
      prev.map((m) => (m.fieldName === fieldName ? { ...m, sourceColumn } : m))
    )
  }

  function setInvert(fieldName: string, invert: boolean) {
    setMappings((prev) =>
      prev.map((m) => (m.fieldName === fieldName ? { ...m, invert } : m))
    )
  }

  function handleConfirm() {
    const missing = requiredFields
      .filter((f) => f.required)
      .filter((f) => !mappings.find((m) => m.fieldName === f.name)?.sourceColumn)
    if (missing.length > 0) {
      alert(`Please map required fields: ${missing.map((f) => f.label).join(', ')}`)
      return
    }
    onConfirm(mappings.filter((m) => m.sourceColumn))
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-gray-400 font-mono">
        Map your file's columns to the required fields. Toggle &quot;Invert&quot; to flip positive/negative values.
      </p>
      <div className="flex flex-col gap-3">
        {requiredFields.map((field) => {
          const mapping = mappings.find((m) => m.fieldName === field.name)!
          return (
            <div key={field.name} className="grid grid-cols-[1fr_1fr_auto] gap-3 items-center">
              <div className="text-sm font-mono text-gray-300">
                {field.label}
                {field.required && <span className="text-red-400 ml-1">*</span>}
              </div>
              <select
                value={mapping.sourceColumn}
                onChange={(e) => setColumn(field.name, e.target.value)}
                className="bg-[#0f1117] border border-[#2a2d3e] rounded px-2 py-1.5 text-sm font-mono text-white focus:outline-none focus:border-[#00e5ff]"
              >
                <option value="">— Not mapped —</option>
                {headers.map((h) => (
                  <option key={h} value={h}>{h}</option>
                ))}
              </select>
              <InverseToggle
                inverted={mapping.invert}
                onChange={(v) => setInvert(field.name, v)}
              />
            </div>
          )
        })}
      </div>
      <div className="flex justify-end gap-2 pt-2">
        {onCancel && (
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button size="sm" onClick={handleConfirm}>
          Confirm Mapping
        </Button>
      </div>
    </div>
  )
}
