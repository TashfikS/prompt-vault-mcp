import { Check, Crown, Eye, LockKeyhole, ShieldCheck, Users, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { GroupRole } from '../../types'
import Tooltip from './Tooltip'

export type AccessKind = GroupRole | 'ADMIN' | 'PERSONAL'

type RoleInfo = {
  label: string
  summary: string
  can: string[]
  cannot: string[]
  icon: LucideIcon
  badge: string
}

/** Single source of truth for what every role means. Used by badges, pickers, the roles guide and the tour. */
export const ROLE_INFO: Record<AccessKind, RoleInfo> = {
  GROUP_MANAGER: {
    label: 'Owner',
    summary: 'Runs the group and publishes changes directly.',
    can: ['Edit prompts and publish new versions', 'Switch which version is active', 'Approve or reject proposals', 'Invite people and change their roles', 'Set how many approvals a proposal needs'],
    cannot: [],
    icon: Crown,
    badge: 'bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-950/50 dark:text-amber-300 dark:ring-amber-500/30',
  },
  MEMBER: {
    label: 'Member',
    summary: 'Contributes through review.',
    can: ['Use, test and copy prompts', 'Propose edits for review', 'Approve teammates’ proposals'],
    cannot: ['Publish versions directly', 'Approve their own proposals'],
    icon: Users,
    badge: 'bg-brand-50 text-brand-800 ring-brand-600/20 dark:bg-brand-950/60 dark:text-brand-300 dark:ring-brand-500/30',
  },
  GUEST: {
    label: 'Guest',
    summary: 'View-only access.',
    can: ['View, test and copy prompts'],
    cannot: ['Edit or propose changes', 'Upload files', 'Approve proposals'],
    icon: Eye,
    badge: 'bg-slate-100 text-slate-700 ring-slate-500/20 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700',
  },
  ADMIN: {
    label: 'Workspace admin',
    summary: 'Oversees every team group in the workspace.',
    can: ['See and manage all team groups', 'Create groups and assign their Owner', 'Publish directly in any team group'],
    cannot: ['See other people’s Personal spaces'],
    icon: ShieldCheck,
    badge: 'bg-violet-50 text-violet-800 ring-violet-600/20 dark:bg-violet-950/50 dark:text-violet-300 dark:ring-violet-500/30',
  },
  PERSONAL: {
    label: 'Private',
    summary: 'Your personal space. Nobody else can see it.',
    can: ['Create, edit and version prompts freely', 'Draft privately before sharing with a group'],
    cannot: ['Invite others — create a group to collaborate'],
    icon: LockKeyhole,
    badge: 'bg-slate-100 text-slate-700 ring-slate-500/20 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700',
  },
}

export function RoleCard({ kind }: { kind: AccessKind }) {
  const info = ROLE_INFO[kind]
  const Icon = info.icon
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className={`grid h-6 w-6 place-items-center rounded-md ring-1 ring-inset ${info.badge}`}>
          <Icon size={13} aria-hidden />
        </span>
        <span className="font-semibold text-slate-900 dark:text-zinc-100">{info.label}</span>
      </div>
      <p className="mt-1.5 text-slate-600 dark:text-zinc-300">{info.summary}</p>
      <ul className="mt-2.5 space-y-1">
        {info.can.map(item => (
          <li key={item} className="flex gap-2">
            <Check size={14} className="mt-0.5 shrink-0 text-brand-600 dark:text-brand-400" aria-hidden />
            <span className="dark:text-zinc-200">{item}</span>
          </li>
        ))}
        {info.cannot.map(item => (
          <li key={item} className="flex gap-2 text-slate-500 dark:text-zinc-400">
            <X size={14} className="mt-0.5 shrink-0 text-slate-400 dark:text-zinc-500" aria-hidden />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Role pill that explains its permissions on hover or keyboard focus. */
export default function RoleBadge({
  kind,
  size = 'md',
  side = 'top',
  showIcon = true,
}: {
  kind: AccessKind
  size?: 'sm' | 'md'
  side?: 'top' | 'bottom' | 'right'
  showIcon?: boolean
}) {
  const info = ROLE_INFO[kind]
  const Icon = info.icon
  return (
    <Tooltip content={<RoleCard kind={kind} />} side={side}>
      <button
        type="button"
        aria-label={`${info.label} role — show permissions`}
        className={`inline-flex shrink-0 cursor-help items-center gap-1 rounded-full font-medium ring-1 ring-inset transition hover:brightness-95 ${info.badge} ${
          size === 'sm' ? 'px-1.5 py-px text-[11px]' : 'px-2 py-0.5 text-xs'
        }`}
      >
        {showIcon && <Icon size={size === 'sm' ? 10 : 12} aria-hidden />}
        {info.label}
      </button>
    </Tooltip>
  )
}
