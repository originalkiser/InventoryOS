export const ROLES = {
  DEVELOPER: 'developer',
  ADMINISTRATOR: 'administrator',
  DEPARTMENT_HEAD: 'department_head',
  DEPARTMENT_USER: 'department_user',
} as const

export type Role = typeof ROLES[keyof typeof ROLES] | 'admin' | 'user'

export function isAdminOrDeveloper(role: string | null | undefined): boolean {
  return (
    role === ROLES.DEVELOPER ||
    role === ROLES.ADMINISTRATOR ||
    role === 'admin' // legacy value
  )
}

export function isDepartmentHead(role: string | null | undefined): boolean {
  return role === ROLES.DEPARTMENT_HEAD
}

export function getRoleLabel(role: string | null | undefined): string {
  switch (role) {
    case ROLES.DEVELOPER: return 'Developer'
    case ROLES.ADMINISTRATOR: return 'Administrator'
    case ROLES.DEPARTMENT_HEAD: return 'Department Head'
    case ROLES.DEPARTMENT_USER: return 'Department User'
    case 'admin': return 'Admin'
    case 'user': return 'User'
    default: return 'Unknown'
  }
}
