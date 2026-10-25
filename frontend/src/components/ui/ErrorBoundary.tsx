import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RefreshCw, Trash2 } from 'lucide-react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
  errorInfo: ErrorInfo | null
}

export class ErrorBoundary extends Component<Props, State> {
  public override state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
  }

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null }
  }

  public override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Unhandled UI exception in PromptHold:', error, errorInfo)
    this.setState({ errorInfo })
  }

  private handleReload = () => {
    window.location.reload()
  }

  private handleResetSession = () => {
    try {
      localStorage.removeItem('promptvault_session_token')
      sessionStorage.clear()
    } catch {
      // Ignore localStorage errors
    }
    window.location.href = '/'
  }

  public override render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-[#f6f7f9] p-6 text-slate-900 dark:bg-zinc-950 dark:text-zinc-100">
          <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-7 shadow-xl dark:border-zinc-800 dark:bg-zinc-900 sm:p-9">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-amber-50 text-amber-600 ring-1 ring-inset ring-amber-600/20 dark:bg-amber-950/50 dark:text-amber-400">
              <AlertTriangle className="h-6 w-6" />
            </div>

            <h1 className="mt-4 text-xl font-semibold tracking-tight text-slate-950 dark:text-zinc-50">
              Something went wrong loading this view
            </h1>

            <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-zinc-400">
              An unexpected display issue occurred. Your saved prompts and workspaces are completely safe on the server.
            </p>

            {this.state.error && (
              <div className="mt-4 max-h-36 overflow-auto rounded-lg border border-slate-200/90 bg-slate-50 p-3 font-mono text-xs text-rose-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-rose-400">
                {this.state.error.message}
              </div>
            )}

            <div className="mt-6 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={this.handleReload}
                className="btn-primary inline-flex items-center gap-2 px-4 py-2 text-sm"
              >
                <RefreshCw className="h-4 w-4" />
                Reload page
              </button>
              <button
                type="button"
                onClick={this.handleResetSession}
                className="btn-ghost inline-flex items-center gap-2 px-4 py-2 text-sm text-slate-600 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              >
                <Trash2 className="h-4 w-4" />
                Reset session &amp; sign in
              </button>
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

export default ErrorBoundary
