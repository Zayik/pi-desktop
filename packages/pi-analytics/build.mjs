// Builds the package from Pi Desktop's sources: the extension and the CLI as
// self-contained bundles, and the report page as one HTML file with its
// script, styles and font inlined. Run from the repository: `npm run build:pi-analytics`.
import { build as esbuild } from 'esbuild'
import { build as vite } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cpSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const here = dirname(fileURLToPath(import.meta.url))
const dist = resolve(here, 'dist')
rmSync(dist, { recursive: true, force: true })

await esbuild({
  entryPoints: { extension: resolve(here, 'src/extension.ts'), cli: resolve(here, 'src/cli.ts') },
  outdir: dist,
  bundle: true,
  // The commands, with the session index, load on first use.
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Pi supplies its own packages to extensions.
  external: ['@earendil-works/*'],
  // Some shared main-process modules use CommonJS globals.
  banner: {
    js: [
      "import { createRequire as __piRequire } from 'module';",
      "import { dirname as __piDirname } from 'path';",
      "import { fileURLToPath as __piFileUrl } from 'url';",
      'const require = __piRequire(import.meta.url);',
      'const __filename = __piFileUrl(import.meta.url);',
      'const __dirname = __piDirname(__filename);',
    ].join(' '),
  },
  logLevel: 'warning',
})

/** Put every emitted script and stylesheet into the page and drop the files. */
function inlineIntoHtml() {
  return {
    name: 'pi-analytics-inline',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const html = Object.values(bundle).find((item) => item.fileName.endsWith('.html'))
      if (!html) return
      let source = html.source
      for (const [name, item] of Object.entries(bundle)) {
        if (item.type === 'chunk') {
          source = source.replace(new RegExp(`<script type="module" crossorigin src="[^"]*${item.fileName}"></script>`), () =>
            `<script type="module">${item.code.replace(/<\/script/g, '<\\/script')}</script>`)
          delete bundle[name]
        } else if (item.fileName.endsWith('.css')) {
          // The app's 1 MB emoji font is left out of the page.
          const css = String(item.source).replace(/@font-face\{font-family:OpenMoji Color;[^}]*\}/g, '')
          source = source.replace(new RegExp(`<link rel="stylesheet" crossorigin href="[^"]*${item.fileName}">`), () => `<style>${css}</style>`)
          delete bundle[name]
        }
      }
      html.source = source
    },
  }
}

await vite({
  configFile: false,
  root: resolve(here, 'report'),
  base: './',
  logLevel: 'warn',
  plugins: [react(), tailwindcss(), inlineIntoHtml()],
  build: {
    outDir: dist,
    emptyOutDir: false,
    assetsInlineLimit: () => true,
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  define: { 'process.env.NODE_ENV': '"production"' },
})

const page = resolve(dist, 'index.html')
writeFileSync(resolve(dist, 'report.html'), readFileSync(page, 'utf8'))
rmSync(page)
// The retro skill ships with the app too; one copy lives in the repository.
cpSync(resolve(here, '../../resources/skills'), resolve(dist, 'skills'), { recursive: true })
// dist/ is shipped on its own in the app, without the package's own package.json.
writeFileSync(resolve(dist, 'package.json'), `${JSON.stringify({ type: 'module' })}\n`)
console.log(`pi-analytics built in ${dist}`)
