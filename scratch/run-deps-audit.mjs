import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'))

const dependencies = Object.keys(pkg.dependencies || {})
const devDependencies = Object.keys(pkg.devDependencies || {})
const peerDependencies = Object.keys(pkg.peerDependencies || {})

function getAllFiles(dir, exts = ['.ts', '.js', '.mjs', '.json', '.cjs']) {
  const results = []
  if (!fs.existsSync(dir)) return results
  const list = fs.readdirSync(dir, { withFileTypes: true })
  for (const item of list) {
    if (item.name === 'node_modules' || item.name === '.git' || item.name === 'dist' || item.name === 'dist-tests' || item.name === '.tmp') {
      continue
    }
    const full = path.join(dir, item.name)
    if (item.isDirectory()) {
      results.push(...getAllFiles(full, exts))
    } else if (exts.some(ext => item.name.endsWith(ext))) {
      results.push(full)
    }
  }
  return results
}

const srcFiles = getAllFiles(path.join(root, 'src'))
const testFiles = getAllFiles(path.join(root, 'tests'))
const scriptFiles = getAllFiles(path.join(root, 'scripts'))
const rootConfigFiles = [
  path.join(root, 'tsconfig.json'),
  path.join(root, 'tsconfig.test.json'),
  path.join(root, '.prettierrc'),
  path.join(root, 'package.json'),
  path.join(root, 'test-worker.mjs')
].filter(f => fs.existsSync(f))

function analyzePackage(pkgName) {
  const patterns = [
    new RegExp(`from\\s+['"]${escapeRegex(pkgName)}(?:/[^'"]*)?['"]`, 'g'),
    new RegExp(`import\\(['"]${escapeRegex(pkgName)}(?:/[^'"]*)?['"]\\)`, 'g'),
    new RegExp(`require\\(['"]${escapeRegex(pkgName)}(?:/[^'"]*)?['"]\\)`, 'g'),
    new RegExp(`['"]${escapeRegex(pkgName)}(?:/[^'"]*)?['"]`, 'g'),
  ]

  const usage = {
    pkgName,
    srcMatches: [],
    testMatches: [],
    scriptMatches: [],
    rootConfigMatches: []
  }

  function checkFiles(files, targetArray, label) {
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8')
      const relPath = path.relative(root, file).replace(/\\/g, '/')
      
      // Look for imports/requires first
      const importRegex = new RegExp(`(?:from\\s+['"]|import\\(['"]|require\\(['"])${escapeRegex(pkgName)}(?:/[^'"]*)?['"]`, 'g')
      const importHits = [...content.matchAll(importRegex)]
      if (importHits.length > 0) {
        targetArray.push({
          file: relPath,
          count: importHits.length,
          type: 'import/require'
        })
        continue
      }

      // If no direct import, look for package string mentions (e.g. dynamic resolution, plugin configs, comments)
      // but only if it's not package.json itself
      if (relPath !== 'package.json' && relPath !== 'package-lock.json') {
        const strRegex = new RegExp(`['"\`]${escapeRegex(pkgName)}(?:/[^'"\`]*)?['"\`]`, 'g')
        const strHits = [...content.matchAll(strRegex)]
        if (strHits.length > 0) {
          targetArray.push({
            file: relPath,
            count: strHits.length,
            type: 'string-reference'
          })
        }
      }
    }
  }

  checkFiles(srcFiles, usage.srcMatches, 'src')
  checkFiles(testFiles, usage.testMatches, 'tests')
  checkFiles(scriptFiles, usage.scriptMatches, 'scripts')
  checkFiles(rootConfigFiles, usage.rootConfigMatches, 'rootConfig')

  return usage
}

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

console.log('=== AUDITING DEPENDENCIES ===')
const depResults = dependencies.map(analyzePackage)
for (const res of depResults) {
  const inSrc = res.srcMatches.length
  const inTest = res.testMatches.length
  const inScript = res.scriptMatches.length
  console.log(`\nDEP: ${res.pkgName}`)
  console.log(`  Used in src: ${inSrc} files`)
  for (const m of res.srcMatches) console.log(`    - ${m.file} (${m.type})`)
  console.log(`  Used in tests: ${inTest} files`)
  for (const m of res.testMatches.slice(0, 3)) console.log(`    - ${m.file} (${m.type})`)
  if (inTest > 3) console.log(`    ... and ${inTest - 3} more test files`)
  console.log(`  Used in scripts: ${inScript} files`)
}

console.log('\n=== AUDITING DEV-DEPENDENCIES ===')
const devDepResults = devDependencies.map(analyzePackage)
for (const res of devDepResults) {
  const inSrc = res.srcMatches.length
  const inTest = res.testMatches.length
  const inScript = res.scriptMatches.length
  const inRoot = res.rootConfigMatches.length
  console.log(`\nDEV_DEP: ${res.pkgName}`)
  console.log(`  Used in src: ${inSrc} files`)
  for (const m of res.srcMatches) console.log(`    - ${m.file} (${m.type})`)
  console.log(`  Used in tests: ${inTest} files`)
  for (const m of res.testMatches.slice(0, 5)) console.log(`    - ${m.file} (${m.type})`)
  if (inTest > 5) console.log(`    ... and ${inTest - 5} more test files`)
  console.log(`  Used in scripts: ${inScript} files`)
  for (const m of res.scriptMatches) console.log(`    - ${m.file} (${m.type})`)
  console.log(`  Used in configs: ${inRoot} files`)
  for (const m of res.rootConfigMatches) console.log(`    - ${m.file} (${m.type})`)
}

fs.writeFileSync(path.join(root, 'scratch/audit-data.json'), JSON.stringify({
  dependencies: depResults,
  devDependencies: devDepResults
}, null, 2))
