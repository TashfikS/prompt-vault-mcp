import { BookOpenCheck } from 'lucide-react'
import Modal from './ui/Modal'
import { RoleCard } from './ui/RoleBadge'

/** Plain-language reference for every role, reachable from Help at any time. */
export default function RolesGuideModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      title="Roles & permissions"
      description="Your role is set per group, so you can be an Owner in one group and a Guest in another."
      icon={<BookOpenCheck size={18} />}
      size="lg"
      onClose={onClose}
      footer={<button type="button" className="btn-primary" onClick={onClose} data-autofocus>Got it</button>}
    >
      <div className="grid gap-3 text-[13px] leading-5 text-slate-600 dark:text-zinc-300 sm:grid-cols-3">
        {(['GROUP_MANAGER', 'MEMBER', 'GUEST'] as const).map(kind => (
          <div key={kind} className="rounded-xl border border-slate-200 p-4 dark:border-zinc-800 dark:bg-zinc-950/40">
            <RoleCard kind={kind} />
          </div>
        ))}
      </div>
      <div className="mt-3 grid gap-3 text-[13px] leading-5 text-slate-600 dark:text-zinc-300 sm:grid-cols-2">
        {(['PERSONAL', 'ADMIN'] as const).map(kind => (
          <div key={kind} className="rounded-xl border border-dashed border-slate-200 bg-slate-50/60 p-4 dark:border-zinc-800 dark:bg-zinc-950/40">
            <RoleCard kind={kind} />
          </div>
        ))}
      </div>
      <p className="mt-4 rounded-lg bg-slate-50 px-3.5 py-3 text-[13px] text-slate-600 dark:bg-zinc-800/60 dark:text-zinc-300">
        <span className="font-medium text-slate-800 dark:text-zinc-200">How reviews work:</span> when a Member edits a prompt, the change becomes a proposal. Once it receives the number of approvals the group requires, it’s published as the next version automatically.
      </p>
    </Modal>
  )
}
