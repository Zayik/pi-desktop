import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { clsx } from 'clsx'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { KeyRound, Loader2, Plug, RefreshCw, X } from 'lucide-react'
import { useAppStore } from '../store'
import { buildTerminalTheme } from './terminal'
import type { PiProviderStatus } from '../../../shared/ipc-contracts'

function statusLabel(status: PiProviderStatus['status'], t: TFunction): string {
  switch (status) {
    case 'ready':
      return t('providers.status.ready')
    case 'not_ready':
      return t('providers.status.notReady')
    case 'invalid':
      return t('providers.status.invalid')
    case 'unknown':
      return t('providers.status.unknown')
  }
}

function authTypeLabel(authType: string | undefined, t: TFunction): string | null {
  switch (authType) {
    case 'api_key':
      return t('providers.authType.apiKey')
    case 'oauth':
      return t('providers.authType.oauth')
    default:
      return null
  }
}

/**
 * Settings > Providers: what Pi can use and how each credential stands, all
 * from Pi's own answers. Signing in opens Pi's `/login` screen.
 */
export function ProvidersSection(): React.JSX.Element {
  const { t } = useTranslation()
  const providers = useAppStore((s) => s.piProviders)
  const loading = useAppStore((s) => s.piProvidersLoading)
  const refreshProviders = useAppStore((s) => s.refreshPiProviders)
  const openLogin = useAppStore((s) => s.openPiLogin)
  const piMissing = useAppStore((s) => s.piSetupFailure !== null)

  useEffect(() => {
    if (providers === null && !piMissing) void refreshProviders()
  }, [providers, piMissing, refreshProviders])

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-dim">{t('providers.description')}</p>
      {piMissing ? (
        <p className="text-xs text-warning">{t('providers.piMissing')}</p>
      ) : providers === null || (loading && providers.length === 0) ? (
        <p className="flex items-center gap-2 text-xs text-dim">
          <Loader2 size={12} className="animate-spin" />
          {t('providers.loading')}
        </p>
      ) : providers.length === 0 ? (
        <p className="text-xs text-dim">{t('providers.none')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {providers.map((p) => (
            <li key={p.provider} className="flex items-center gap-3 px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-sm text-primary">{p.provider}</span>
              {authTypeLabel(p.authType, t) && <span className="text-xs text-dim">{authTypeLabel(p.authType, t)}</span>}
              <span
                className={clsx(
                  'rounded px-1.5 py-0.5 text-[11px] font-medium',
                  p.status === 'ready' && 'bg-success/15 text-success',
                  p.status === 'invalid' && 'bg-error/15 text-error',
                  (p.status === 'not_ready' || p.status === 'unknown') && 'bg-elevated text-muted'
                )}
              >
                {statusLabel(p.status, t)}
              </span>
              <button
                type="button"
                onClick={() => openLogin(p.provider)}
                className="rounded-md border border-border-strong px-2 py-0.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-primary"
              >
                {p.status === 'ready' ? t('providers.change') : t('providers.signIn')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => openLogin(null)}
          disabled={piMissing}
          className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          <Plug size={14} />
          {t('providers.connect')}
        </button>
        <button
          type="button"
          onClick={() => void refreshProviders()}
          disabled={piMissing || loading}
          title={t('providers.refresh')}
          aria-label={t('providers.refresh')}
          className="rounded-md border border-border-strong px-3 py-1.5 text-sm text-muted transition-colors hover:bg-surface-hover disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : undefined} />
        </button>
      </div>
    </div>
  )
}

/** The strip shown when Pi runs but no provider is signed in. */
export function NoProviderNotice(): React.JSX.Element {
  const { t } = useTranslation()
  const openLogin = useAppStore((s) => s.openPiLogin)
  return (
    <div role="status" className="flex shrink-0 items-center justify-center gap-2 bg-warning/15 px-4 py-1.5 text-xs text-warning">
      <KeyRound size={14} className="shrink-0" />
      <span>{t('providers.notice.none')}</span>
      <button
        type="button"
        onClick={() => openLogin(null)}
        className="shrink-0 rounded bg-warning/25 px-2 py-0.5 font-medium transition-colors hover:bg-warning/40"
      >
        {t('providers.notice.connect')}
      </button>
    </div>
  )
}

/**
 * Pi's own `/login` in a terminal. Everything inside is Pi: its provider
 * list, its OAuth, device-code and API-key steps. Closing the dialog ends it
 * and reads the provider states again.
 */
export function PiLoginDialog({ provider }: { provider: string | null }): React.JSX.Element {
  const { t } = useTranslation()
  const closeLogin = useAppStore((s) => s.closePiLogin)
  const containerRef = useRef<HTMLDivElement>(null)
  const [exited, setExited] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = useCallback((): void => {
    void window.piDesktop.pi.loginStop().catch(() => undefined)
    closeLogin()
  }, [closeLogin])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const terminal = new XTerm({
      cursorBlink: true,
      fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      fontSize: 13,
      theme: buildTerminalTheme(),
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.loadAddon(new WebLinksAddon())
    terminal.open(container)
    fit.fit()
    terminal.focus()

    const input = terminal.onData((data) => void window.piDesktop.pi.loginInput(data).catch(() => undefined))
    const offData = window.piDesktop.pi.onLoginData((data) => terminal.write(data))
    const offExit = window.piDesktop.pi.onLoginExit(() => setExited(true))
    const observer = new ResizeObserver(() => {
      if (!container.clientWidth || !container.clientHeight) return
      fit.fit()
      void window.piDesktop.pi.loginResize({ cols: terminal.cols, rows: terminal.rows }).catch(() => undefined)
    })
    observer.observe(container)

    window.piDesktop.pi
      .loginStart(provider, { cols: terminal.cols, rows: terminal.rows })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))

    return () => {
      observer.disconnect()
      input.dispose()
      offData()
      offExit()
      void window.piDesktop.pi.loginStop().catch(() => undefined)
      terminal.dispose()
    }
  }, [provider])

  // Pi quitting (Ctrl+C twice, /quit) is the user being done.
  useEffect(() => {
    if (exited) close()
  }, [exited, close])

  return (
    <div className="absolute inset-0 z-[60] flex items-center justify-center bg-black/40 p-6" role="dialog" aria-modal="true" aria-labelledby="pi-login-title">
      <div className="flex h-[min(640px,90vh)] w-[min(920px,95vw)] flex-col overflow-hidden rounded-lg border border-border-strong bg-app shadow-xl">
        <div className="flex items-start gap-3 border-b border-border px-4 py-3">
          <KeyRound size={18} className="mt-0.5 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <h2 id="pi-login-title" className="text-sm font-semibold text-primary">
              {provider ? t('providers.login.titleProvider', { provider }) : t('providers.login.title')}
            </h2>
            <p className="mt-0.5 text-xs text-dim">{t('providers.login.hint')}</p>
          </div>
          <button
            type="button"
            onClick={close}
            className="flex items-center gap-1 rounded-md border border-border-strong px-2.5 py-1 text-xs text-primary transition-colors hover:bg-surface-hover"
          >
            <X size={12} />
            {t('providers.login.done')}
          </button>
        </div>
        {error && <p className="bg-error/10 px-4 py-2 text-xs text-error">{error}</p>}
        <div ref={containerRef} className="min-h-0 flex-1 bg-app px-2 py-1" />
      </div>
    </div>
  )
}
