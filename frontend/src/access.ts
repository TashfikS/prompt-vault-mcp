import type { Group, GroupRole, User } from './types'
import type { AccessKind } from './components/ui/RoleBadge'

/** The caller's effective access to a space, for display purposes (the backend remains the authority). */
export function accessFor(group: Group | undefined, user: User | null): AccessKind {
  if (!group || !user) return 'GUEST'
  if (group.is_personal) return 'PERSONAL'
  const role: GroupRole | undefined = group.members.find(m => m.user_id === user.id)?.role
  if (role === 'GROUP_MANAGER') return 'GROUP_MANAGER'
  if (user.is_workspace_admin) return 'ADMIN'
  return role ?? 'GUEST'
}

export function spaceName(group: Pick<Group, 'name' | 'is_personal'>) {
  return group.is_personal ? 'Personal' : group.name
}
