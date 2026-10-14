import fs from 'node:fs'
import path from 'node:path'
import { builtinModules } from 'node:module'

const root = process.cwd()
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'))

const allDeclared = new Set([
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.devDependencies || {}),
  ...Object.keys(pkg.peerDependencies || {}),
])

const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map(m => `node:${m}`)
])

function getAllFiles(dir, exts = ['.ts', '.js', '.mjs']) {
  const results = []
  if (!fs.existsSync(dir)) return results
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'dist-tests', '.tmp'].includes(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) results.push(...getAllFiles(full, exts))
    else if (exts.some(e => entry.name.endsWith(e))) results.push(full)
  }
  return results
}

function extractImports(filePath) {
  const code = fs.readFileSync(filePath, 'utf-8')
  const importLines = []

  // match static import: import ... from 'xxx'
  const importFrom = /import\s+(?:[\w*\s{},$]+from\s+)?['"]([^'"]+)['"]/g
  // match export ... from 'xxx'
  const exportFrom = /export\s+(?:[\w*\s{},$]+from\s+)?['"]([^'"]+)['"]/g
  // match dynamic import: import('xxx')
  const dynamicImport = /import\(['"]([^'"]+)['"]\)/g
  // match require: require('xxx')
  const requireCall = /require\(['"]([^'"]+)['"]\)/g

  let m
  while ((m = importFrom.exec(code))) importLines.push(m[1])
  while ((m = exportFrom.exec(code))) importLines.push(m[1])
  while ((m = dynamicImport.exec(code))) importLines.push(m[1])
  while ((m = requireCall.exec(code))) importLines.push(m[1])

  return importLines
}

function resolvePackageName(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null // relative
  if (nodeBuiltins.has(specifier) || specifier.startsWith('node:')) return null // node builtin
  // handle scoped package @org/pkg or plain pkg
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) {
    return `${parts[0]}/${parts[1]}`
  }
  return parts[0]
}

const srcImports = new Map()
const testImports = new Map()
const scriptImports = new Map()

function scanDirectory(dir, targetMap) {
  const files = getAllFiles(path.join(root, dir))
  for (const f of files) {
    const rel = path.relative(root, f).replace(/\\/g, '/')
    const specs = extractImports(f)
    for (const s of specs) {
      const pkgName = resolvePackageName(s)
      if (!pkgName) continue
      if (!targetMap.has(pkgName)) targetMap.set(pkgName, new Set())
      targetMap.get(pkgName).add(rel)
    }
  }
}

scanDirectory('src', srcImports)
scanDirectory('tests', testImports)
scanDirectory('scripts', scriptImports)

console.log('=== IMPORTS FOUND IN SRC/ (PRODUCTION CODE) ===')
for (const [pkgName, files] of srcImports.entries()) {
  const isDep = Boolean(pkg.dependencies?.[pkgName])
  const isDevDep = Boolean(pkg.devDependencies?.[pkgName])
  const isPeer = Boolean(pkg.peerDependencies?.[pkgName])
  console.log(`- ${pkgName}: ${isDep ? 'DEP' : isDevDep ? 'DEV_DEP (WARN!)' : isPeer ? 'PEER_DEP' : 'UNDECLARED (CRITICAL!)'} (used in ${files.size} files)`)
}

console.log('\n=== IMPORTS FOUND IN TESTS/ ===')
for (const [pkgName, files] of testImports.entries()) {
  const isDep = Boolean(pkg.dependencies?.[pkgName])
  const isDevDep = Boolean(pkg.devDependencies?.[pkgName])
  const isPeer = Boolean(pkg.peerDependencies?.[pkgName])
  console.log(`- ${pkgName}: ${isDep ? 'DEP' : isDevDep ? 'DEV_DEP' : isPeer ? 'PEER_DEP' : 'UNDECLARED'} (used in ${files.size} files)`)
}

console.log('\n=== DECLARED DEPENDENCIES NOT IMPORTED DIRECTLY IN SRC/ ===')
for (const dep of Object.keys(pkg.dependencies || {})) {
  if (!srcImports.has(dep)) {
    console.log(`- ${dep}: NOT imported in src/!`)
  }
}

console.log('\n=== DECLARED DEV_DEPENDENCIES NOT IMPORTED IN TESTS/ OR SRC/ ===')
for (const devDep of Object.keys(pkg.devDependencies || {})) {
  if (!testImports.has(devDep) && !srcImports.has(devDep)) {
    console.log(`- ${devDep}: NOT imported in tests/ or src/`)
  }
}
