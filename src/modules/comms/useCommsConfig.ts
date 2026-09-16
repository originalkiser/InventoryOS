import { useAppSetting } from '@/hooks/useAppSetting'
import { DEFAULT_COMMS_CONFIG, SYSTEM_COMM_TYPES, type CommsConfig } from './comms'

// Company-level Location Comms config (contact methods, who-contacted, comm types,
// action-taken options). Stored in platform.app_settings under 'comms_config'.
export function useCommsConfig() {
  const [raw, save, loaded] = useAppSetting<Partial<CommsConfig>>('comms_config', {})
  const commTypesBase = raw.commTypes?.length ? raw.commTypes : DEFAULT_COMMS_CONFIG.commTypes
  const config: CommsConfig = {
    contactMethods: raw.contactMethods?.length ? raw.contactMethods : DEFAULT_COMMS_CONFIG.contactMethods,
    whoContacted: raw.whoContacted?.length ? raw.whoContacted : DEFAULT_COMMS_CONFIG.whoContacted,
    // System types are always present, even for a company whose stored
    // commTypes was customized before these existed — see SYSTEM_COMM_TYPES.
    commTypes: [...new Set([...commTypesBase, ...SYSTEM_COMM_TYPES])],
    actionTaken: raw.actionTaken?.length ? raw.actionTaken : DEFAULT_COMMS_CONFIG.actionTaken,
    staleDays: raw.staleDays ?? DEFAULT_COMMS_CONFIG.staleDays,
    bumpDays: raw.bumpDays ?? DEFAULT_COMMS_CONFIG.bumpDays,
    customCauseSubcauses: raw.customCauseSubcauses ?? DEFAULT_COMMS_CONFIG.customCauseSubcauses,
  }
  // Append a value to a config list and persist.
  const addOption = (field: 'contactMethods' | 'whoContacted' | 'commTypes' | 'actionTaken', value: string) => {
    const cur = config[field]
    if (!value || cur.includes(value)) return
    save({ ...config, [field]: [...cur, value] })
  }
  // Same idea as addOption, but nested under a Cause category — a typed-in
  // Cause Detail only ever applies to whichever category it was added
  // under, same as the fixed causeTaxonomy.ts list it's merged with.
  const addCauseSubcause = (category: string, value: string) => {
    if (!category || !value) return
    const cur = config.customCauseSubcauses[category] ?? []
    if (cur.includes(value)) return
    save({ ...config, customCauseSubcauses: { ...config.customCauseSubcauses, [category]: [...cur, value] } })
  }
  return { config, save: (c: CommsConfig) => save(c), addOption, addCauseSubcause, loaded }
}
