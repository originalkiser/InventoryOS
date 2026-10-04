// A DOS value with the yellow/red-scale conditional formatting and a hover explanation — shared by the Review table
// and the Stats modal's detail table so both read the same.
import { HoverTip, SwatchTipBody } from '@/components/ui/HoverTip'
import { dos } from './shared'
import { dosTone, DOS_TONE_COLOR, DOS_TONE_LABEL, type DosThresholds } from './lineFlags'

export function DosCell({ v, thresholds, style, align = 'right' }: { v: number | null | undefined; thresholds: DosThresholds | null; style: 'badge' | 'text'; align?: 'left' | 'right' }) {
  const pos = align === 'left' ? 'justify-start' : 'justify-end'
  const tone = thresholds ? dosTone(v ?? null, thresholds) : null
  // Same box either way (a fixed-height, right-aligned flex line) so a row never changes height when a value
  // crosses into or out of a colored tier while its quantity is being edited.
  if (!tone) return <span className={`flex items-center ${pos} h-4 leading-4`}>{dos(v)}</span>
  const color = DOS_TONE_COLOR[tone]
  return (
    <span className={`flex items-center ${pos} h-4 leading-4`}>
      <HoverTip content={<SwatchTipBody color={color} title={DOS_TONE_LABEL[tone]} />}>
        {style === 'text'
          ? <span className="font-bold leading-4" style={{ color }}>{dos(v)}</span>
          : <span className="inline-flex items-center h-4 rounded px-1 font-bold leading-4 text-navy" style={{ background: `${color}40`, boxShadow: `inset 0 -2px 0 ${color}` }}>{dos(v)}</span>}
      </HoverTip>
    </span>
  )
}
