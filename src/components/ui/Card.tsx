import React from 'react'

interface CardProps {
  children: React.ReactNode
  className?: string
  glow?: 'cyan' | 'green' | 'amber' | 'magenta' | 'none'
  onClick?: () => void
}

const glowClasses = {
  cyan: 'hover:shadow-[0_0_16px_rgba(0,229,255,0.15)] hover:border-[#00e5ff]/40',
  green: 'hover:shadow-[0_0_16px_rgba(57,255,20,0.15)] hover:border-[#39ff14]/40',
  amber: 'hover:shadow-[0_0_16px_rgba(255,179,0,0.15)] hover:border-[#ffb300]/40',
  magenta: 'hover:shadow-[0_0_16px_rgba(255,0,255,0.15)] hover:border-[#ff00ff]/40',
  none: '',
}

export function Card({ children, className = '', glow = 'none', onClick }: CardProps) {
  return (
    <div
      onClick={onClick}
      className={[
        'bg-[#161820] border border-[#2a2d3e] rounded-lg transition-all duration-200',
        glow !== 'none' ? glowClasses[glow] : '',
        onClick ? 'cursor-pointer' : '',
        className,
      ].join(' ')}
    >
      {children}
    </div>
  )
}

export function CardHeader({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={['px-5 py-4 border-b border-[#2a2d3e]', className].join(' ')}>
      {children}
    </div>
  )
}

export function CardBody({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={['px-5 py-4', className].join(' ')}>{children}</div>
}
