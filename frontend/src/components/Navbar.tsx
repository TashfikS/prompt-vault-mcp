import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowRight, BookOpenCheck, ChevronsUpDown, CircleHelp, Compass, CreditCard, GitPullRequest, LibraryBig, LockKeyhole, LogOut, Menu, MessageSquarePlus, PlugZap, Plus, Users, X } from 'lucide-react'
import type { Group, PromptItem, User } from '../types'
import { accessFor, spaceName } from '../access'
import RoleBadge from './ui/RoleBadge'
import { Avatar, Logo } from './ui/Brand'
import { ThemeSegmentedControl, ThemeToggleButton } from '../theme'

export type Page = 'prompts' | 'groups' | 'reviews'

type Props = {
  activeUser: User | null
  groups: Group[]
  prompts: PromptItem[]
  page: Page
  selectedSpaceId: string | null
  pendingReviewsCount?: number
  onNavigate: (page: Page) => void
  onSelectSpace: (groupId: string | null) => void
  onNewGroup: () => void
  onConnect: () => void
  onStartTour: () => void
  onOpenRoles: () => void
  onOpenFeedback?: () => void
  onOpenPricing?: () => void
  onOpenPricingPage?: () => void
  onLogout: () => void
}

function useDismiss<T extends HTMLElement>(open: boolean, close: () => void) {
  const ref = useRef<T>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open, close])
  return ref
}

function MenuItem({ icon, children, onClick, tone = 'default' }: { icon: ReactNode; children: ReactNode; onClick: () => void; tone?: 'default' | 'danger' }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition ${
        tone === 'danger'
          ? 'text-rose-700 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40'
          : 'text-slate-700 hover:bg-slate-100 dark:text-zinc-300 dark:hover:bg-zinc-800'
      }`}
    >
      {icon}
      {children}
    </button>
  )
}

function SidebarContent(props: Props & { onAfterNavigate?: () => void }) {
  const { activeUser, groups, prompts, page, selectedSpaceId, pendingReviewsCount, onNavigate, onSelectSpace, onNewGroup, onConnect, onStartTour, onOpenRoles, onOpenFeedback, onOpenPricing, onOpenPricingPage, onLogout, onAfterNavigate } = props
  const [helpOpen, setHelpOpen] = useState(false)
  const [userOpen, setUserOpen] = useState(false)
  const helpRef = useDismiss<HTMLDivElement>(helpOpen, () => setHelpOpen(false))
  const userRef = useDismiss<HTMLDivElement>(userOpen, () => setUserOpen(false))
  const after = () => onAfterNavigate?.()

  const navItem = (id: Page, label: string, icon: ReactNode, tour: string, badge?: number) => {
    const active = page === id && (id === 'groups' || id === 'reviews' || selectedSpaceId === null)
    return (
      <button
        type="button"
        data-tour={tour}
        aria-current={active ? 'page' : undefined}
        onClick={() => { onNavigate(id); if (id === 'prompts') onSelectSpace(null); after() }}
        className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition ${
          active
            ? 'bg-slate-100 text-slate-900 dark:bg-zinc-900 dark:text-zinc-100'
            : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900 dark:text-zinc-400 dark:hover:bg-zinc-900/60 dark:hover:text-zinc-200'
        }`}
      >
        <span className={active ? 'text-brand-700 dark:text-brand-400' : 'text-slate-400 dark:text-zinc-500'}>{icon}</span>
        <span className="flex-1 text-left">{label}</span>
        {Boolean(badge && badge > 0) && (
          <span className="grid min-h-5 min-w-5 place-items-center rounded-full bg-brand-600 px-1.5 text-[11px] font-bold text-white shadow-2xs dark:bg-brand-500">
            {badge}
          </span>
        )}
      </button>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 shrink-0 items-center px-5">
        <button type="button" onClick={() => { onNavigate('prompts'); onSelectSpace(null); after() }} aria-label="PromptHold home" className="rounded-lg">
          <Logo />
        </button>
      </div>

      <nav aria-label="Main" className="space-y-0.5 px-3">
        {navItem('prompts', 'Prompt library', <LibraryBig size={17} />, 'nav-library')}
        {navItem('groups', 'Groups & access', <Users size={17} />, 'nav-groups')}
        {navItem('reviews', 'Review requests', <GitPullRequest size={17} />, 'nav-reviews', pendingReviewsCount)}
      </nav>

      <div data-tour="spaces" className="mt-6 min-h-0 flex-1 overflow-y-auto px-3 custom-scrollbar">
        <div className="mb-1.5 flex items-center justify-between px-2.5">
          <span className="text-xs font-medium text-slate-500 dark:text-zinc-400">Spaces</span>
          <button
            type="button"
            onClick={() => { onNewGroup(); after() }}
            aria-label="Create a new group"
            className="rounded-md p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:text-zinc-500 dark:hover:bg-zinc-850 dark:hover:text-zinc-300"
          >
            <Plus size={14} />
          </button>
        </div>
        <ul className="space-y-0.5">
          {groups.map(group => {
            const count = prompts.filter(p => p.group_id === group.id).length
            const active = page === 'prompts' && selectedSpaceId === group.id
            const access = accessFor(group, activeUser)
            return (
              <li
                key={group.id}
                className={`group/space flex items-center gap-1 rounded-lg pr-1.5 transition ${
                  active ? 'bg-slate-100 dark:bg-zinc-900' : 'hover:bg-slate-50 dark:hover:bg-zinc-900/60'
                }`}
              >
                <button
                  type="button"
                  onClick={() => { onNavigate('prompts'); onSelectSpace(group.id); after() }}
                  aria-current={active ? 'true' : undefined}
                  className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg py-1.5 pl-2.5 text-left text-sm"
                >
                  {group.is_personal ? (
                    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-slate-200/70 text-slate-600 dark:bg-zinc-800 dark:text-zinc-400">
                      <LockKeyhole size={11} />
                    </span>
                  ) : (
                    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-brand-600 text-[10px] font-semibold text-white dark:bg-brand-700">
                      {group.name[0]?.toUpperCase()}
                    </span>
                  )}
                  <span className={`truncate ${active ? 'font-medium text-slate-900 dark:text-zinc-100' : 'text-slate-700 dark:text-zinc-300'}`}>
                    {spaceName(group)}
                  </span>
                  <span className="ml-auto pl-1 text-xs tabular-nums text-slate-400 dark:text-zinc-500">{count}</span>
                </button>
                {!group.is_personal && <RoleBadge kind={access} size="sm" side="right" showIcon={false} />}
              </li>
            )
          })}
        </ul>
        {groups.filter(g => !g.is_personal).length === 0 && (
          <button
            type="button"
            onClick={() => { onNewGroup(); after() }}
            className="mt-2 w-full rounded-lg border border-dashed border-slate-300 px-3 py-2.5 text-left text-[13px] text-slate-500 transition hover:border-brand-400 hover:text-brand-700 dark:border-zinc-800 dark:text-zinc-400 dark:hover:border-brand-500/50 dark:hover:text-brand-300"
          >
            <span className="font-medium text-slate-700 dark:text-zinc-300">Working with a team?</span> Create a group to share prompts.
          </button>
        )}
      </div>

      <div className="shrink-0 space-y-1 border-t border-slate-200 p-3 dark:border-zinc-800">
        {/* Theme mode toggle */}
        <div className="mb-2.5 px-0.5">
          <div className="mb-1.5 flex items-center justify-between px-1 text-xs font-medium text-slate-500 dark:text-zinc-400">
            <span>Theme</span>
          </div>
          <ThemeSegmentedControl className="w-full" />
        </div>

        <button
          type="button"
          data-tour="connect-ai"
          onClick={() => { onConnect(); after() }}
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50 hover:text-slate-900 dark:text-zinc-400 dark:hover:bg-zinc-900/70 dark:hover:text-zinc-200 cursor-pointer"
        >
          <PlugZap size={17} className="text-slate-400 dark:text-zinc-500" /> Connect to AI
        </button>

        {/* Dedicated Price & Plan Section */}
        <div
          data-tour="price-and-plan"
          className="group/plan my-1.5 rounded-xl border border-slate-200/90 bg-gradient-to-br from-white via-slate-50/80 to-brand-50/25 p-2.5 shadow-2xs transition-all hover:border-brand-300 hover:shadow-xs dark:border-zinc-800 dark:from-zinc-900/90 dark:via-zinc-900/60 dark:to-brand-950/20 dark:hover:border-zinc-700"
        >
          <div className="flex items-center justify-between gap-1.5">
            <div className="flex min-w-0 items-center gap-2">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600 ring-1 ring-inset ring-brand-500/20 dark:bg-brand-950/80 dark:text-brand-300 dark:ring-brand-500/30">
                <CreditCard size={14} className="transition-transform group-hover/plan:scale-110" />
              </span>
              <div className="min-w-0 leading-tight">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-semibold capitalize text-slate-900 dark:text-zinc-100 truncate">
                    {activeUser?.plan || 'Community'}
                  </span>
                  <span className="rounded-full bg-slate-100 px-1.5 py-0.2 text-[10px] font-medium text-slate-600 dark:bg-zinc-800 dark:text-zinc-300">
                    Plan
                  </span>
                </div>
                <p className="truncate text-[11px] text-slate-500 dark:text-zinc-400 mt-0.5">
                  {activeUser?.plan === 'team'
                    ? '500 prompts · Approval gates'
                    : activeUser?.plan === 'pro'
                    ? '100 prompts · BYOS & diffs'
                    : activeUser?.plan === 'enterprise'
                    ? 'Unlimited scale · VPC'
                    : 'Free tier · 20 prompts'}
                </p>
              </div>
            </div>

            {onOpenPricing && (
              <button
                type="button"
                onClick={() => { onOpenPricing(); after() }}
                aria-label="Manage or upgrade plan"
                className={`shrink-0 rounded-lg px-2.5 py-1 text-[11px] font-semibold transition active:scale-95 cursor-pointer ${
                  activeUser?.plan && activeUser.plan !== 'community'
                    ? 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700'
                    : 'bg-brand-600 text-white shadow-2xs hover:bg-brand-700 dark:bg-brand-500 dark:hover:bg-brand-600'
                }`}
              >
                {activeUser?.plan && activeUser.plan !== 'community' ? 'Manage' : 'Upgrade'}
              </button>
            )}
          </div>

          <div className="mt-2 flex items-center justify-between border-t border-slate-100 pt-1.5 text-[11px] dark:border-zinc-800/80">
            <button
              type="button"
              onClick={() => {
                if (onOpenPricingPage) {
                  onOpenPricingPage()
                } else if (onOpenPricing) {
                  onOpenPricing()
                }
                after()
              }}
              className="inline-flex items-center gap-1 font-medium text-slate-500 transition hover:text-brand-600 dark:text-zinc-400 dark:hover:text-brand-300 cursor-pointer"
            >
              <span>Compare all plans</span>
              <ArrowRight size={11} />
            </button>
            <span className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
              {activeUser?.plan === 'community' || !activeUser?.plan ? 'Starts at $0' : 'Active'}
            </span>
          </div>
        </div>

        <div ref={helpRef} className="relative">
          <button
            type="button"
            data-tour="help"
            aria-haspopup="menu"
            aria-expanded={helpOpen}
            onClick={() => setHelpOpen(v => !v)}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50 hover:text-slate-900 dark:text-zinc-400 dark:hover:bg-zinc-900/70 dark:hover:text-zinc-200"
          >
            <CircleHelp size={17} className="text-slate-400 dark:text-zinc-500" /> Help &amp; guides
          </button>
          {helpOpen && (
            <div role="menu" className="absolute bottom-full left-0 z-30 mb-1.5 w-60 animate-pop-in rounded-xl border border-slate-200 bg-white p-1.5 shadow-pop dark:border-zinc-800 dark:bg-zinc-900">
              <MenuItem icon={<Compass size={15} className="text-slate-500 dark:text-zinc-400" />} onClick={() => { setHelpOpen(false); onStartTour(); after() }}>Take the product tour</MenuItem>
              <MenuItem icon={<BookOpenCheck size={15} className="text-slate-500 dark:text-zinc-400" />} onClick={() => { setHelpOpen(false); onOpenRoles(); after() }}>Roles &amp; permissions</MenuItem>
              {onOpenPricing && (
                <MenuItem icon={<CreditCard size={15} className="text-brand-600 dark:text-brand-400" />} onClick={() => { setHelpOpen(false); onOpenPricing(); after() }}>Plans &amp; pricing</MenuItem>
              )}
              {onOpenFeedback && (
                <MenuItem icon={<MessageSquarePlus size={15} className="text-slate-500 dark:text-zinc-400" />} onClick={() => { setHelpOpen(false); onOpenFeedback(); after() }}>Feedback &amp; report issue</MenuItem>
              )}
            </div>
          )}
        </div>

        {activeUser && (
          <div ref={userRef} className="relative pt-2">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={userOpen}
              onClick={() => setUserOpen(v => !v)}
              className="flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left transition hover:bg-slate-50 dark:hover:bg-zinc-900/70"
            >
              <Avatar name={activeUser.name} />
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block truncate text-sm font-medium text-slate-900 dark:text-zinc-100">{activeUser.name}</span>
                <span className="block truncate text-xs text-slate-500 dark:text-zinc-400">{activeUser.email}</span>
              </span>
              <ChevronsUpDown size={15} className="shrink-0 text-slate-400 dark:text-zinc-500" />
            </button>
            {userOpen && (
              <div role="menu" className="absolute bottom-full left-0 right-0 z-30 mb-1.5 animate-pop-in rounded-xl border border-slate-200 bg-white p-1.5 shadow-pop dark:border-zinc-800 dark:bg-zinc-900">
                <div className="px-2.5 pb-2 pt-1.5">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-slate-500 dark:text-zinc-400">Workspace role</p>
                    {activeUser.is_workspace_admin ? <RoleBadge kind="ADMIN" side="right" /> : <span className="text-xs text-slate-600 dark:text-zinc-300">Standard</span>}
                  </div>
                  <div className="mt-2 flex items-center justify-between rounded-lg bg-slate-50 px-2.5 py-1.5 dark:bg-zinc-800/60">
                    <div>
                      <span className="block text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-zinc-500">Plan</span>
                      <span className="text-xs font-bold capitalize text-slate-900 dark:text-zinc-100">
                        {activeUser.plan || 'Community'}
                      </span>
                    </div>
                    {onOpenPricing && (
                      <button
                        type="button"
                        onClick={() => { setUserOpen(false); onOpenPricing(); after() }}
                        className="rounded-md bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-700 hover:bg-brand-100 dark:bg-brand-950/80 dark:text-brand-300 dark:hover:bg-brand-900/60"
                      >
                        Plans
                      </button>
                    )}
                  </div>
                </div>
                {onOpenPricing && (
                  <MenuItem icon={<CreditCard size={15} className="text-brand-600 dark:text-brand-400" />} onClick={() => { setUserOpen(false); onOpenPricing(); after() }}>Plans &amp; pricing</MenuItem>
                )}
                <div className="my-1 border-t border-slate-100 dark:border-zinc-800" />
                <MenuItem icon={<LogOut size={15} />} tone="danger" onClick={() => { setUserOpen(false); onLogout() }}>Sign out</MenuItem>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** App navigation: fixed sidebar on desktop, top bar + slide-over drawer on smaller screens. */
export default function Navbar(props: Props) {
  const [drawer, setDrawer] = useState(false)
  useEffect(() => {
    if (!drawer) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawer(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [drawer])

  return (
    <>
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 border-r border-slate-200 bg-white lg:block dark:border-zinc-800 dark:bg-zinc-950">
        <SidebarContent {...props} />
      </aside>

      <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-slate-200 bg-white/95 px-4 backdrop-blur lg:hidden dark:border-zinc-800 dark:bg-zinc-950/95">
        <button
          type="button"
          onClick={() => { props.onNavigate('prompts'); props.onSelectSpace(null) }}
          aria-label="PromptHold home"
          className="rounded-lg text-left transition hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 cursor-pointer"
        >
          <Logo />
        </button>
        <div className="flex items-center gap-1.5">
          <ThemeToggleButton className="h-8 w-8" />
          {props.onOpenPricing && (
            <button
              type="button"
              onClick={props.onOpenPricing}
              className="btn-ghost px-2 text-brand-600 dark:text-brand-400"
              aria-label="Plans & pricing"
            >
              <CreditCard size={18} />
            </button>
          )}
          <button type="button" onClick={props.onConnect} className="btn-ghost px-2.5" aria-label="Connect to AI"><PlugZap size={18} /></button>
          <button type="button" onClick={() => setDrawer(true)} className="btn-ghost px-2.5" aria-label="Open navigation"><Menu size={20} /></button>
        </div>
      </header>

      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 animate-fade-in bg-black/60" onClick={() => setDrawer(false)} />
          <div role="dialog" aria-modal="true" aria-label="Navigation" className="absolute inset-y-0 left-0 w-72 max-w-[85vw] animate-sheet-in bg-white shadow-pop dark:border-r dark:border-zinc-800 dark:bg-zinc-950">
            <button
              type="button"
              onClick={() => setDrawer(false)}
              aria-label="Close navigation"
              className="absolute right-3 top-4 rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:text-zinc-500 dark:hover:bg-zinc-850 dark:hover:text-zinc-300"
            >
              <X size={18} />
            </button>
            <SidebarContent {...props} onAfterNavigate={() => setDrawer(false)} />
          </div>
        </div>
      )}
    </>
  )
}
