import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { clsx } from 'clsx'
import {
  AlertTriangle,
  Check,
  ChevronRight,
  CircleCheck,
  Download,
  FolderOpen,
  Loader2,
  RefreshCw,
  Settings as SettingsIcon,
  X,
} from 'lucide-react'
import { useAppStore } from '../store'
import { CopyButton } from './copy-button'
import type {
  PiInstallMethod,
  PiInstallOption,
  PiInstallResult,
  PiSearchStep,
  PiSearchStepId,
  PiSetupReport,
} from '../../../shared/ipc-contracts'

/** How much install output the screen keeps. */
const OUTPUT_MAX_CHARS = 8_000

function platformName(platform: string, t: TFunction): string {
  switch (platform) {
    case 'win32':
      return t('piSetup.platform.windows')
    case 'darwin':
      return t('piSetup.platform.mac')
    default:
      return t('piSetup.platform.linux')
  }
}

function stepTitle(id: PiSearchStepId, t: TFunction): string {
  switch (id) {
    case 'settings':
      return t('piSetup.steps.settings')
    case 'env':
      return t('piSetup.steps.env')
    case 'npm-prefix':
      return t('piSetup.steps.npmPrefix')
    case 'path':
      return t('piSetup.steps.path')
    case 'managed-install':
      return t('piSetup.steps.managedInstall')
    case 'version-manager':
      return t('piSetup.steps.versionManager')
    case 'common-location':
      return t('piSetup.steps.commonLocation')
    case 'omp':
      return t('piSetup.steps.omp')
  }
}

/** One line under a step's title, for steps whose list alone is unclear. */
function stepNote(step: PiSearchStep, t: TFunction): string | null {
  switch (step.id) {
    case 'settings':
      return step.checked.length === 0 ? t('piSetup.notes.settingsUnset') : null
    case 'env':
      return step.checked.length === 0 ? t('piSetup.notes.envUnset') : null
    case 'npm-prefix':
      return step.npmPrefix ? t('piSetup.notes.npmPrefix', { prefix: step.npmPrefix }) : t('piSetup.notes.npmMissing')
    case 'managed-install':
      return t('piSetup.notes.managedInstall')
    case 'version-manager':
      return t('piSetup.notes.versionManager')
    default:
      return null
  }
}

function installTitle(method: PiInstallMethod, t: TFunction): string {
  switch (method) {
    case 'installer':
      return t('piSetup.install.installer')
    case 'npm':
      return t('piSetup.install.npm')
    case 'winget':
      return t('piSetup.install.winget')
  }
}

function installUnavailable(method: PiInstallMethod, t: TFunction): string {
  switch (method) {
    case 'installer':
      return t('piSetup.install.installerUnavailable')
    case 'npm':
      return t('piSetup.install.npmUnavailable')
    case 'winget':
      return t('piSetup.install.wingetUnavailable')
  }
}

function SearchStep({ step }: { step: PiSearchStep }): React.JSX.Element {
  const { t } = useTranslation()
  const note = stepNote(step, t)
  return (
    <details className="group rounded-md border border-border bg-surface">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm text-primary">
        <ChevronRight size={14} className="shrink-0 text-dim transition-transform group-open:rotate-90" />
        <span className="flex-1">{stepTitle(step.id, t)}</span>
        <span className={clsx('text-xs', step.matched ? 'text-success' : 'text-dim')}>
          {step.matched
            ? t('piSetup.found')
            : step.checked.length === 0
              ? t('piSetup.notSet')
              : t('piSetup.checkedCount', { count: step.checked.length })}
        </span>
      </summary>
      <div className="border-t border-border px-3 py-2">
        {note && <p className="mb-1.5 text-xs text-dim">{note}</p>}
        <ul className="space-y-1">
          {step.checked.map((check) => (
            <li key={check.path} className="flex items-start gap-2 font-mono text-xs">
              {check.found ? (
                <Check size={12} className="mt-0.5 shrink-0 text-success" />
              ) : (
                <X size={12} className="mt-0.5 shrink-0 text-dim" />
              )}
              <span className={clsx('break-all', check.found ? 'text-primary' : 'text-muted')}>{check.path}</span>
            </li>
          ))}
        </ul>
      </div>
    </details>
  )
}

function InstallRow({
  option,
  recommended,
  busy,
  onInstall,
}: {
  option: PiInstallOption
  recommended: boolean
  busy: boolean
  onInstall: (method: PiInstallMethod) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-primary">{installTitle(option.method, t)}</span>
        {recommended && (
          <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
            {t('piSetup.install.recommended')}
          </span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => onInstall(option.method)}
          disabled={busy || !option.available}
          className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-40"
        >
          <Download size={12} />
          {t('piSetup.install.button')}
        </button>
      </div>
      <div className="mt-1.5 flex items-center gap-1 rounded bg-app px-2 py-1">
        <code className="flex-1 break-all font-mono text-xs text-muted">{option.command}</code>
        <CopyButton text={option.command} />
      </div>
      {!option.available && <p className="mt-1 text-xs text-dim">{installUnavailable(option.method, t)}</p>}
    </div>
  )
}

/**
 * The warning that stays visible while Pi cannot start: a strip across the
 * top of the window, or a box inside Settings. Either one reopens the setup
 * page.
 */
export function PiMissingNotice({
  failure,
  variant,
}: {
  failure: 'pi-not-found' | 'node-not-found'
  variant: 'banner' | 'inline'
}): React.JSX.Element {
  const { t } = useTranslation()
  const setPiSetupOpen = useAppStore((s) => s.setPiSetupOpen)
  return (
    <div
      role="alert"
      className={clsx(
        'flex items-center gap-2 bg-warning/15 text-xs text-warning',
        variant === 'banner' ? 'shrink-0 justify-center px-4 py-1.5' : 'rounded-md px-3 py-2'
      )}
    >
      <AlertTriangle size={14} className="shrink-0" />
      <span className={variant === 'inline' ? 'flex-1' : undefined}>
        {failure === 'node-not-found' ? t('piSetup.notice.noNode') : t('piSetup.notice.notFound')}
      </span>
      <button
        type="button"
        onClick={() => setPiSetupOpen(true)}
        className="shrink-0 rounded bg-warning/25 px-2 py-0.5 font-medium transition-colors hover:bg-warning/40"
      >
        {t('piSetup.notice.fix')}
      </button>
    </div>
  )
}

/**
 * The page shown at launch when Pi cannot be started: why, a way to install
 * it, a way to point at an existing install, and every place that was searched.
 */
export function PiSetupScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const setPiSetupOpen = useAppStore((s) => s.setPiSetupOpen)
  const setPiSetupFailure = useAppStore((s) => s.setPiSetupFailure)
  const refreshPiProviders = useAppStore((s) => s.refreshPiProviders)
  const setCurrentView = useAppStore((s) => s.setCurrentView)
  const startPi = useAppStore((s) => s.startPi)
  const loadSettings = useAppStore((s) => s.loadSettings)
  const [report, setReport] = useState<PiSetupReport | null>(null)
  const [checking, setChecking] = useState(false)
  const [installing, setInstalling] = useState<PiInstallMethod | null>(null)
  const [output, setOutput] = useState('')
  const [result, setResult] = useState<PiInstallResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const outputRef = useRef<HTMLPreElement>(null)

  /** Close and start Pi once it can run; otherwise show the new report. */
  const accept = useCallback(
    (next: PiSetupReport): void => {
      setReport(next)
      if (next.failure === null) {
        setPiSetupOpen(false)
        void startPi()
        void refreshPiProviders()
      }
    },
    [setPiSetupOpen, startPi, refreshPiProviders]
  )

  const check = useCallback(async (): Promise<void> => {
    setChecking(true)
    setError(null)
    try {
      setReport(await window.piDesktop.pi.getSetupReport())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    void check()
  }, [check])

  // Keep the app-wide warning in step with what this screen last found.
  useEffect(() => {
    if (report) setPiSetupFailure(report.failure)
  }, [report, setPiSetupFailure])

  useEffect(() => window.piDesktop.pi.onInstallOutput((chunk) => {
    setOutput((prev) => (prev + chunk).slice(-OUTPUT_MAX_CHARS))
  }), [])

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight })
  }, [output])

  const tryAgain = async (): Promise<void> => {
    setChecking(true)
    setError(null)
    try {
      accept(await window.piDesktop.pi.getSetupReport())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setChecking(false)
    }
  }

  const install = async (method: PiInstallMethod): Promise<void> => {
    setInstalling(method)
    setOutput('')
    setResult(null)
    setError(null)
    try {
      const next = await window.piDesktop.pi.install(method)
      setResult(next)
      setOutput(next.output)
      if (next.ok) accept(next.report)
      else setReport(next.report)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(null)
    }
  }

  const browse = async (): Promise<void> => {
    const path = await window.piDesktop.system.openDialog({ title: t('piSetup.browseDialogTitle'), mode: 'either' })
    if (!path) return
    await window.piDesktop.settings.save({ piExecutablePath: path, piEngine: 'auto' })
    await loadSettings()
    await tryAgain()
  }

  const openSettings = (): void => {
    setPiSetupOpen(false)
    setCurrentView('settings')
  }

  const ready = report?.failure === null
  const busy = checking || installing !== null

  return (
    <div className="absolute inset-0 z-50 overflow-y-auto bg-app" role="dialog" aria-modal="true" aria-labelledby="pi-setup-title">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <div className="mb-6 flex items-start gap-3">
          {ready ? (
            <CircleCheck size={22} className="mt-0.5 shrink-0 text-success" />
          ) : (
            <AlertTriangle size={22} className="mt-0.5 shrink-0 text-warning" />
          )}
          <div className="flex-1">
            <h1 id="pi-setup-title" className="text-lg font-semibold text-primary">
              {ready
                ? t('piSetup.titleFound')
                : report?.failure === 'node-not-found'
                  ? t('piSetup.titleNoNode')
                  : t('piSetup.title')}
            </h1>
            <p className="mt-1 text-sm text-muted">
              {ready
                ? t('piSetup.introFound', { path: report.script })
                : report?.failure === 'node-not-found'
                  ? t('piSetup.introNoNode', { path: report.script })
                  : t('piSetup.intro')}
            </p>
            {report?.rejectedOverride && (
              <p className="mt-2 rounded-md bg-warning/15 px-3 py-2 text-xs text-warning">
                {t('piSetup.rejectedOverride', { path: report.rejectedOverride })}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => setPiSetupOpen(false)}
            className="rounded p-1 text-dim transition-colors hover:bg-surface-hover hover:text-primary"
            title={t('piSetup.close')}
            aria-label={t('piSetup.close')}
          >
            <X size={16} />
          </button>
        </div>

        {error && <p className="mb-4 rounded-md bg-error/10 px-3 py-2 text-xs text-error">{error}</p>}

        {!ready && report && report.failure !== 'node-not-found' && (
          <section className="mb-6">
            <h2 className="mb-2 text-sm font-semibold text-primary">{t('piSetup.install.heading')}</h2>
            <p className="mb-2 text-xs text-dim">{t('piSetup.install.hint')}</p>
            <div className="space-y-2">
              {report.installOptions.map((option, index) => (
                <InstallRow
                  key={option.method}
                  option={option}
                  recommended={index === 0}
                  busy={busy}
                  onInstall={(method) => void install(method)}
                />
              ))}
            </div>
            {(installing || output) && (
              <div className="mt-3">
                <div className="mb-1 flex items-center gap-2 text-xs">
                  {installing ? (
                    <>
                      <Loader2 size={12} className="animate-spin text-accent" />
                      <span className="text-muted">{t('piSetup.install.running')}</span>
                    </>
                  ) : result?.ok ? (
                    <span className="text-success">
                      {result.report.failure === null ? t('piSetup.install.doneFound') : t('piSetup.install.doneNotFound')}
                    </span>
                  ) : result ? (
                    <span className="text-error">{t('piSetup.install.failed', { code: result.exitCode ?? '?' })}</span>
                  ) : null}
                </div>
                <pre
                  ref={outputRef}
                  className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-surface px-3 py-2 font-mono text-[11px] text-muted"
                >
                  {output || ' '}
                </pre>
              </div>
            )}
          </section>
        )}

        <section className="mb-6">
          <h2 className="mb-2 text-sm font-semibold text-primary">{t('piSetup.existing.heading')}</h2>
          <p className="mb-2 text-xs text-dim">{t('piSetup.existing.hint', { envVar: 'PI_DESKTOP_PI_PATH' })}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void browse()}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-md border border-border-strong px-3 py-1.5 text-sm text-primary transition-colors hover:bg-surface-hover disabled:opacity-50"
            >
              <FolderOpen size={14} />
              {t('piSetup.existing.browse')}
            </button>
            <button
              type="button"
              onClick={() => void tryAgain()}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-md border border-border-strong px-3 py-1.5 text-sm text-primary transition-colors hover:bg-surface-hover disabled:opacity-50"
            >
              <RefreshCw size={14} className={checking ? 'animate-spin' : undefined} />
              {t('piSetup.existing.tryAgain')}
            </button>
            <button
              type="button"
              onClick={openSettings}
              className="flex items-center gap-1.5 rounded-md border border-border-strong px-3 py-1.5 text-sm text-muted transition-colors hover:bg-surface-hover"
            >
              <SettingsIcon size={14} />
              {t('piSetup.existing.openSettings')}
            </button>
          </div>
        </section>

        <section className="mb-6">
          <h2 className="mb-2 text-sm font-semibold text-primary">
            {report ? t('piSetup.searched.heading', { platform: platformName(report.platform, t) }) : t('piSetup.searched.loading')}
          </h2>
          <p className="mb-2 text-xs text-dim">{t('piSetup.searched.hint')}</p>
          <div className="space-y-1.5">
            {report?.steps.map((step) => <SearchStep key={step.id} step={step} />)}
          </div>
        </section>

        {!ready && (
          <button
            type="button"
            onClick={() => setPiSetupOpen(false)}
            className="text-xs text-dim underline-offset-2 hover:text-muted hover:underline"
          >
            {t('piSetup.continueWithout')}
          </button>
        )}
      </div>
    </div>
  )
}
