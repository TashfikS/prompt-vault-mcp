import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AUTH_EXPIRED_EVENT, completeOnboarding, getAllProposals, getGroups, getMe, getPrompts, getSessionToken, getUsers, logout } from './api'
import type { Group, PromptItem, PromptProposalItem, User } from './types'
import Navbar from './components/Navbar'
import type { Page } from './components/Navbar'
import PromptDashboard from './components/PromptDashboard'
import FileUploadModal from './components/FileUploadModal'
import PromptEditorAndHistory from './components/PromptEditorAndHistory'
import AccessGroupManager from './components/AccessGroupManager'
import ReviewRequestsDashboard from './components/ReviewRequestsDashboard'
import SharedDiffPage from './components/SharedDiffPage'
import McpInChatDrawer from './components/McpInChatDrawer'
import LoginPage from './components/LoginPage'
import NewPromptModal from './components/NewPromptModal'
import DuplicatePromptModal from './components/DuplicatePromptModal'
import ConnectAiModal from './components/ConnectAiModal'
import RolesGuideModal from './components/RolesGuideModal'
import PricingModal from './components/PricingModal'
import PricingPage from './components/PricingPage'
import OnboardingTour from './components/OnboardingTour'
import { FeedbackWidget } from './components/FeedbackWidget'
import { ToastProvider } from './components/ui/Toast'
import { LogoMark } from './components/ui/Brand'
import ErrorBoundary from './components/ui/ErrorBoundary'

export default function App() {
  const params = new URLSearchParams(window.location.search)
  const shareId = params.get('share_diff') ?? window.location.pathname.match(/^\/share\/diff\/([^/]+)/)?.[1]
  const mcpMode = params.get('mcp_mode') === '1'
  const isInitialPricingRoute =
    params.get('page') === 'pricing' || params.get('pricing') === '1' || window.location.pathname === '/pricing'

  const [users, setUsers] = useState<User[]>([])
  const [activeUser, setActiveUser] = useState<User | null>(null)
  const [authState, setAuthState] = useState<'checking' | 'signed-out' | 'signed-in'>(getSessionToken() ? 'checking' : 'signed-out')
  const [prompts, setPrompts] = useState<PromptItem[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [proposals, setProposals] = useState<PromptProposalItem[]>([])
  const [page, setPage] = useState<Page>('prompts')
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedPrompt, setSelectedPrompt] = useState<PromptItem | null>(null)
  const [uploading, setUploading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [duplicatePromptTarget, setDuplicatePromptTarget] = useState<PromptItem | null>(null)
  const [connectOpen, setConnectOpen] = useState(false)
  const [rolesOpen, setRolesOpen] = useState(false)
  const [pricingOpen, setPricingOpen] = useState(false)
  const [pricingPageOpen, setPricingPageOpen] = useState(isInitialPricingRoute)
  const [feedbackOpen, setFeedbackOpen] = useState<boolean | undefined>(undefined)
  const [tourOpen, setTourOpen] = useState(false)
  const [error, setError] = useState('')
  const createGroupInputRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [nextPrompts, nextGroups, nextUsers, allProposals] = await Promise.all([
        getPrompts(),
        getGroups(),
        getUsers(),
        getAllProposals().catch(() => []),
      ])
      setPrompts(nextPrompts)
      setGroups(nextGroups)
      setUsers(nextUsers)
      setProposals(allProposals)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load workspace.')
    } finally {
      setLoading(false)
    }
  }, [])

  const resetWorkspace = useCallback(() => {
    setActiveUser(null)
    setUsers([])
    setPrompts([])
    setGroups([])
    setProposals([])
    setSelectedPrompt(null)
    setSelectedSpaceId(null)
    setUploading(false)
    setCreating(false)
    setDuplicatePromptTarget(null)
    setConnectOpen(false)
    setRolesOpen(false)
    setPricingOpen(false)
    setTourOpen(false)
    setPage('prompts')
    setError('')
  }, [])

  const pendingReviewsCount = useMemo(() => {
    return proposals.filter(
      p => p.status === 'PENDING' && p.proposer_id !== activeUser?.id && !p.has_approved && p.can_approve
    ).length
  }, [proposals, activeUser])

  const loadSession = useCallback(async () => {
    if (!getSessionToken()) {
      setAuthState('signed-out')
      return
    }
    try {
      const rawMe = (await getMe()) as any
      const me: User = rawMe?.user ? { ...rawMe.user, groups: rawMe.groups || rawMe.user.groups } : rawMe
      const meId = me?.id || 'me'
      const seenKey = `pv-onboarding-done:${meId}`
      const done = Boolean(me?.onboarding_completed) || localStorage.getItem(seenKey) === '1'
      setActiveUser({ ...me, onboarding_completed: done })
      setAuthState('signed-in')
      if (!done) {
        setTourOpen(true)
      }
      await refresh()
    } catch (e) {
      if (!getSessionToken()) {
        resetWorkspace()
        setAuthState('signed-out')
      } else {
        setError(e instanceof Error ? e.message : 'Could not connect to PromptHold.')
        setAuthState('signed-in')
        setLoading(false)
      }
    }
  }, [refresh, resetWorkspace])

  useEffect(() => {
    if (!shareId && !mcpMode) void loadSession()
  }, [loadSession, shareId, mcpMode])

  useEffect(() => {
    const onExpired = () => {
      resetWorkspace()
      setAuthState('signed-out')
    }
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired)
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired)
  }, [resetWorkspace])

  async function signOut() {
    await logout().catch(() => undefined)
    resetWorkspace()
    setAuthState('signed-out')
  }

  async function finishTour(nextAction?: 'create') {
    setTourOpen(false)
    if (activeUser) {
      localStorage.setItem(`pv-onboarding-done:${activeUser.id}`, '1')
      if (!activeUser.onboarding_completed) {
        setActiveUser({ ...activeUser, onboarding_completed: true })
        await completeOnboarding().catch(() => undefined)
      }
    }
    if (nextAction === 'create') {
      setPage('prompts')
      setCreating(true)
    }
  }

  function handleNewGroupShortcut() {
    setPage('groups')
    window.setTimeout(() => createGroupInputRef.current?.focus(), 60)
  }

  return (
    <ErrorBoundary>
      <ToastProvider>
      {shareId ? (
        <SharedDiffPage shareId={shareId} />
      ) : mcpMode ? (
        <McpInChatDrawer />
      ) : pricingPageOpen ? (
        <PricingPage
          activeUser={activeUser}
          onBackToApp={() => {
            setPricingPageOpen(false)
            if (window.history.pushState) {
              const url = new URL(window.location.href)
              url.searchParams.delete('page')
              url.searchParams.delete('pricing')
              window.history.pushState({}, '', url.pathname + (url.search ? url.search : ''))
            }
          }}
          onPlanUpdated={newPlan => {
            if (activeUser) {
              setActiveUser({ ...activeUser, plan: newPlan })
            }
          }}
          onContactSales={() => {
            window.location.href = 'mailto:sales@prompthold.com?subject=PromptHold%20Enterprise%20Inquiry'
          }}
        />
      ) : authState === 'checking' ? (
        <div className="grid min-h-screen place-items-center bg-[#f6f7f9] text-sm text-slate-500 dark:bg-zinc-950 dark:text-zinc-400">
          <div className="flex flex-col items-center gap-3">
            <LogoMark size={36} className="animate-pulse" />
            <span>Loading workspace…</span>
          </div>
        </div>
      ) : authState === 'signed-out' ? (
        <>
          <LoginPage
            onAuthenticated={() => {
              setAuthState('checking')
              void loadSession()
            }}
            onOpenPricing={() => setPricingPageOpen(true)}
          />
          <FeedbackWidget activeUser={null} />
        </>
      ) : (
        <div className="min-h-screen bg-[#f6f7f9] text-slate-900 dark:bg-zinc-950 dark:text-zinc-100 lg:pl-64">
          <Navbar
            activeUser={activeUser}
            groups={groups}
            prompts={prompts}
            page={page}
            selectedSpaceId={selectedSpaceId}
            pendingReviewsCount={pendingReviewsCount}
            onNavigate={setPage}
            onSelectSpace={setSelectedSpaceId}
            onNewGroup={handleNewGroupShortcut}
            onConnect={() => setConnectOpen(true)}
            onStartTour={() => {
              setPage('prompts')
              setTourOpen(true)
            }}
            onOpenRoles={() => setRolesOpen(true)}
            onOpenPricing={() => setPricingOpen(true)}
            onOpenFeedback={() => setFeedbackOpen(true)}
            onLogout={() => void signOut()}
          />

          {error && (
            <div role="alert" className="mx-auto mt-5 max-w-6xl px-5 sm:px-8">
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/60 dark:text-rose-300">
                {error}
                <button onClick={() => void refresh()} className="ml-3 font-semibold underline">
                  Retry
                </button>
              </div>
            </div>
          )}

          {page === 'prompts' ? (
            <PromptDashboard
              prompts={prompts}
              groups={groups}
              activeUser={activeUser}
              selectedSpaceId={selectedSpaceId}
              onSelectSpace={setSelectedSpaceId}
              loading={loading}
              onSelect={setSelectedPrompt}
              onCreate={() => setCreating(true)}
              onUpload={() => setUploading(true)}
              onDuplicate={setDuplicatePromptTarget}
              onNavigate={setPage}
            />
          ) : page === 'groups' && activeUser ? (
            <AccessGroupManager
              groups={groups}
              users={users}
              activeUser={activeUser}
              onChanged={() => void refresh()}
              onOpenRoles={() => setRolesOpen(true)}
              createInputRef={createGroupInputRef}
            />
          ) : page === 'reviews' ? (
            <ReviewRequestsDashboard
              groups={groups}
              prompts={prompts}
              activeUser={activeUser}
              onSelectPrompt={setSelectedPrompt}
              onRefreshWorkspace={() => void refresh()}
            />
          ) : null}

          {uploading && (
            <FileUploadModal
              groups={groups}
              prompts={prompts}
              activeUser={activeUser}
              onClose={() => setUploading(false)}
              onComplete={() => {
                setUploading(false)
                void refresh()
              }}
            />
          )}

          {creating && (
            <NewPromptModal
              groups={groups}
              defaultGroupId={selectedSpaceId}
              onClose={() => setCreating(false)}
              onSaved={newGroupId => {
                setCreating(false)
                if (newGroupId) {
                  setSelectedSpaceId(newGroupId)
                }
                void refresh()
              }}
            />
          )}

          {duplicatePromptTarget && (
            <DuplicatePromptModal
              prompt={duplicatePromptTarget}
              groups={groups}
              activeUser={activeUser}
              onClose={() => setDuplicatePromptTarget(null)}
              onSuccess={res => {
                setDuplicatePromptTarget(null)
                if (res.group_id) {
                  setSelectedSpaceId(res.group_id)
                }
                void refresh()
              }}
            />
          )}

          {connectOpen && <ConnectAiModal activeUser={activeUser} groups={groups} onClose={() => setConnectOpen(false)} />}
          {rolesOpen && <RolesGuideModal onClose={() => setRolesOpen(false)} />}
          {pricingOpen && (
            <PricingModal
              activeUser={activeUser}
              onClose={() => setPricingOpen(false)}
              onPlanUpdated={newPlan => {
                if (activeUser) {
                  setActiveUser({ ...activeUser, plan: newPlan })
                }
                void refresh()
              }}
              onContactSales={() => {
                setPricingOpen(false)
                setFeedbackOpen(true)
              }}
            />
          )}

          {selectedPrompt && (
            <PromptEditorAndHistory
              prompt={prompts.find(item => item.id === selectedPrompt.id) ?? selectedPrompt}
              groups={groups}
              prompts={prompts}
              activeUser={activeUser}
              onClose={() => setSelectedPrompt(null)}
              onChanged={() => void refresh()}
            />
          )}

          {tourOpen && activeUser && <OnboardingTour user={activeUser} onFinish={next => void finishTour(next)} />}

          <FeedbackWidget
            activeUser={activeUser}
            externalOpen={feedbackOpen}
            onExternalClose={() => setFeedbackOpen(undefined)}
          />
        </div>
      )}
      </ToastProvider>
    </ErrorBoundary>
  )
}
