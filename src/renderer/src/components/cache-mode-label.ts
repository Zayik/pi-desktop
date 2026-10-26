import type { CacheMode } from '../../../../resources/context-snapshot'
import type { Translate } from '../../../shared/i18n'

export function cacheModeLabel(mode: CacheMode, t: Translate): string {
  switch (mode) {
    case 'focus': return t('chat.cacheMode.modes.focus.label')
    case 'keep-warm': return t('chat.cacheMode.modes.keepWarm.label')
    case 'long': return t('chat.cacheMode.modes.long.label')
  }
}
