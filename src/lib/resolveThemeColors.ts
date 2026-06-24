export interface FormColors {
  background: string
  surface: string
  primary: string
  accent: string
  text: string
  label: string
  input_bg: string
  input_border: string
  button_bg: string
  button_text: string
}

export interface FormTheme {
  preset: 'sb_dark' | 'sb_light' | 'custom'
  header_logo_key: string | null
  colors: FormColors
}

const SB_DARK: FormColors = {
  background:   '#002745',
  surface:      '#0D3555',
  primary:      '#4F7489',
  accent:       '#B7E0DE',
  text:         '#F2F1E6',
  label:        '#B7E0DE',
  input_bg:     '#0D3555',
  input_border: '#4F7489',
  button_bg:    '#4F7489',
  button_text:  '#FFFFFF',
}

const SB_LIGHT: FormColors = {
  background:   '#F2F1E6',
  surface:      '#FFFFFF',
  primary:      '#002745',
  accent:       '#4F7489',
  text:         '#002745',
  label:        '#4F7489',
  input_bg:     '#FFFFFF',
  input_border: '#B7E0DE',
  button_bg:    '#002745',
  button_text:  '#F2F1E6',
}

export const PRESET_COLORS: Record<'sb_dark' | 'sb_light', FormColors> = {
  sb_dark: SB_DARK,
  sb_light: SB_LIGHT,
}

export function resolveThemeColors(theme: FormTheme | null | undefined): FormColors {
  if (!theme) return SB_DARK
  if (theme.preset === 'sb_dark') return SB_DARK
  if (theme.preset === 'sb_light') return SB_LIGHT
  return { ...SB_DARK, ...theme.colors }
}

export const DEFAULT_THEME: FormTheme = {
  preset: 'sb_dark',
  header_logo_key: null,
  colors: { ...SB_DARK },
}
