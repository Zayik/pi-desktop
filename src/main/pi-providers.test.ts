import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PiCli } from './pi-rpc-manager'
import {
  interactivePiCommand,
  isProviderId,
  loginCommand,
  parseAuthCheck,
  parseListModelsProviders,
} from './pi-providers'

const LIST_MODELS = [
  'provider        model                     context  max-out  thinking  images',
  'anthropic       claude-opus-4-8           1M       128K     yes       yes',
  'anthropic       claude-haiku-5-5          1M       128K     yes       yes',
  'github-copilot  gpt-5.4                   400K     128K     yes       yes',
  '',
].join('\n')

test('providers are read from the first column of pi --list-models, once each', () => {
  assert.deepEqual(parseListModelsProviders(LIST_MODELS), ['anthropic', 'github-copilot'])
  assert.deepEqual(parseListModelsProviders('No models available.\n'), [])
})

test('pi auth check JSON is read for every status pi reports', () => {
  assert.deepEqual(parseAuthCheck('{"status":"ready","provider":"anthropic","authType":"api_key"}\n', 'anthropic'), {
    provider: 'anthropic',
    status: 'ready',
    authType: 'api_key',
  })
  assert.deepEqual(
    parseAuthCheck('{"status":"not_ready","provider":"x","reason":"credentials_not_configured"}', 'x'),
    { provider: 'x', status: 'not_ready', reason: 'credentials_not_configured' }
  )
  assert.equal(parseAuthCheck('{"status":"invalid"}', 'x').status, 'invalid')
})

test('an older pi without auth check reads as unknown', () => {
  assert.deepEqual(parseAuthCheck('error: unknown command "auth"', 'x'), { provider: 'x', status: 'unknown' })
  assert.deepEqual(parseAuthCheck('{"status":"weird"}', 'x'), { provider: 'x', status: 'unknown' })
})

test('only plain provider ids can be typed into pi', () => {
  assert.equal(isProviderId('github-copilot'), true)
  assert.equal(isProviderId('amazon-bedrock'), true)
  assert.equal(isProviderId('anthropic\r/quit'), false)
  assert.equal(isProviderId('a b'), false)
  assert.equal(isProviderId(''), false)
  assert.equal(loginCommand(null), '/login')
  assert.equal(loginCommand('openai'), '/login openai')
})

function cli(over: Partial<PiCli>): PiCli {
  return { kind: 'pi', script: '/opt/pi/cli.js', node: '/usr/bin/node', useNode: true, needsShell: false, found: true, nodeFound: true, failureReason: null, ...over }
}

test('the interactive pi command runs cli.js with node, a .cmd shim through cmd.exe, or the binary', () => {
  assert.deepEqual(interactivePiCommand(cli({}), undefined), { file: '/usr/bin/node', args: ['/opt/pi/cli.js'] })
  assert.deepEqual(
    interactivePiCommand(cli({ useNode: false, needsShell: true, script: 'C:\\npm\\pi.cmd' }), 'C:\\Windows\\cmd.exe'),
    { file: 'C:\\Windows\\cmd.exe', args: ['/d', '/c', 'C:\\npm\\pi.cmd'] }
  )
  assert.deepEqual(interactivePiCommand(cli({ useNode: false, script: '/usr/local/bin/pi' }), undefined), {
    file: '/usr/local/bin/pi',
    args: [],
  })
})
