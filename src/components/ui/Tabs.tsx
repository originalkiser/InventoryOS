import React, { createContext, useContext, useState } from 'react'

interface TabsContextValue {
  active: string
  setActive: (v: string) => void
}

const TabsContext = createContext<TabsContextValue>({ active: '', setActive: () => {} })

interface TabsProps {
  defaultValue: string
  children: React.ReactNode
  className?: string
}

export function Tabs({ defaultValue, children, className = '' }: TabsProps) {
  const [active, setActive] = useState(defaultValue)
  return (
    <TabsContext.Provider value={{ active, setActive }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  )
}

export function TabsList({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={['flex gap-1 border-b border-navy/30 mb-4', className].join(' ')}>
      {children}
    </div>
  )
}

export function TabsTrigger({ value, children }: { value: string; children: React.ReactNode }) {
  const { active, setActive } = useContext(TabsContext)
  const isActive = active === value
  return (
    <button
      onClick={() => setActive(value)}
      className={[
        'px-4 py-2 text-xs font-heading font-bold uppercase tracking-wide transition-all border-b-2 -mb-px',
        isActive
          ? 'border-navy text-navy'
          : 'border-transparent text-inky hover:text-navy',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

export function TabsContent({ value, children }: { value: string; children: React.ReactNode }) {
  const { active } = useContext(TabsContext)
  if (active !== value) return null
  return <div>{children}</div>
}
