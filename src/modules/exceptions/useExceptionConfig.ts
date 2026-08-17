import { useAppSetting } from '@/hooks/useAppSetting'
import { DEFAULT_EXCEPTION_CONFIG, type ExceptionConfig } from './exceptions'

// Company-level Exception Reporting config (types, issues-per-type, response window).
// Stored in platform.app_settings under 'exception_config'; missing keys fall back to defaults.
export function useExceptionConfig() {
  const [raw, save, loaded] = useAppSetting<Partial<ExceptionConfig>>('exception_config', {})
  const config: ExceptionConfig = {
    types: raw.types?.length ? raw.types : DEFAULT_EXCEPTION_CONFIG.types,
    issues: raw.issues ?? DEFAULT_EXCEPTION_CONFIG.issues,
    responseDays: raw.responseDays ?? DEFAULT_EXCEPTION_CONFIG.responseDays,
    statuses: raw.statuses?.length ? raw.statuses : DEFAULT_EXCEPTION_CONFIG.statuses,
    staleDays: raw.staleDays ?? DEFAULT_EXCEPTION_CONFIG.staleDays,
    bumpDays: raw.bumpDays ?? DEFAULT_EXCEPTION_CONFIG.bumpDays,
  }
  return { config, save: (c: ExceptionConfig) => save(c), loaded }
}
