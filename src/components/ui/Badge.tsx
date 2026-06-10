import React from 'react'

type Color = 'cyan' | 'green' | 'magenta' | 'amber' | 'red' | 'gray'

interface BadgeProps {
  children: React.ReactNode
  color?: Color
  className?: string
}

const colorClasses: Record<Color, string> = {
  cyan: 'border-[#00e5ff]/40 text-[#00e5ff] bg-[#00e5ff]/10',
  green: 'border-[#39ff14]/40 text-[#39ff14] bg-[#39ff14]/10',
  magenta: 'border-[#ff00ff]/40 text-[#ff00ff] bg-[#ff00ff]/10',
  amber: 'border-[#ffb300]/40 text-[#ffb300] bg-[#ffb300]/10',
  red: 'border-red-500/40 text-red-400 bg-red-500/10',
  gray: 'border-gray-600 text-gray-400 bg-gray-800/40',
}

export function Badge({ children, color = 'cyan', className = '' }: BadgeProps) {
  return (
    <span
      className={[
        'inline-flex items-center px-2 py-0.5 text-xs font-mono font-medium border rounded',
        colorClasses[color],
        className,
      ].join(' ')}
    >
      {children}
    </span>
  )
}
