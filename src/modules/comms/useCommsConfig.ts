import { useAppSetting } from '@/hooks/useAppSetting'
import { DEFAULT_COMMS_CONFIG, type CommsConfig } from './comms'

// Company-level Location Comms config (contact methods, who-contacted, comm types,
// action-taken options). Stored in platform.app_settings under 'comms_config'.
export function useCommsConfig() {
  const [raw, save, loaded] = useAppSetting<Partial<CommsConfig>>('comms_config', {})
  const config: CommsConfig = {
    contactMethods: raw.contactMethods?.length ? raw.contactMethods : DEFAULT_COMMS_CONFIG.contactMethods,
    whoContacted: raw.whoContacted?.length ? raw.whoContacted : DEFAULT_COMMS_CONFIG.whoContacted,
    commTypes: raw.commTypes?.length ? raw.commTypes : DEFAULT_COMMS_CONFIG.commTypes,
    actionTaken: raw.actionTaken?.length ? raw.actionTaken : DEFAULT_COMMS_CONFIG.actionTaken,
  }
  // Append a value to a config list and persist.
  const addOption = (field: keyof CommsConfig, value: string) => {
    const cur = config[field]
    if (!value || cur.includes(value)) return
    save({ ...config, [field]: [...cur, value] })
  }
  return { config, save: (c: CommsConfig) => save(c), addOption, loaded }
}
