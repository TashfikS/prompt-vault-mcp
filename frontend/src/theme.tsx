import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Laptop, Moon, Sun } from 'lucide-react'

export type Theme = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

type ThemeContextType = {
  theme: Theme
  resolvedTheme: ResolvedTheme
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
}

const ThemeContext = createContext<ThemeContextType>({
  theme: 'light',
  resolvedTheme: 'light',
  setTheme: () => undefined,
  toggleTheme: () => undefined,
})

const STORAGE_KEY = 'pv-theme-mode'

function getInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'light'
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved
    const legacy = localStorage.getItem('pv-theme')
    if (legacy === 'dark') return 'dark'
    if (legacy === 'light') return 'light'
  } catch {
    // Ignore storage exceptions
  }
  return 'light'
}

function getSystemPreference(): ResolvedTheme {
  if (typeof window === 'undefined') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(getInitialTheme)
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => {
    const initial = getInitialTheme()
    return initial === 'system' ? getSystemPreference() : initial
  })

  const applyTheme = useCallback((activeTheme: Theme) => {
    const isDark =
      activeTheme === 'dark' || (activeTheme === 'system' && getSystemPreference() === 'dark')
    const resolved: ResolvedTheme = isDark ? 'dark' : 'light'
    setResolvedTheme(resolved)

    const root = document.documentElement
    if (isDark) {
      root.classList.add('dark')
    } else {
      root.classList.remove('dark')
    }

    // Set meta theme-color for browser tab / mobile status bar
    const metaThemeColor = document.querySelector('meta[name="theme-color"]')
    if (metaThemeColor) {
      metaThemeColor.setAttribute('content', isDark ? '#09090b' : '#0f6e5f')
    }
  }, [])

  const setTheme = useCallback(
    (next: Theme) => {
      const update = () => {
        setThemeState(next)
        try {
          localStorage.setItem(STORAGE_KEY, next)
          localStorage.setItem('pv-theme', next)
        } catch {
          // Ignore storage exceptions
        }
        applyTheme(next)
      }

      // Smooth cross-fade via View Transitions API in modern browsers
      const doc = typeof document !== 'undefined' ? (document as unknown as { startViewTransition?: (cb: () => void) => void }) : null
      const prefersReducedMotion =
        typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

      if (doc?.startViewTransition && !prefersReducedMotion) {
        doc.startViewTransition(update)
      } else {
        update()
      }
    },
    [applyTheme]
  )

  const toggleTheme = useCallback(() => {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')
  }, [resolvedTheme, setTheme])

  useEffect(() => {
    applyTheme(theme)
  }, [theme, applyTheme])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const listener = () => {
      if (theme === 'system') {
        applyTheme('system')
      }
    }
    media.addEventListener('change', listener)
    return () => media.removeEventListener('change', listener)
  }, [theme, applyTheme])

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  return useContext(ThemeContext)
}

/** Segmented Theme Switcher (Light / System / Dark) */
export function ThemeSegmentedControl({ className = '' }: { className?: string }) {
  const { theme, setTheme } = useTheme()

  return (
    <div
      role="radiogroup"
      aria-label="Color theme"
      className={`grid grid-cols-3 w-full gap-0.5 rounded-lg border border-slate-200 bg-slate-100/80 p-0.5 text-xs font-medium dark:border-zinc-800 dark:bg-zinc-900/90 ${className}`}
    >
      <button
        type="button"
        role="radio"
        aria-checked={theme === 'light'}
        onClick={() => setTheme('light')}
        className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-1 transition ${
          theme === 'light'
            ? 'bg-white font-semibold text-slate-900 shadow-xs dark:bg-zinc-800 dark:text-zinc-100'
            : 'text-slate-500 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-zinc-200'
        }`}
        title="Light theme"
      >
        <Sun size={13} className={theme === 'light' ? 'text-amber-500' : ''} aria-hidden />
        <span>Light</span>
      </button>

      <button
        type="button"
        role="radio"
        aria-checked={theme === 'system'}
        onClick={() => setTheme('system')}
        className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-1 transition ${
          theme === 'system'
            ? 'bg-white font-semibold text-slate-900 shadow-xs dark:bg-zinc-800 dark:text-zinc-100'
            : 'text-slate-500 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-zinc-200'
        }`}
        title="Follow system preference"
      >
        <Laptop size={13} aria-hidden />
        <span>System</span>
      </button>

      <button
        type="button"
        role="radio"
        aria-checked={theme === 'dark'}
        onClick={() => setTheme('dark')}
        className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-1 transition ${
          theme === 'dark'
            ? 'bg-white font-semibold text-slate-900 shadow-xs dark:bg-zinc-800 dark:text-zinc-100'
            : 'text-slate-500 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-zinc-200'
        }`}
        title="Real dark theme"
      >
        <Moon size={13} className={theme === 'dark' ? 'text-brand-400' : ''} aria-hidden />
        <span>Dark</span>
      </button>
    </div>
  )
}

/** Compact single-button theme toggle */
export function ThemeToggleButton({ className = '' }: { className?: string }) {
  const { resolvedTheme, toggleTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to real dark mode'}
      title={isDark ? 'Switch to light mode' : 'Switch to real dark mode'}
      className={`inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 shadow-xs transition hover:bg-slate-50 hover:text-slate-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 ${className}`}
    >
      {isDark ? (
        <Sun size={17} className="text-amber-400" aria-hidden />
      ) : (
        <Moon size={17} className="text-slate-600" aria-hidden />
      )}
    </button>
  )
}
