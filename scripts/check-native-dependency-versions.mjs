#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const exactVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new Error(`${label} is missing or unreadable: ${filePath}\n${error.message}`)
  }
}

export function inspectNativeDependencyVersion(root, dependency) {
  const packageJson = readJson(path.join(root, 'package.json'), 'package.json')
  const packageLock = readJson(path.join(root, 'package-lock.json'), 'package-lock.json')
  const installedPackage = readJson(
    path.join(root, 'node_modules', dependency, 'package.json'),
    `installed ${dependency} package.json`,
  )

  return {
    declared: packageJson.dependencies?.[dependency],
    lockDeclared: packageLock.packages?.['']?.dependencies?.[dependency],
    locked: packageLock.packages?.[`node_modules/${dependency}`]?.version,
    installed: installedPackage.version,
  }
}

export function assertNativeDependencyVersion(root, dependency) {
  const versions = inspectNativeDependencyVersion(root, dependency)
  const issues = []
  if (!exactVersionPattern.test(versions.declared || '')) {
    issues.push(`package.json must pin an exact version, found ${versions.declared || 'missing'}`)
  }
  if (versions.lockDeclared !== versions.declared) {
    issues.push(`package-lock.json declares ${versions.lockDeclared || 'missing'}, expected ${versions.declared || 'missing'}`)
  }
  if (versions.locked !== versions.declared) {
    issues.push(`package-lock.json resolves ${versions.locked || 'missing'}, expected ${versions.declared || 'missing'}`)
  }
  if (versions.installed !== versions.declared) {
    issues.push(`node_modules contains ${versions.installed || 'missing'}, expected ${versions.declared || 'missing'}`)
  }
  if (issues.length > 0) {
    throw new Error(
      `${dependency} version integrity check failed:\n${issues.join('\n')}\nRun npm ci before building.`,
    )
  }
  return versions
}

export function assertNativeDependencyVersions(root = projectRoot, dependencies = ['better-sqlite3']) {
  return dependencies.map(dependency => ({
    dependency,
    ...assertNativeDependencyVersion(root, dependency),
  }))
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    const results = assertNativeDependencyVersions(projectRoot, process.argv.slice(2).length ? process.argv.slice(2) : undefined)
    for (const result of results) {
      console.log(`[native-deps] ${result.dependency} ${result.installed} matches package.json and package-lock.json`)
    }
  } catch (error) {
    console.error(`[native-deps] ${error?.message || error}`)
    process.exit(1)
  }
}
