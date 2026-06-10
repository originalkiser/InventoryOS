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
    <div className={['flex gap-1 border-b border-[#2a2d3e] mb-4', className].join(' ')}>
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
        'px-4 py-2 text-xs font-mono font-medium uppercase tracking-wide transition-all border-b-2 -mb-px',
        isActive
          ? 'border-[#00e5ff] text-[#00e5ff]'
          : 'border-transparent text-gray-500 hover:text-gray-300',
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
