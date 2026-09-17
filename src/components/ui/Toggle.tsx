interface ToggleProps {
  checked: boolean
  onChange: (v: boolean) => void
  label?: string
  size?: 'sm' | 'md'
  color?: 'cyan' | 'green' | 'amber'
}

const colorClasses = {
  cyan: 'bg-[#00e5ff]',
  green: 'bg-[#39ff14]',
  amber: 'bg-[#ffb300]',
}

export function Toggle({ checked, onChange, label, size = 'md', color = 'cyan' }: ToggleProps) {
  const trackW = size === 'sm' ? 'w-8' : 'w-10'
  const trackH = size === 'sm' ? 'h-4' : 'h-5'
  const thumbSize = size === 'sm' ? 'w-3 h-3' : 'w-4 h-4'
  const thumbTranslate = size === 'sm' ? 'translate-x-4' : 'translate-x-5'

  return (
    <label className="inline-flex items-center gap-2 cursor-pointer select-none">
      <div
        onClick={() => onChange(!checked)}
        className={[
          // shrink-0: the thumb below is `absolute`, so it never contributes
          // to this div's own intrinsic content size — without shrink-0, a
          // long sibling label (inline-flex row, no wrap) can force a flex
          // layout to shrink this track below its fixed w-8/w-10 anyway,
          // while the thumb keeps its fixed absolute offset and spills
          // outside the now-narrower oval. Found live via the Franchise
          // Menu Board form's toggle, whose label is by far the longest of
          // any Toggle usage in the app — short labels never hit this.
          'relative inline-block shrink-0 rounded-full transition-colors duration-200 cursor-pointer',
          trackW, trackH,
          checked ? colorClasses[color] : 'bg-[#2a2d3e]',
        ].join(' ')}
      >
        <span
          className={[
            'absolute top-0.5 left-0.5 rounded-full bg-white shadow transition-transform duration-200',
            thumbSize,
            checked ? thumbTranslate : 'translate-x-0',
          ].join(' ')}
        />
      </div>
      {label && <span className="text-xs font-mono text-inky">{label}</span>}
    </label>
  )
}
