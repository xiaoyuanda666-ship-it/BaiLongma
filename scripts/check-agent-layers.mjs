import fs from 'node:fs'
import path from 'node:path'
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')))
const kernelPackages = new Set(['better-sqlite3', 'openai'])

export function sourceFiles(directory) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(filename)
    return /\.(?:js|mjs|cjs)$/.test(entry.name) && !/^test[-.]/.test(entry.name) ? [filename] : []
  })
}

// Static import/re-export declarations and literal dynamic imports. This checks
// source dependencies, not a security sandbox for arbitrary JavaScript execution.
export function moduleSpecifiers(source) {
  const patterns = [
    /^\s*import\s+(?:[^;'"`]+?\s+from\s*)?['"]([^'"\n]+)['"]/gm,
    /^\s*export\s+(?:\*\s*(?:as\s+\w+\s*)?|\{[^}]*\}\s*)from\s*['"]([^'"\n]+)['"]/gm,
    /\b(?:import|require)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  ]
  return [...new Set(patterns.flatMap(pattern => [...source.matchAll(pattern)].map(match => match[1])))]
}

function relativeName(root, filename) {
  return path.relative(root, filename).split(path.sep).join('/')
}

export function inspectAgentLayers(root = projectRoot) {
  const errors = []
  const graph = new Map()
  const legacyNativeAdapters = new Set()
  const readDependencies = filename => {
    if (!graph.has(filename)) graph.set(filename, moduleSpecifiers(fs.readFileSync(filename, 'utf8')))
    return graph.get(filename)
  }
  const kernelFiles = sourceFiles(path.join(root, 'src/kernel'))
  for (const filename of kernelFiles) {
    for (const dependency of readDependencies(filename)) {
      if (dependency.startsWith('.')) {
        const target = path.resolve(path.dirname(filename), dependency)
        if (!relativeName(root, target).startsWith('src/kernel/')) {
          errors.push(`Kernel cannot import another layer: ${relativeName(root, filename)} -> ${dependency}`)
        } else if (!fs.existsSync(target)) {
          errors.push(`Kernel dependency is missing: ${relativeName(root, filename)} -> ${dependency}`)
        }
      } else if (!builtins.has(dependency.replace(/^node:/, '')) && !kernelPackages.has(dependency)) {
        errors.push(`Kernel dependency is not an approved infrastructure module: ${relativeName(root, filename)} -> ${dependency}`)
      }
    }
  }
  const runtimeFiles = sourceFiles(path.join(root, 'src/runtime'))
  const privileged = new Set(['fs', 'fs/promises', 'child_process', 'net', 'tls', 'http', 'https', 'http2', 'dns', 'dgram', 'worker_threads', 'openai', 'better-sqlite3'])
  // Existing direct file access is recorded explicitly while those legacy
  // services are migrated. New runtime code must receive infrastructure ports.
  const legacyRuntimeIO = new Set(['src/runtime/delivery.js:fs', 'src/runtime/turn-trace.js:fs'])
  const remainingRuntimeIO = new Set()
  for (const filename of runtimeFiles) {
    for (const dependency of readDependencies(filename)) {
      const normalized = dependency.replace(/^node:/, '')
      if (privileged.has(normalized)) {
        const edge = `${relativeName(root, filename)}:${normalized}`
        if (legacyRuntimeIO.has(edge)) remainingRuntimeIO.add(edge)
        else errors.push(`Runtime must use infrastructure ports: ${relativeName(root, filename)} -> ${dependency}`)
      }
      if (dependency.startsWith('.') && relativeName(root, path.resolve(path.dirname(filename), dependency)).startsWith('src/kernel/')) {
        errors.push(`Runtime must receive Kernel implementations from composition: ${relativeName(root, filename)} -> ${dependency}`)
      }
    }
  }
  const visited = new Set()
  const isPresentation = name => /^(?:src\/(?:app|ui|api)\/|electron\/)/.test(name)
    || ['src/api.js', 'src/tui.js', 'src/events.js'].includes(name)
  function visit(filename, chain) {
    if (visited.has(filename)) return
    visited.add(filename)
    for (const dependency of readDependencies(filename)) {
      if (dependency === 'electron') {
        // Existing safeStorage access is an OS credential adapter, pending port migration.
        // This single edge is grandfathered; new Runtime Electron imports still fail.
        if (relativeName(root, filename) === 'src/capabilities/secret-store.js') {
          legacyNativeAdapters.add(relativeName(root, filename))
          continue
        }
        errors.push(`Runtime cannot load Electron: ${[...chain, dependency].join(' -> ')}`)
        continue
      }
      if (!dependency.startsWith('.')) continue
      const target = path.resolve(path.dirname(filename), dependency)
      const name = relativeName(root, target)
      if (isPresentation(name)) {
        errors.push(`Runtime cannot load App/legacy UI facade: ${[...chain, name].join(' -> ')}`)
      } else if (/\.(?:js|mjs|cjs)$/.test(target) && fs.existsSync(target)) {
        visit(target, [...chain, name])
      }
    }
  }
  for (const filename of runtimeFiles) visit(filename, [relativeName(root, filename)])
  return { errors, kernelModules: kernelFiles.length, runtimeModules: runtimeFiles.length, reachableModules: visited.size, legacyNativeAdapters: [...legacyNativeAdapters], legacyRuntimeIO: [...remainingRuntimeIO] }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = inspectAgentLayers()
  if (result.errors.length) {
    console.error(result.errors.join('\n'))
    process.exitCode = 1
  } else {
    console.log(`Agent boundaries passed: ${result.kernelModules} Kernel, ${result.runtimeModules} Runtime, ${result.reachableModules} reachable source modules; ${result.legacyNativeAdapters.length} legacy native adapter(s), ${result.legacyRuntimeIO.length} legacy I/O edge(s)`)
  }
}
