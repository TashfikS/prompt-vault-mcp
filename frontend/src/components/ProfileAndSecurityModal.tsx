import { useState } from 'react'
import { Check, Clock, KeyRound, Lock, LogOut, Shield, ShieldCheck, User as UserIcon } from 'lucide-react'
import Modal from './ui/Modal'
import RoleBadge from './ui/RoleBadge'
import { Avatar } from './ui/Brand'
import { changePassword, logoutAllSessions, updateMarketingPreference, updateProfile } from '../api'
import type { User } from '../types'

type Props = {
  activeUser: User | null
  onClose: () => void
  onUserUpdated: (user: User) => void
  onOpenPricing?: () => void
}

export default function ProfileAndSecurityModal({ activeUser, onClose, onUserUpdated, onOpenPricing }: Props) {
  const [tab, setTab] = useState<'profile' | 'security'>('profile')

  // Profile Form State
  const [name, setName] = useState(activeUser?.name || '')
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileSuccess, setProfileSuccess] = useState('')
  const [profileError, setProfileError] = useState('')
  const [marketingSaving, setMarketingSaving] = useState(false)

  async function toggleMarketing(next: boolean) {
    if (!activeUser) return
    setMarketingSaving(true)
    setProfileError('')
    try {
      const res = await updateMarketingPreference(next)
      onUserUpdated({ ...activeUser, marketing_opt_in: res.marketing_opt_in })
    } catch (e) {
      setProfileError(e instanceof Error ? e.message : 'Could not update your email preference.')
    } finally {
      setMarketingSaving(false)
    }
  }

  // Password Form State
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordSaving, setPasswordSaving] = useState(false)
  const [passwordSuccess, setPasswordSuccess] = useState('')
  const [passwordError, setPasswordError] = useState('')

  // Logout All State
  const [revokingSessions, setRevokingSessions] = useState(false)
  const [revokedMessage, setRevokedMessage] = useState('')

  // Password Complexity Validation
  const hasMinLength = newPassword.length >= 8
  const hasLetters = /[A-Za-z]/.test(newPassword)
  const hasDigits = /\d/.test(newPassword)
  const isComplex = hasMinLength && hasLetters && hasDigits

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault()
    setProfileError('')
    setProfileSuccess('')
    if (!name.trim()) {
      setProfileError('Display name cannot be empty.')
      return
    }
    setProfileSaving(true)
    try {
      const res = await updateProfile({ name: name.trim() })
      if (activeUser) {
        onUserUpdated({ ...activeUser, name: res.name })
      }
      setProfileSuccess('Display name updated successfully.')
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : 'Failed to update profile.')
    } finally {
      setProfileSaving(false)
    }
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault()
    setPasswordError('')
    setPasswordSuccess('')

    if (!isComplex) {
      setPasswordError('New password must be at least 8 characters and include both letters and numbers.')
      return
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('New passwords do not match.')
      return
    }

    setPasswordSaving(true)
    try {
      const res = await changePassword({
        current_password: currentPassword,
        new_password: newPassword,
      })
      setPasswordSuccess(res.message || 'Password updated successfully.')
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : 'Failed to rotate password.')
    } finally {
      setPasswordSaving(false)
    }
  }

  async function handleRevokeAllSessions() {
    setRevokingSessions(true)
    try {
      await logoutAllSessions()
      setRevokedMessage('All active sessions revoked. Please sign in again.')
      setTimeout(() => {
        window.location.reload()
      }, 1500)
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : 'Failed to revoke sessions.')
      setRevokingSessions(false)
    }
  }

  return (
    <Modal
      title="Account & Security"
      description="Manage your profile information, password policies, and active sessions."
      icon={<ShieldCheck size={20} className="text-brand-600 dark:text-brand-400" />}
      size="lg"
      onClose={onClose}
    >
      {/* Segmented Tab Controls */}
      <div className="mb-5 flex rounded-xl bg-slate-100 p-1 dark:bg-zinc-800/80">
        <button
          type="button"
          onClick={() => setTab('profile')}
          className={`flex flex-1 items-center justify-center gap-2 rounded-lg py-1.5 text-xs font-semibold transition ${
            tab === 'profile'
              ? 'bg-white text-slate-900 shadow-2xs dark:bg-zinc-900 dark:text-zinc-100'
              : 'text-slate-600 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-zinc-200'
          }`}
        >
          <UserIcon size={14} /> Profile &amp; Role
        </button>
        <button
          type="button"
          onClick={() => setTab('security')}
          className={`flex flex-1 items-center justify-center gap-2 rounded-lg py-1.5 text-xs font-semibold transition ${
            tab === 'security'
              ? 'bg-white text-slate-900 shadow-2xs dark:bg-zinc-900 dark:text-zinc-100'
              : 'text-slate-600 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-zinc-200'
          }`}
        >
          <Lock size={14} /> Password &amp; Sessions
        </button>
      </div>

      {tab === 'profile' ? (
        <form onSubmit={handleSaveProfile} className="space-y-4">
          <div className="flex items-center gap-3 rounded-xl border border-slate-200/80 bg-slate-50/60 p-3.5 dark:border-zinc-800 dark:bg-zinc-900/40">
            <Avatar name={activeUser?.name || 'User'} size="lg" />
            <div className="min-w-0 flex-1 leading-tight">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-bold text-slate-900 dark:text-zinc-100">
                  {activeUser?.name}
                </span>
                {activeUser?.is_workspace_admin ? (
                  <RoleBadge kind="ADMIN" side="right" />
                ) : (
                  <span className="rounded-full bg-slate-200/70 px-2 py-0.5 text-[10px] font-semibold text-slate-700 dark:bg-zinc-800 dark:text-zinc-300">
                    Standard Member
                  </span>
                )}
              </div>
              <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-zinc-400">
                {activeUser?.email}
              </p>
            </div>
          </div>

          <div>
            <label className="field-label" htmlFor="profile-name">
              Full Display Name
            </label>
            <input
              id="profile-name"
              required
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Your name"
              className="field"
            />
          </div>

          <div>
            <label className="field-label">Account Email</label>
            <input
              disabled
              value={activeUser?.email || ''}
              className="field cursor-not-allowed bg-slate-100 text-slate-500 dark:bg-zinc-800/60 dark:text-zinc-400"
            />
            <p className="mt-1 text-[11px] text-slate-400 dark:text-zinc-500">
              Email address is linked to your workspace identity and cannot be edited directly.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 pt-1">
            <div className="rounded-xl border border-slate-200/70 bg-white p-3 dark:border-zinc-800/80 dark:bg-zinc-900/60">
              <span className="block text-[11px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-wider">
                Current Plan
              </span>
              <div className="mt-1 flex items-center justify-between">
                <span className="text-sm font-bold capitalize text-slate-900 dark:text-zinc-100">
                  {activeUser?.plan || 'Community'}
                </span>
                {onOpenPricing && (
                  <button
                    type="button"
                    onClick={() => {
                      onClose()
                      onOpenPricing()
                    }}
                    className="text-[11px] font-semibold text-brand-600 hover:underline dark:text-brand-400"
                  >
                    Change
                  </button>
                )}
              </div>
            </div>

            <div className="rounded-xl border border-slate-200/70 bg-white p-3 dark:border-zinc-800/80 dark:bg-zinc-900/60">
              <span className="block text-[11px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-wider">
                Last Activity
              </span>
              <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-700 dark:text-zinc-300">
                <Clock size={13} className="text-slate-400 dark:text-zinc-500 shrink-0" />
                <span className="truncate">
                  {activeUser?.last_login_at
                    ? new Date(activeUser.last_login_at).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : 'Active now'}
                </span>
              </div>
            </div>
          </div>

          {profileSuccess && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-950/50 dark:text-emerald-300 flex items-center gap-2">
              <Check size={14} /> {profileSuccess}
            </div>
          )}

          <label className="flex items-start gap-2.5 rounded-lg border border-slate-200 p-3 text-xs text-slate-600 dark:border-zinc-800 dark:text-zinc-400 cursor-pointer">
            <input
              type="checkbox"
              checked={Boolean(activeUser?.marketing_opt_in)}
              disabled={marketingSaving}
              onChange={e => void toggleMarketing(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-brand-600"
            />
            <span>
              <span className="block font-semibold text-slate-800 dark:text-zinc-200">Product updates by email</span>
              Occasional news and tips. Account and security emails are always sent.
            </span>
          </label>

          {profileError && (
            <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/60 dark:text-rose-300">
              {profileError}
            </p>
          )}

          <div className="flex justify-end pt-2">
            <button
              type="submit"
              disabled={profileSaving || name.trim() === activeUser?.name}
              className="btn-primary"
            >
              {profileSaving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </form>
      ) : (
        <div className="space-y-6">
          <form onSubmit={handleChangePassword} className="space-y-3.5">
            <div>
              <label className="field-label" htmlFor="current-pw">
                Current Password
              </label>
              <input
                id="current-pw"
                required
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={e => setCurrentPassword(e.target.value)}
                placeholder="••••••••"
                className="field"
              />
            </div>

            <div>
              <label className="field-label" htmlFor="new-pw">
                New Password
              </label>
              <input
                id="new-pw"
                required
                type="password"
                minLength={8}
                autoComplete="new-password"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                placeholder="At least 8 characters with letters & numbers"
                className="field"
              />

              {/* Live Password Rules Indicator */}
              <div className="mt-2 space-y-1 rounded-lg bg-slate-50 p-2 text-[11px] dark:bg-zinc-900/60">
                <div className="flex items-center gap-1.5">
                  <span className={`grid h-3.5 w-3.5 place-items-center rounded-full text-[9px] ${hasMinLength ? 'bg-emerald-600 text-white' : 'bg-slate-300 text-slate-700 dark:bg-zinc-700 dark:text-zinc-300'}`}>
                    {hasMinLength ? '✓' : '•'}
                  </span>
                  <span className={hasMinLength ? 'text-emerald-700 dark:text-emerald-400 font-medium' : 'text-slate-500 dark:text-zinc-400'}>
                    At least 8 characters
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className={`grid h-3.5 w-3.5 place-items-center rounded-full text-[9px] ${hasLetters ? 'bg-emerald-600 text-white' : 'bg-slate-300 text-slate-700 dark:bg-zinc-700 dark:text-zinc-300'}`}>
                    {hasLetters ? '✓' : '•'}
                  </span>
                  <span className={hasLetters ? 'text-emerald-700 dark:text-emerald-400 font-medium' : 'text-slate-500 dark:text-zinc-400'}>
                    Contains letters (A-Z, a-z)
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className={`grid h-3.5 w-3.5 place-items-center rounded-full text-[9px] ${hasDigits ? 'bg-emerald-600 text-white' : 'bg-slate-300 text-slate-700 dark:bg-zinc-700 dark:text-zinc-300'}`}>
                    {hasDigits ? '✓' : '•'}
                  </span>
                  <span className={hasDigits ? 'text-emerald-700 dark:text-emerald-400 font-medium' : 'text-slate-500 dark:text-zinc-400'}>
                    Contains numbers (0-9)
                  </span>
                </div>
              </div>
            </div>

            <div>
              <label className="field-label" htmlFor="confirm-pw">
                Repeat New Password
              </label>
              <input
                id="confirm-pw"
                required
                type="password"
                minLength={8}
                autoComplete="new-password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                placeholder="Repeat new password"
                className="field"
              />
            </div>

            {passwordSuccess && (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-950/50 dark:text-emerald-300 flex items-center gap-2">
                <Check size={14} /> {passwordSuccess}
              </div>
            )}

            {passwordError && (
              <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/60 dark:text-rose-300">
                {passwordError}
              </p>
            )}

            <div className="flex justify-end pt-1">
              <button
                type="submit"
                disabled={passwordSaving || !isComplex || !currentPassword}
                className="btn-primary"
              >
                <KeyRound size={14} />
                {passwordSaving ? 'Updating…' : 'Update Password'}
              </button>
            </div>
          </form>

          {/* Session Revocation Section */}
          <div className="border-t border-slate-200 pt-4 dark:border-zinc-800">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h4 className="text-xs font-bold text-slate-900 dark:text-zinc-100 flex items-center gap-1.5">
                  <Shield size={14} className="text-slate-500 dark:text-zinc-400" />
                  Active Sessions &amp; Devices
                </h4>
                <p className="mt-0.5 text-[11px] text-slate-500 dark:text-zinc-400">
                  Lost a device or suspect unauthorized access? Sign out all other sessions immediately.
                </p>
              </div>
              <button
                type="button"
                disabled={revokingSessions}
                onClick={handleRevokeAllSessions}
                className="shrink-0 rounded-lg border border-rose-200 bg-white px-2.5 py-1 text-xs font-semibold text-rose-700 transition hover:bg-rose-50 hover:border-rose-300 dark:border-rose-900/40 dark:bg-zinc-900 dark:text-rose-400 dark:hover:bg-rose-950/40 cursor-pointer flex items-center gap-1.5"
              >
                <LogOut size={13} />
                {revokingSessions ? 'Revoking…' : 'Sign Out All Devices'}
              </button>
            </div>
            {revokedMessage && (
              <p className="mt-2 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                {revokedMessage}
              </p>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}
