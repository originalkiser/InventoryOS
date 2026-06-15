import React from 'react'

// Primary brand colors + legacy aliases for callers that use old neon names.
// Aliases: cyan→sky, amber→orange, gray→inky, magenta→navy
type Color =
  | 'navy' | 'inky' | 'sky' | 'onyx' | 'cream'
  | 'red' | 'green' | 'orange'
  // legacy aliases
  | 'cyan' | 'amber' | 'gray' | 'magenta'

interface BadgeProps {
  children: React.ReactNode
  color?: Color
  className?: string
}

const colorClasses: Record<Color, string> = {
  navy:    'bg-navy text-cream',
  inky:    'bg-inky text-cream',
  sky:     'bg-sky text-navy',
  onyx:    'bg-onyx text-cream',
  cream:   'bg-cream text-navy border border-navy/20',
  red:     'bg-[#C0392B] text-cream',
  green:   'bg-[#2ECC71] text-navy',
  orange:  'bg-[#E67E22] text-navy',
  // aliases
  cyan:    'bg-sky text-navy',
  amber:   'bg-[#E67E22] text-navy',
  gray:    'bg-inky/70 text-cream',
  magenta: 'bg-navy text-cream',
}

export function Badge({ children, color = 'inky', className = '' }: BadgeProps) {
  return (
    <span
      className={[
        'inline-flex items-center px-2 py-0.5 text-xs font-body font-medium rounded-full',
        colorClasses[color],
        className,
      ].join(' ')}
    >
      {children}
    </span>
  )
}
