// Small reusable interactive controls shared across Orders v2's pages —
// split out from shared.ts (a plain .ts file, no JSX) rather than renaming
// it, since a .ts and .tsx file can't coexist under the same base name.

/**
 * A toggle that reads as a button, not a switch — the label itself changes
 * to say what's currently happening ("Showing VMI/Keepfill" vs.
 * "VMI/Keepfill Hidden"), colored green while active. Direct ask
 * 2026-09-29: a plain on/off Toggle next to a static label ("Show VMI /
 * keepfill") doesn't say what's ACTUALLY shown right now without reading
 * the toggle's own state separately — this collapses both into one glance.
 */
export function ToggleButton({ checked, onChange, onLabel, offLabel, onTooltip, offTooltip, className }: {
  checked: boolean
  onChange: (v: boolean) => void
  onLabel: string
  offLabel: string
  onTooltip?: string
  offTooltip?: string
  className?: string
}) {
  return (
    <button type="button" onClick={() => onChange(!checked)}
      title={checked ? onTooltip : offTooltip}
      className={[
        'text-[11px] font-mono uppercase tracking-wide rounded border px-2 py-1 transition-colors whitespace-nowrap',
        checked ? 'text-[#2ECC71] border-[#2ECC71]/50 bg-[#2ECC71]/10 hover:bg-[#2ECC71]/15' : 'text-inky/50 border-navy/25 hover:border-navy/40 hover:text-navy',
        className ?? '',
      ].join(' ')}>
      {checked ? onLabel : offLabel}
    </button>
  )
}

/**
 * A row of mutually-exclusive options with a sliding green highlight behind
 * whichever one is selected — direct ask 2026-09-29, replacing plain
 * dropdowns (order day, vendor) with something that visually animates
 * between choices instead of snapping. Generic over the option value type
 * so the same component drives both a 5-day Mon-Fri picker and a
 * 2-3-vendor picker.
 */
export function SegmentedSlider<T extends string>({ options, value, onChange, className }: {
  options: { value: T; label: string; disabled?: boolean }[]
  value: T
  onChange: (v: T) => void
  className?: string
}) {
  // Bug found live 2026-09-30: this used to fall back to index 0 (Monday,
  // in the day-of-week picker) whenever `value` didn't exactly match ANY
  // option — e.g. a draft whose order day derives to a weekend value before
  // its own settings_snapshot has __order_dow set (draftOrderDow's own
  // fallback), which the Mon-Fri-only option list never includes. That
  // painted the green highlight bar under Monday even though no button's
  // text was actually marked active, reading as "Monday looks selected"
  // until a real click landed on a matching option. No highlight at all
  // (rather than a wrong one) is the correct state for a value that
  // genuinely isn't one of the options.
  const idx = options.findIndex((o) => o.value === value)
  const n = Math.max(1, options.length)
  return (
    <div className={`relative inline-flex rounded border border-navy/30 overflow-hidden text-[11px] font-mono bg-cream ${className ?? ''}`}>
      {idx >= 0 && (
        <div
          className="absolute top-0 bottom-0 bg-[#2ECC71] transition-transform duration-200 ease-out"
          style={{ width: `${100 / n}%`, transform: `translateX(${idx * 100}%)` }}
        />
      )}
      {options.map((o) => (
        <button key={o.value} type="button" disabled={o.disabled} onClick={() => onChange(o.value)}
          className={[
            'relative z-10 flex-1 px-3 py-1.5 uppercase tracking-wide transition-colors whitespace-nowrap',
            o.value === value ? 'text-navy font-bold' : 'text-inky/50 hover:text-navy',
            o.disabled ? 'opacity-30 cursor-not-allowed' : '',
          ].join(' ')}>
          {o.label}
        </button>
      ))}
    </div>
  )
}
