import { useEffect, useRef, useState } from 'react'
import type { FormEvent, RefObject } from 'react'
import { BookOpenCheck, CheckCheck, LockKeyhole, Plus, Search, Shield, ShieldCheck, UserPlus, Users, X } from 'lucide-react'
import { api, updateGroupSettings } from '../api'
import type { Group, GroupRole, User } from '../types'
import LeaderSelectDropdown from './LeaderSelectDropdown'
import { Avatar } from './ui/Brand'
import RoleBadge, { ROLE_INFO, RoleCard } from './ui/RoleBadge'
import { useToast } from './ui/Toast'
import Tooltip from './ui/Tooltip'

const roleLabels: Record<GroupRole, string> = {
  GROUP_MANAGER: 'Owner',
  MEMBER: 'Member',
  GUEST: 'Guest',
}

function MemberInviteInput({
  candidates,
  value,
  onChange,
  placeholder = 'user@example.com or choose teammate…',
}: {
  candidates: User[]
  value: string
  onChange: (val: string) => void
  placeholder?: string
}) {
  const [isOpen, setIsOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const filtered = candidates.filter(
    u =>
      u.name.toLowerCase().includes(value.toLowerCase()) ||
      u.email.toLowerCase().includes(value.toLowerCase())
  )

  return (
    <div ref={wrapperRef} className="relative min-w-56 flex-1">
      <input
        type="text"
        aria-label="Teammate email"
        value={value}
        onChange={e => {
          onChange(e.target.value)
          setIsOpen(true)
        }}
        onFocus={() => setIsOpen(true)}
        placeholder={placeholder}
        className="field"
      />
      {isOpen && (filtered.length > 0 || value.trim().length > 0) && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1.5 max-h-56 animate-pop-in overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-pop dark:border-zinc-800 dark:bg-zinc-900">
          {filtered.length > 0 && (
            <div className="space-y-0.5">
              <div className="px-2 py-1 text-[11px] font-medium text-slate-400 dark:text-zinc-500">
                Registered teammates
              </div>
              {filtered.map(u => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => {
                    onChange(u.email)
                    setIsOpen(false)
                  }}
                  className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-slate-700 transition hover:bg-brand-50 hover:text-brand-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <Avatar name={u.name} size="sm" />
                    <span className="truncate font-medium">{u.name}</span>
                  </div>
                  <span className="truncate text-xs text-slate-400 dark:text-zinc-500">{u.email}</span>
                </button>
              ))}
            </div>
          )}
          {value.trim() && !filtered.some(u => u.email.toLowerCase() === value.trim().toLowerCase()) && (
            <div className="mt-1 border-t border-slate-100 pt-1 dark:border-zinc-800">
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-brand-700 hover:bg-brand-50 dark:text-brand-400 dark:hover:bg-zinc-800"
              >
                <span>Invite email:</span> <span className="font-semibold text-slate-800 dark:text-zinc-200">{value.trim()}</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function AccessGroupManager({
  groups,
  users,
  activeUser,
  onChanged,
  onOpenRoles,
  createInputRef,
}: {
  groups: Group[]
  users: User[]
  activeUser: User
  onChanged: () => void
  onOpenRoles?: () => void
  createInputRef?: RefObject<HTMLInputElement>
}) {
  const notify = useToast()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [leader, setLeader] = useState('')
  const [emailChoice, setEmailChoice] = useState<Record<string, string>>({})
  const [roleChoice, setRoleChoice] = useState<Record<string, GroupRole>>({})
  const [memberSearch, setMemberSearch] = useState<Record<string, string>>({})

  async function run(action: () => Promise<unknown>, success: string) {
    try {
      await action()
      notify(success)
      onChanged()
    } catch (e) {
      notify(e instanceof Error ? e.message : 'That change could not be saved.', { tone: 'error' })
    }
  }

  async function createGroup(event: FormEvent) {
    event.preventDefault()
    await run(
      () =>
        api('/api/groups', {
          method: 'POST',
          body: JSON.stringify({
            name,
            description,
            manager_user_id: activeUser.is_workspace_admin && leader ? leader : null,
          }),
        }),
      `Group “${name}” created.`
    )
    setName('')
    setDescription('')
    setLeader('')
  }

  const availableInviteRoles: GroupRole[] = activeUser.is_workspace_admin
    ? ['GROUP_MANAGER', 'MEMBER', 'GUEST']
    : ['MEMBER', 'GUEST']

  return (
    <main className="mx-auto max-w-6xl px-5 py-8 sm:px-8">
      {/* Header */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-950 dark:text-zinc-50 sm:text-3xl">Groups &amp; permissions</h1>
          <p className="mt-1.5 text-sm text-slate-500 dark:text-zinc-400">
            Organize prompts into shared spaces, invite teammates, and set review approval rules.
          </p>
        </div>

        {/* Interactive role reference bar */}
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2 shadow-xs dark:border-zinc-800 dark:bg-zinc-900">
          <span className="text-xs font-medium text-slate-500 dark:text-zinc-400">Hover a role to see what it can do:</span>
          <RoleBadge kind="GROUP_MANAGER" side="bottom" />
          <RoleBadge kind="MEMBER" side="bottom" />
          <RoleBadge kind="GUEST" side="bottom" />
          {onOpenRoles && (
            <button
              type="button"
              onClick={onOpenRoles}
              className="ml-1 inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline dark:text-brand-400"
            >
              <BookOpenCheck size={13} /> Full guide
            </button>
          )}
        </div>
      </div>

      {/* Create group form */}
      <form onSubmit={e => void createGroup(e)} className="card mb-7 p-5">
        <div className="mb-3.5 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-zinc-100">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300">
              <Shield size={15} />
            </span>
            {activeUser.is_workspace_admin ? 'Create a team group and assign its Owner' : 'Create a new team group'}
          </div>
          {!activeUser.is_workspace_admin && (
            <span className="text-xs text-slate-500 dark:text-zinc-400">
              You’ll automatically become the group <RoleBadge kind="GROUP_MANAGER" size="sm" side="bottom" />
            </span>
          )}
        </div>
        <div
          className={`grid gap-3 ${
            activeUser.is_workspace_admin ? 'md:grid-cols-[1fr_1.4fr_1fr_auto]' : 'md:grid-cols-[1fr_1.8fr_auto]'
          }`}
        >
          <input
            ref={createInputRef}
            required
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Group name (e.g. Operations, Legal)"
            aria-label="Group name"
            className="field"
          />
          <input
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="What does this group work on?"
            aria-label="Group description"
            className="field"
          />
          {activeUser.is_workspace_admin && (
            <LeaderSelectDropdown users={users} value={leader} onChange={setLeader} />
          )}
          <button className="btn-primary">
            <Plus size={15} /> Create group
          </button>
        </div>
      </form>

      {/* Group cards */}
      <div className="grid gap-5 lg:grid-cols-2">
        {groups.map(group => {
          const membership = group.members.find(m => m.user_id === activeUser.id)
          const canManage = activeUser.is_workspace_admin || membership?.role === 'GROUP_MANAGER'
          const candidates = users.filter(u => !group.members.some(m => m.user_id === u.id))
          const isPersonal = Boolean(group.is_personal)
          const selectedRole = roleChoice[group.id] ?? 'MEMBER'
          const groupSearch = (memberSearch[group.id] ?? '').trim().toLowerCase()
          const filteredMembers = group.members.filter(m => {
            if (!groupSearch) return true
            return (
              m.name.toLowerCase().includes(groupSearch) ||
              m.email.toLowerCase().includes(groupSearch) ||
              (roleLabels[m.role] || '').toLowerCase().includes(groupSearch)
            )
          })

          const myRoleKind = isPersonal
            ? 'PERSONAL'
            : membership?.role
            ? membership.role
            : activeUser.is_workspace_admin
            ? 'ADMIN'
            : 'GUEST'

          return (
            <article
              key={group.id}
              className="card flex flex-col justify-between p-6"
            >
              <div>
                {/* Group card header */}
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-lg font-semibold text-slate-900 dark:text-zinc-100">
                        {isPersonal ? 'Personal' : group.name}
                      </h2>
                      {isPersonal ? (
                        <RoleBadge kind="PERSONAL" size="sm" side="top" />
                      ) : (
                        <>
                          <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600 dark:bg-zinc-800 dark:text-zinc-400">
                            {group.members.length} {group.members.length === 1 ? 'person' : 'people'}
                          </span>
                          <RoleBadge kind={myRoleKind} size="sm" side="top" />
                        </>
                      )}
                    </div>
                    <p className="mt-1 text-sm text-slate-500 dark:text-zinc-400">
                      {group.description || (isPersonal ? 'Private prompts only you can see.' : 'Shared team prompt space.')}
                    </p>
                  </div>
                </div>

                {/* Required Approvals & Self-Approval configuration for team groups */}
                {!isPersonal && canManage && (
                  <div className="mt-4 space-y-3 rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 dark:border-zinc-800 dark:bg-zinc-950/40">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-[12rem] flex-1">
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-zinc-200">
                          <CheckCheck size={14} className="text-brand-600 dark:text-brand-400" />
                          Required approvals for proposals
                        </div>
                        <p className="mt-0.5 text-[11px] leading-4 text-slate-500 dark:text-zinc-400">
                          Votes needed from the Owner or other Members before a Member’s edit merges as a new version.
                        </p>
                      </div>
                      <div className="segmented">
                        {[1, 2, 3, 4, 5].map(num => {
                          const active = (group.required_approvals ?? 1) === num
                          return (
                            <Tooltip
                              key={num}
                              side="top"
                              width="w-56"
                              content={
                                <span>
                                  Require <strong className="font-semibold text-slate-900 dark:text-zinc-100">{num} {num === 1 ? 'approval' : 'approvals'}</strong> before a Member’s proposal is published as the next version.
                                </span>
                              }
                            >
                              <button
                                type="button"
                                onClick={() =>
                                  void run(
                                    () => updateGroupSettings(group.id, { required_approvals: num }),
                                    `Approval threshold set to ${num} for ${group.name}.`
                                  )
                                }
                                className={`h-7 w-7 rounded-md text-xs font-semibold transition ${
                                  active
                                    ? 'bg-brand-600 text-white shadow-xs'
                                    : 'text-slate-600 hover:bg-white hover:text-slate-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100'
                                }`}
                              >
                                {num}
                              </button>
                            </Tooltip>
                          )
                        })}
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-3 border-t border-slate-200/80 pt-3 dark:border-zinc-800/80">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-zinc-200">
                          <ShieldCheck size={14} className="text-brand-600 dark:text-brand-400" />
                          Allow proposer self-approval
                        </div>
                        <p className="mt-0.5 text-[11px] leading-4 text-slate-500 dark:text-zinc-400">
                          Allow the person who placed the prompt for review to cast an approval vote toward merging.
                        </p>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-label="Allow proposer self-approval"
                        aria-checked={Boolean(group.allow_self_approval)}
                        onClick={() => {
                          const nextVal = !group.allow_self_approval
                          void run(
                            () => updateGroupSettings(group.id, { allow_self_approval: nextVal }),
                            nextVal ? `Proposer self-approval enabled for ${group.name}.` : `Proposer self-approval disabled for ${group.name}.`
                          )
                        }}
                        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 ${
                          group.allow_self_approval ? 'bg-brand-600' : 'bg-slate-200 dark:bg-zinc-700'
                        }`}
                      >
                        <span
                          className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                            group.allow_self_approval ? 'translate-x-5' : 'translate-x-0'
                          }`}
                        />
                      </button>
                    </div>
                  </div>
                )}

                {/* Members section header + search */}
                <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 dark:text-zinc-400">
                    <Users size={14} className="text-slate-400 dark:text-zinc-500" />
                    <span>{isPersonal ? 'Space owner' : 'Group members'}</span>
                    {!isPersonal && (
                      <span className="font-normal text-slate-400 dark:text-zinc-500">
                        ({filteredMembers.length}{filteredMembers.length !== group.members.length ? ` of ${group.members.length}` : ''})
                      </span>
                    )}
                  </div>

                  {!isPersonal && group.members.length > 0 && (
                    <div className="relative">
                      <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-zinc-500" />
                      <input
                        type="text"
                        value={memberSearch[group.id] ?? ''}
                        onChange={e => setMemberSearch({ ...memberSearch, [group.id]: e.target.value })}
                        placeholder="Search members…"
                        aria-label={`Search members in ${group.name}`}
                        className="h-7 w-40 rounded-lg border border-slate-200 bg-white pl-7 pr-6 text-xs text-slate-800 placeholder:text-slate-400 outline-none transition focus:border-brand-600 focus:ring-2 focus:ring-brand-600/10 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:placeholder:text-zinc-500"
                      />
                      {memberSearch[group.id] && (
                        <button
                          type="button"
                          onClick={() => setMemberSearch({ ...memberSearch, [group.id]: '' })}
                          className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:text-zinc-500 dark:hover:text-zinc-300"
                          aria-label="Clear member search"
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* Members list */}
                {filteredMembers.length === 0 ? (
                  <div className="mt-3 rounded-xl border border-dashed border-slate-200 bg-slate-50/50 py-5 text-center text-xs text-slate-500 dark:border-zinc-800 dark:bg-zinc-950/30 dark:text-zinc-400">
                    <p>
                      No members match &ldquo;<span className="font-medium text-slate-700 dark:text-zinc-300">{memberSearch[group.id]}</span>&rdquo;
                    </p>
                    <button
                      type="button"
                      onClick={() => setMemberSearch({ ...memberSearch, [group.id]: '' })}
                      className="mt-1 font-semibold text-brand-700 hover:underline dark:text-brand-400"
                    >
                      Clear search
                    </button>
                  </div>
                ) : (
                  <div
                    className={`mt-3 space-y-2 ${
                      filteredMembers.length > 4
                        ? 'max-h-[240px] overflow-y-auto pr-1 custom-scrollbar'
                        : ''
                    }`}
                  >
                    {filteredMembers.map(member => {
                      const isLeader = member.role === 'GROUP_MANAGER'
                      const canModifyMember =
                        !isPersonal &&
                        canManage &&
                        (activeUser.is_workspace_admin || !isLeader)

                      const roleOptions: GroupRole[] = activeUser.is_workspace_admin
                        ? ['GROUP_MANAGER', 'MEMBER', 'GUEST']
                        : ['MEMBER', 'GUEST']

                      return (
                        <div
                          key={member.user_id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200/70 bg-slate-50/60 px-3 py-2 dark:border-zinc-800/80 dark:bg-zinc-950/40"
                        >
                          <div className="flex min-w-0 items-center gap-2.5">
                            <Avatar name={member.name} />
                            <div className="min-w-0">
                              <span className="block truncate text-sm font-medium text-slate-900 dark:text-zinc-100">
                                {member.name}
                              </span>
                              <span className="block truncate text-xs text-slate-400 dark:text-zinc-500">{member.email}</span>
                            </div>
                          </div>

                          <div className="flex items-center gap-2">
                            {canModifyMember ? (
                              <>
                                {/* Hoverable role switcher bar — hovering any role shows its full permission card */}
                                <div className="segmented" role="group" aria-label={`Role for ${member.name}`}>
                                  {roleOptions.map(r => {
                                    const active = member.role === r
                                    return (
                                      <Tooltip key={r} content={<RoleCard kind={r} />} side="top">
                                        <button
                                          type="button"
                                          disabled={active}
                                          onClick={() =>
                                            void run(
                                              () =>
                                                api(`/api/groups/${group.id}/members`, {
                                                  method: 'POST',
                                                  body: JSON.stringify({ user_id: member.user_id, role: r }),
                                                }),
                                              `Updated ${member.name} to ${ROLE_INFO[r].label}.`
                                            )
                                          }
                                          className={`rounded-md px-2 py-1 text-xs font-medium transition ${
                                            active
                                              ? 'bg-white font-semibold text-slate-900 shadow-xs cursor-default dark:bg-zinc-800 dark:text-zinc-100'
                                              : 'text-slate-500 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-zinc-200'
                                          }`}
                                        >
                                          {roleLabels[r]}
                                        </button>
                                      </Tooltip>
                                    )
                                  })}
                                </div>
                                <button
                                  type="button"
                                  onClick={() =>
                                    void run(
                                      () =>
                                        api(`/api/groups/${group.id}/members/${member.user_id}`, {
                                          method: 'DELETE',
                                        }),
                                      `${member.name} removed from ${group.name}.`
                                    )
                                  }
                                  className="rounded-md px-2 py-1 text-xs font-medium text-rose-600 transition hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40"
                                >
                                  Remove
                                </button>
                              </>
                            ) : (
                              <RoleBadge kind={isPersonal ? 'PERSONAL' : member.role} side="top" />
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* Card footer: Personal note, Invite bar, or Read-only note */}
              {isPersonal ? (
                <div className="mt-5 flex items-center gap-2 rounded-xl border border-slate-200/80 bg-slate-50 px-3.5 py-2.5 text-xs text-slate-600 dark:border-zinc-800 dark:bg-zinc-950/40 dark:text-zinc-300">
                  <LockKeyhole size={14} className="shrink-0 text-slate-400 dark:text-zinc-500" />
                  <span>This is your private space. Prompts saved here cannot be seen by anyone else.</span>
                </div>
              ) : canManage ? (
                <div className="mt-5 border-t border-slate-100 pt-4 dark:border-zinc-800">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-x-2">
                    <span className="text-xs font-semibold text-slate-700 dark:text-zinc-300">
                      Invite or add teammate
                    </span>
                    <span className="text-[11px] text-slate-400 dark:text-zinc-500">Hover a role to preview permissions</span>
                  </div>
                  <div className="space-y-2">
                    <MemberInviteInput
                      candidates={candidates}
                      value={emailChoice[group.id] ?? ''}
                      onChange={val => setEmailChoice({ ...emailChoice, [group.id]: val })}
                    />

                    <div className="flex items-center justify-between gap-2">
                    {/* Role Segmented Selector with hover tooltips */}
                    <div className="segmented" role="group" aria-label="Role for invited teammate">
                      {availableInviteRoles.map(role => {
                        const active = selectedRole === role
                        return (
                          <Tooltip key={role} content={<RoleCard kind={role} />} side="top">
                            <button
                              type="button"
                              onClick={() => setRoleChoice({ ...roleChoice, [group.id]: role })}
                              className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition ${
                                active
                                  ? 'bg-white font-semibold text-slate-900 shadow-xs dark:bg-zinc-800 dark:text-zinc-100'
                                  : 'text-slate-600 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-zinc-200'
                              }`}
                            >
                              {roleLabels[role]}
                            </button>
                          </Tooltip>
                        )
                      })}
                    </div>

                    <button
                      type="button"
                      disabled={!emailChoice[group.id]?.trim()}
                      onClick={() => {
                        const targetEmail = emailChoice[group.id]?.trim()
                        void run(
                          () =>
                            api(`/api/groups/${group.id}/members`, {
                              method: 'POST',
                              body: JSON.stringify({ email: targetEmail, role: selectedRole }),
                            }),
                          `Invited ${targetEmail} as ${ROLE_INFO[selectedRole].label}.`
                        )
                        setEmailChoice({ ...emailChoice, [group.id]: '' })
                      }}
                      className="btn-primary"
                    >
                      <UserPlus size={15} /> Add
                    </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="mt-5 flex items-center justify-between gap-2 rounded-xl border border-slate-200/80 bg-slate-50 px-3.5 py-2.5 text-xs text-slate-500 dark:border-zinc-800 dark:bg-zinc-950/40 dark:text-zinc-400">
                  <span className="flex items-center gap-2">
                    <LockKeyhole size={14} className="shrink-0 text-slate-400 dark:text-zinc-500" />
                    Only the Group Owner can add or remove members.
                  </span>
                  <RoleBadge kind={myRoleKind} size="sm" side="top" />
                </div>
              )}
            </article>
          )
        })}
      </div>

      {!groups.length && (
        <div className="card border-dashed p-12 text-center text-sm text-slate-500 dark:text-zinc-400">
          You are not a member of any groups yet. Create one above to get started.
        </div>
      )}
    </main>
  )
}
