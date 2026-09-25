import React from 'react'

interface CardProps {
  children: React.ReactNode
  className?: string
  onClick?: () => void
  /** Skips the default bg/border/shadow entirely, keeping only `className` —
   * for a caller that already sits inside its own bordered frame (e.g.
   * Location Lookup's grid widgets, GridWidgetShell) and would otherwise get
   * a redundant nested border/rounded-corner look, or worse, a border that
   * lives on scrolling content instead of a fixed frame. */
  plain?: boolean
}

export function Card({ children, className = '', onClick, plain = false }: CardProps) {
  return (
    <div
      onClick={onClick}
      className={[
        plain ? '' : 'bg-cream border border-navy/40 rounded-lg shadow-sm transition-all duration-200',
        onClick && !plain ? 'cursor-pointer hover:border-navy' : '',
        className,
      ].join(' ')}
    >
      {children}
    </div>
  )
}

export function CardHeader({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={['px-5 py-4 border-b border-navy/20', className].join(' ')}>
      {children}
    </div>
  )
}

export function CardBody({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={['px-5 py-4', className].join(' ')}>{children}</div>
}
