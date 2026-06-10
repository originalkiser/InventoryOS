import { Toggle } from '@/components/ui'

interface InverseToggleProps {
  inverted: boolean
  onChange: (v: boolean) => void
}

export function InverseToggle({ inverted, onChange }: InverseToggleProps) {
  return (
    <div className="flex items-center gap-2">
      <Toggle checked={inverted} onChange={onChange} color="amber" size="sm" />
      <span className="text-xs font-mono text-[#ffb300]">{inverted ? '÷ Inverted' : 'Normal'}</span>
    </div>
  )
}
