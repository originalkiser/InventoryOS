// Shared shop-number/city label formatting — pulled out of
// CustomerHeatmapPage.tsx (where both were first written) so useLocations.ts
// can share the same fix instead of drifting with its own separate copy.

// City names sometimes come through from Droptop (or other imports) as
// all-caps or all-lower ("PORT ARTHUR", "port arthur") — normalize those to
// title case. Leaves anything already mixed-case alone (e.g. "McAllen")
// rather than guessing at capitalization rules for names this can't
// reliably get right.
export function normalizeCityCase(city: string): string {
  if (!city) return city
  const isAllUpper = city === city.toUpperCase()
  const isAllLower = city === city.toLowerCase()
  if (!isAllUpper && !isAllLower) return city
  return city.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
}

// "#-City" label — some locations' shop_city already comes prefixed with
// the shop number itself ("169-Lexington" as the raw stored value, not just
// "Lexington"), so naively concatenating name + shop_city doubles it up
// ("169 — 169-Lexington"). Strips a redundant leading "<name>-" before
// rebuilding, so this is correct either way the data's shaped.
export function shopNumberCityLabel(name: string, shopCity: string | null | undefined): string {
  const rawCity = normalizeCityCase(shopCity ?? '')
  const cleaned = rawCity.replace(new RegExp(`^${name}[\\s-]+`, 'i'), '')
  return cleaned ? `${name}-${cleaned}` : name
}
