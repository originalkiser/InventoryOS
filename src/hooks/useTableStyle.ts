import { useProfilePref } from './useProfilePrefs'

// Which table look the user wants: the new "grid" (from the SB data grid concept: rounded frame, banded rows, numbered pager) or the classic
// one. Applies to every table built on the shared DataTable. Profile-backed so it follows the user across devices.
export type TableStyle = 'grid' | 'classic'
export const TABLE_STYLES: { id: TableStyle; label: string; sample: string }[] = [
  { id: 'grid', label: 'New grid', sample: 'Rounded frame, softer banding, numbered pages' },
  { id: 'classic', label: 'Classic', sample: 'The original tables' },
]

export function useTableStyle() {
  const [style, setStyle] = useProfilePref<TableStyle>('ui:tableStyle', 'grid')
  return { style: style === 'classic' ? ('classic' as const) : ('grid' as const), setStyle }
}
