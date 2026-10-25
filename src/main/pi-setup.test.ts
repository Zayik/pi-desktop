import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import type { ResolutionDeps } from './pi-binary-resolution'
import { PI_NPM_INSTALL_COMMAND } from './pi-binary-resolution'
import {
  PI_WINGET_INSTALL_COMMAND,
  isPiInstallMethod,
  outputTail,
  piInstallOptions,
  summarizeSearchSteps,
} from './pi-setup'

function deps(isWindows: boolean, files: string[]): ResolutionDeps {
  const set = new Set(files)
  return {
    isWindows,
    env: isWindows ? { PATHEXT: '.EXE;.CMD' } : {},
    exists: (p) => set.has(p),
    isDirectory: () => false,
    listDir: () => [],
    capture: () => null,
  }
}

test('Windows offers the pi.dev installer first, then npm and winget when present', () => {
  const options = piInstallOptions(
    // whichInPath joins with the host separator, so the fixture does too.
    deps(true, [join('C:\\PS', 'powershell.exe'), join('C:\\Tools', 'winget.exe')]),
    'C:\\PS;C:\\Tools'
  )
  assert.deepEqual(
    options.map((o) => [o.method, o.available]),
    [['installer', true], ['npm', false], ['winget', true]]
  )
  assert.match(options[0].command, /irm https:\/\/pi\.dev\/install\.ps1 \| iex/)
  assert.equal(options[2].command, PI_WINGET_INSTALL_COMMAND)
})

test('macOS and Linux offer the curl installer and npm', () => {
  const options = piInstallOptions(deps(false, ['/usr/bin/curl', '/usr/local/bin/npm']), '/usr/bin:/usr/local/bin')
  assert.deepEqual(
    options.map((o) => [o.method, o.available, o.command]),
    [
      ['installer', true, 'curl -fsSL https://pi.dev/install.sh | sh'],
      ['npm', true, PI_NPM_INSTALL_COMMAND],
    ]
  )
})

test('only the fixed install methods are accepted from the renderer', () => {
  assert.equal(isPiInstallMethod('npm'), true)
  assert.equal(isPiInstallMethod('rm -rf /'), false)
  assert.equal(isPiInstallMethod(undefined), false)
})

test('the PATH step is shown as folders, other steps as files', () => {
  const steps = summarizeSearchSteps(
    [
      { id: 'common-location', checked: [{ path: 'C:\\npm\\pi.cmd', found: true }] },
      { id: 'path', checked: [
        { path: 'C:\\Tools\\pi.EXE', found: false },
        { path: 'C:\\Tools\\pi.CMD', found: false },
        { path: 'C:\\Bin\\pi.CMD', found: true },
      ] },
    ],
    true,
    'C:\\Bin\\pi.CMD'
  )
  // The earlier step's file existed but was not the one used.
  assert.deepEqual(steps[0], { id: 'common-location', matched: false, checked: [{ path: 'C:\\npm\\pi.cmd', found: false }] })
  assert.equal(steps[1].matched, true)
  assert.deepEqual(steps[1].checked, [
    { path: 'C:\\Tools', found: false },
    { path: 'C:\\Bin', found: true },
  ])
})

test('nothing is marked found when the search failed', () => {
  const steps = summarizeSearchSteps([{ id: 'omp', checked: [{ path: '/usr/bin/omp', found: true }] }], false, null)
  assert.deepEqual(steps, [{ id: 'omp', matched: false, checked: [{ path: '/usr/bin/omp', found: false }] }])
})

test('outputTail keeps the end of long output from a line start', () => {
  const text = 'a'.repeat(50) + '\nline two\nline three'
  assert.equal(outputTail(text, 20), 'line two\nline three')
  assert.equal(outputTail('short', 20), 'short')
})
