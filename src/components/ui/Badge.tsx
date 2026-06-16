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
  navy:    'bg-navy text-cream',                          // both flip together, contrast ok
  inky:    'bg-inky text-[#F2F1E6]',                    // medium bg; hardcode light text
  sky:     'bg-sky text-[#002745]',                      // sky never flips; hardcode dark text
  onyx:    'bg-onyx text-[#F2F1E6]',                    // black bg; hardcode light text
  cream:   'bg-cream text-navy border border-navy/20',   // both flip together, contrast ok
  red:     'bg-[#C0392B] text-[#F2F1E6]',               // stable red; hardcode light text
  green:   'bg-[#2ECC71] text-[#002745]',               // stable green; hardcode dark text
  orange:  'bg-[#E67E22] text-[#002745]',               // stable orange; hardcode dark text
  // aliases
  cyan:    'bg-sky text-[#002745]',                      // same as sky
  amber:   'bg-[#E67E22] text-[#002745]',               // same as orange
  gray:    'bg-inky/70 text-[#F2F1E6]',                 // medium bg; hardcode light text
  magenta: 'bg-navy text-cream',                         // both flip together
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
