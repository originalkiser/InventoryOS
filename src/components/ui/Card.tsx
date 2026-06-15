import React from 'react'

interface CardProps {
  children: React.ReactNode
  className?: string
  onClick?: () => void
}

export function Card({ children, className = '', onClick }: CardProps) {
  return (
    <div
      onClick={onClick}
      className={[
        'bg-cream border border-navy/40 rounded-lg shadow-sm transition-all duration-200',
        onClick ? 'cursor-pointer hover:border-navy' : '',
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
