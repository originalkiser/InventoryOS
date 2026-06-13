// Configurable days-of-supply flag scale. Each color band has one or more
// ranges (min/max, either bound nullable) so a band can be compound — e.g. red
// = days < 3 OR days > 200 (too low or too high).

export type FlagColor = 'red' | 'amber' | 'green'
export interface FlagRange { min: number | null; max: number | null }
export interface FlagBand { color: FlagColor; ranges: FlagRange[] }
export interface FlagConfig { slider_days: number; bands: FlagBand[] }

export const DEFAULT_FLAG_CONFIG: FlagConfig = {
  slider_days: 7,
  bands: [
    { color: 'red', ranges: [{ min: null, max: 3 }, { min: 200, max: null }] },
    { color: 'amber', ranges: [{ min: 3, max: 7 }] },
    { color: 'green', ranges: [{ min: 7, max: 200 }] },
  ],
}

function inRange(days: number, r: FlagRange): boolean {
  return (r.min == null || days >= r.min) && (r.max == null || days < r.max)
}

// First band (in config order) whose any range matches wins. null = unflagged.
export function flagColorFor(days: number | null, config: FlagConfig): FlagColor | null {
  if (days == null) return null
  for (const band of config.bands) {
    if (band.ranges.some((r) => inRange(days, r))) return band.color
  }
  return null
}

// Below the user's slider threshold = a "low" call-out.
export function isLow(days: number | null, config: FlagConfig): boolean {
  return days != null && days < config.slider_days
}

export const FLAG_HEX: Record<FlagColor, string> = { red: '#ef4444', amber: '#ffb300', green: '#39ff14' }
