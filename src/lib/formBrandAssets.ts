export const BRAND_ASSETS = [
  {
    key: 'sboc_logo_horizontal_light',
    label: 'SBOC Logo — Horizontal (Light)',
    path: '/brand/sboc-logo-horizontal-light.svg',
    preview: '/brand/sboc-logo-horizontal-light.svg',
  },
  {
    key: 'sboc_logo_horizontal_dark',
    label: 'SBOC Logo — Horizontal (Dark)',
    path: '/brand/sboc-logo-horizontal-dark.svg',
    preview: '/brand/sboc-logo-horizontal-dark.svg',
  },
  {
    key: 'sboc_logo_stacked_light',
    label: 'SBOC Logo — Stacked (Light)',
    path: '/brand/sboc-logo-stacked-light.svg',
    preview: '/brand/sboc-logo-stacked-light.svg',
  },
  {
    key: 'sboc_logo_stacked_dark',
    label: 'SBOC Logo — Stacked (Dark)',
    path: '/brand/sboc-logo-stacked-dark.svg',
    preview: '/brand/sboc-logo-stacked-dark.svg',
  },
  {
    key: 'tm_logo_horizontal',
    label: 'Trademark Car Wash — Horizontal',
    path: '/brand/tm-logo-horizontal.svg',
    preview: '/brand/tm-logo-horizontal.svg',
  },
] as const

export type BrandAssetKey = typeof BRAND_ASSETS[number]['key']
