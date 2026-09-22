// Shared "equivalent case types" convention — a trailing run of letters on a
// product id marks its case/package-type suffix (e.g. "D" for drum, "BB" for
// bulk/tote, "C" for case), so stripping it gives the product family both
// belong to (5W30D and 5W30BB both resolve to "5W30"). Same rule Orders v2's
// on-hand/usage combine and Month End's "equivalent on-hand" lookup already
// use independently — kept here as the one shared definition for a new
// caller rather than adding a fourth copy.
export function baseProductId(id: string): string {
  return id.replace(/[A-Z]+$/i, '') || id
}
