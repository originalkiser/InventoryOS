export const ROLES = {
  DEVELOPER: 'developer',
  ADMINISTRATOR: 'administrator',
  AREA_MANAGER: 'area_manager',
  DIRECTOR: 'director',
  DEPARTMENT_USER: 'department_user',
} as const

export type Role = typeof ROLES[keyof typeof ROLES] | 'admin' | 'user'

export function isAdminOrDeveloper(role: string | null | undefined): boolean {
  return (
    role === ROLES.DEVELOPER ||
    role === ROLES.ADMINISTRATOR ||
    role === 'admin'
  )
}

export function isDeveloper(role: string | null | undefined): boolean {
  return role === ROLES.DEVELOPER
}

export function canAddOutlierNotes(role: string | null | undefined): boolean {
  return role === ROLES.AREA_MANAGER || role === ROLES.DIRECTOR
}

// Kept for backward-compat — now true for area_manager and director
export function isDepartmentHead(role: string | null | undefined): boolean {
  return role === ROLES.AREA_MANAGER || role === ROLES.DIRECTOR
}

export const ROLE_OPTIONS: { value: Role; label: string; description: string }[] = [
  { value: ROLES.DEVELOPER, label: 'Developer', description: 'Full access + manage feature requests and post status updates' },
  { value: ROLES.ADMINISTRATOR, label: 'Administrator', description: 'Full access, user management, permissions (cannot manage Developers)' },
  { value: ROLES.DIRECTOR, label: 'Director', description: 'Can add notes to outlier items assigned to them and their area managers' },
  { value: ROLES.AREA_MANAGER, label: 'Area Manager', description: 'Can add notes to outlier reporting items assigned to them' },
  { value: ROLES.DEPARTMENT_USER, label: 'Department User', description: 'Access to assigned departments and modules only' },
]

export function getRoleLabel(role: string | null | undefined): string {
  switch (role) {
    case ROLES.DEVELOPER: return 'Developer'
    case ROLES.ADMINISTRATOR: return 'Administrator'
    case ROLES.AREA_MANAGER: return 'Area Manager'
    case ROLES.DIRECTOR: return 'Director'
    case ROLES.DEPARTMENT_USER: return 'Department User'
    case 'admin': return 'Admin'
    case 'user': return 'User'
    default: return 'Unknown'
  }
}
