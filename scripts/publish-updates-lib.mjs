import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline/promises'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'

const BUCKET = 'bailongma-updates-hk-prod'
const UPDATE_ORIGIN = 'https://updates.bailongma.ai'
const UPDATER_HEADER = 'BailongmaUpdater/2'
const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']

export function parseNumericVersion(value) {
  const match = String(value).trim().match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!match) throw new Error(`Release version must be numeric x.y.z, got: ${value}`)
  return match.slice(1).map(Number)
}

export function compareVersions(left, right) {
  const a = parseNumericVersion(left)
  const b = parseNumericVersion(right)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  }
  return 0
}

function parseArgs(argv, supportedArchs) {
  const options = {
    archs: [],
    dryRun: false,
    skipSmoke: false,
    yes: false,
    host: process.env.BAILONGMA_UPDATE_SSH_HOST || 'xiaobailong-update-hk',
  }

  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--skip-smoke') options.skipSmoke = true
    else if (arg === '--yes') options.yes = true
    else if (arg.startsWith('--arch=')) options.archs.push(arg.slice('--arch='.length))
    else if (arg.startsWith('--host=')) options.host = arg.slice('--host='.length)
    else if (arg === '--replace') {
      throw new Error('--replace is no longer supported because versioned files are immutable; publish a new version instead')
    } else throw new Error(`Unknown argument: ${arg}`)
  }

  options.archs = options.archs.length > 0 ? [...new Set(options.archs)] : [...supportedArchs]
  const invalidArchs = options.archs.filter(arch => !supportedArchs.includes(arch))
  if (invalidArchs.length > 0) throw new Error(`Unsupported architecture: ${invalidArchs.join(', ')}`)
  if (!/^(?!-)[A-Za-z0-9._@-]+$/.test(options.host)) throw new Error(`Unsafe SSH host: ${options.host}`)
  if (options.skipSmoke && !options.dryRun) {
    throw new Error('--skip-smoke is only allowed together with --dry-run')
  }
  return options
}

function run(command, args, options = {}) {
  const hasInput = options.input != null
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: options.capture
      ? [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe']
      : (hasInput ? ['pipe', 'inherit', 'inherit'] : 'inherit'),
    input: options.input,
    windowsHide: true,
  })
  if (result.error) throw new Error(`${command} failed: ${result.error.message}`)
  if (result.status !== 0) {
    const detail = `${result.stderr || ''}\n${result.stdout || ''}`.trim()
    throw new Error(`${command} exited with ${result.status}${detail ? `\n${detail}` : ''}`)
  }
  return String(result.stdout || '').trim()
}

function requireFile(filePath) {
  const stat = fs.statSync(filePath, { throwIfNoEntry: false })
  if (!stat?.isFile() || stat.size === 0) throw new Error(`Missing or empty release artifact: ${filePath}`)
  return stat
}

export function hashFile(filePath) {
  const hash = crypto.createHash('sha512')
  const fd = fs.openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024)
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    fs.closeSync(fd)
  }
  const digest = hash.digest()
  return { base64: digest.toString('base64'), hex: digest.toString('hex') }
}

function readExactly(fd, buffer, position) {
  let offset = 0
  while (offset < buffer.length) {
    const bytesRead = fs.readSync(fd, buffer, offset, buffer.length - offset, position + offset)
    if (bytesRead === 0) throw new Error('Unexpected end of file while reading release artifact')
    offset += bytesRead
  }
}

export function inspectEmbeddedBlockmap(filePath, size) {
  if (size < 8) throw new Error(`AppImage is too small to contain an embedded blockmap: ${filePath}`)
  const fd = fs.openSync(filePath, 'r')
  try {
    const sizeBuffer = Buffer.allocUnsafe(4)
    readExactly(fd, sizeBuffer, size - 4)
    const blockMapSize = sizeBuffer.readUInt32BE(0)
    if (blockMapSize <= 0 || blockMapSize > size - 4) {
      throw new Error(`Invalid embedded AppImage blockmap size ${blockMapSize}: ${filePath}`)
    }
    const compressed = Buffer.allocUnsafe(blockMapSize)
    readExactly(fd, compressed, size - 4 - blockMapSize)
    const blockmap = JSON.parse(zlib.inflateRawSync(compressed).toString('utf8'))
    if (blockmap?.version !== '2' || !Array.isArray(blockmap.files) || blockmap.files.length === 0) {
      throw new Error(`Invalid embedded AppImage blockmap payload: ${filePath}`)
    }
    return blockMapSize
  } finally {
    fs.closeSync(fd)
  }
}

export function inspectExternalBlockmap(filePath) {
  const compressed = fs.readFileSync(filePath)
  let blockmap
  try {
    blockmap = JSON.parse(zlib.gunzipSync(compressed).toString('utf8'))
  } catch (error) {
    throw new Error(`Invalid gzip blockmap ${filePath}: ${error.message}`)
  }
  if (!['1', '2'].includes(blockmap?.version) || !Array.isArray(blockmap.files) || blockmap.files.length === 0) {
    throw new Error(`Invalid blockmap payload: ${filePath}`)
  }
  return blockmap
}

export function verifyExternalBlockmapForArtifact(blockmapPath, artifactPath) {
  const blockmap = inspectExternalBlockmap(blockmapPath)
  const artifactSize = requireFile(artifactPath).size
  const blockmapSize = blockmap.files.reduce(
    (total, file) => total + (Array.isArray(file.sizes) ? file.sizes.reduce((sum, size) => sum + Number(size || 0), 0) : 0),
    0,
  )
  if (blockmapSize !== artifactSize) {
    throw new Error(`Blockmap describes ${blockmapSize} bytes but final artifact is ${artifactSize} bytes: ${artifactPath}`)
  }
  return blockmap
}

function fileRecord(filePath, role = 'artifact') {
  const stat = requireFile(filePath)
  return {
    filePath,
    remoteName: path.basename(filePath),
    role,
    size: stat.size,
    hash: hashFile(filePath),
  }
}

export function platformConfig(platform, { root, productName, version }) {
  const distDir = path.join(root, 'dist')
  if (platform === 'mac') {
    return {
      platform,
      displayName: 'macOS',
      expectedHostPlatform: 'darwin',
      supportedArchs: ['x64', 'arm64'],
      manifestName: 'latest-mac.yml',
      smoke(archs) {
        return [process.execPath, ['scripts/smoke-mac-artifacts.mjs', ...archs]]
      },
      collect(arch) {
        const prefix = `${productName}-${version}-mac-${arch}`
        const zipBlockmap = fileRecord(path.join(distDir, `${prefix}.zip.blockmap`))
        const dmgBlockmap = fileRecord(path.join(distDir, `${prefix}.dmg.blockmap`))
        verifyExternalBlockmapForArtifact(zipBlockmap.filePath, path.join(distDir, `${prefix}.zip`))
        verifyExternalBlockmapForArtifact(dmgBlockmap.filePath, path.join(distDir, `${prefix}.dmg`))
        const files = [
          fileRecord(path.join(distDir, `${prefix}.zip`)),
          zipBlockmap,
          fileRecord(path.join(distDir, `${prefix}.dmg`)),
          dmgBlockmap,
        ]
        return { files, primary: files[0], metadataFiles: [files[0], files[2]] }
      },
    }
  }
  if (platform === 'win') {
    return {
      platform,
      displayName: 'Windows',
      expectedHostPlatform: 'win32',
      expectedHostArch: 'x64',
      supportedArchs: ['x64'],
      manifestName: 'latest.yml',
      smoke() {
        return [process.execPath, ['scripts/smoke-win-artifacts.mjs', '--require-signing']]
      },
      collect() {
        const installer = fileRecord(path.join(distDir, `${productName}-Setup-${version}.exe`))
        const blockmap = fileRecord(path.join(distDir, `${productName}-Setup-${version}.exe.blockmap`))
        inspectExternalBlockmap(blockmap.filePath)
        return { files: [installer, blockmap], primary: installer, metadataFiles: [installer] }
      },
    }
  }
  if (platform === 'linux') {
    return {
      platform,
      displayName: 'Linux',
      expectedHostPlatform: 'linux',
      expectedHostArch: 'x64',
      supportedArchs: ['x64'],
      manifestName: 'latest-linux.yml',
      smoke() {
        return [process.execPath, ['scripts/smoke-linux-artifacts.mjs']]
      },
      collect(arch) {
        const appImage = fileRecord(path.join(distDir, `${productName}-${version}-linux-${arch}.AppImage`))
        appImage.blockMapSize = inspectEmbeddedBlockmap(appImage.filePath, appImage.size)
        return { files: [appImage], primary: appImage, metadataFiles: [appImage] }
      },
    }
  }
  throw new Error(`Unsupported release platform: ${platform}`)
}

export function createMetadata({
  platform,
  version,
  artifact,
  releaseDate,
  releaseNotes = '',
  stagingPercentage = 100,
}) {
  const lines = [`version: ${version}`, 'files:']
  for (const file of artifact.metadataFiles) {
    lines.push(`  - url: ${file.remoteName}`)
    lines.push(`    sha512: ${file.hash.base64}`)
    lines.push(`    size: ${file.size}`)
    if (platform === 'linux') lines.push(`    blockMapSize: ${file.blockMapSize}`)
  }
  lines.push(`path: ${artifact.primary.remoteName}`)
  lines.push(`sha512: ${artifact.primary.hash.base64}`)
  lines.push(`releaseDate: '${releaseDate}'`)
  const normalizedStaging = Number(stagingPercentage)
  if (![5, 10, 25, 50, 100].includes(normalizedStaging)) {
    throw new Error(`Unsupported stagingPercentage: ${stagingPercentage}`)
  }
  lines.push(`stagingPercentage: ${normalizedStaging}`)
  if (String(releaseNotes || '').trim()) {
    lines.push('releaseNotes: |-')
    for (const line of String(releaseNotes).replaceAll('\r\n', '\n').split('\n')) {
      lines.push(`  ${line}`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

function readRemoteVersions(root, host, config, archs) {
  const remoteScript = String.raw`set -eu
platform=$1
manifest=$2
shift 2
for arch in "$@"; do
  file="/srv/bailongma-updates/stable/$platform/$arch/$manifest"
  value=""
  if [ -f "$file" ]; then
    value=$(sed -n 's/^version:[[:space:]]*//p' "$file" | head -n 1 | tr -d "'\"")
  fi
  printf '%s=%s\n' "$arch" "$value"
done
`
  const output = run('ssh', [...SSH_OPTIONS, host, 'sh', '-s', '--', config.platform, config.manifestName, ...archs], {
    capture: true,
    input: remoteScript,
    cwd: root,
  })
  return new Map(output.split('\n').filter(Boolean).map(line => {
    const separator = line.indexOf('=')
    return [line.slice(0, separator), line.slice(separator + 1)]
  }))
}

export function validateRemoteVersions(version, remoteVersions, archs) {
  for (const arch of archs) {
    const remoteVersion = remoteVersions.get(arch)
    if (!remoteVersion) continue
    const comparison = compareVersions(version, remoteVersion)
    if (comparison < 0) throw new Error(`${arch} remote version ${remoteVersion} is newer than local ${version}`)
    if (comparison === 0) throw new Error(`${arch} version ${version} is already published; versioned releases are immutable`)
  }
}

function createInventory(metadataDir, artifacts) {
  const lines = []
  for (const artifact of artifacts) {
    for (const file of artifact.files) {
      lines.push([
        artifact.arch,
        'artifact',
        file.remoteName,
        file.remoteName,
        file.hash.hex,
        file.size,
        file.remoteName.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream',
      ].join('\t'))
    }
    const metadata = fileRecord(artifact.metadataPath, 'manifest')
    artifact.metadata = metadata
    lines.push([
      artifact.arch,
      'manifest',
      metadata.remoteName,
      artifact.manifestName,
      metadata.hash.hex,
      metadata.size,
      'text/yaml',
    ].join('\t'))
  }
  const inventoryPath = path.join(metadataDir, 'release-inventory.tsv')
  fs.writeFileSync(inventoryPath, `${lines.join('\n')}\n`, { mode: 0o600 })
  return inventoryPath
}

function publishRemote(root, host, remoteDir, config, version, productName, inventoryName, archs) {
  const remoteScript = String.raw`set -euf
stage=$1
version=$2
bucket=$3
platform=$4
product=$5
manifest_name=$6
inventory_name=$7
shift 7

case "$stage" in
  /srv/bailongma-release-staging.*) ;;
  *) echo "unsafe staging directory" >&2; exit 2 ;;
esac
case "$platform" in mac|win|linux) ;; *) echo "unsafe platform" >&2; exit 2 ;; esac
case "$product" in *[!A-Za-z0-9._-]*|'') echo "unsafe product name" >&2; exit 2 ;; esac
case "$manifest_name" in latest.yml|latest-mac.yml|latest-linux.yml) ;; *) echo "unsafe manifest" >&2; exit 2 ;; esac
case "$inventory_name" in *[!A-Za-z0-9._-]*|'') echo "unsafe inventory" >&2; exit 2 ;; esac

inventory="$stage/$inventory_name"
test -s "$inventory"
command -v flock >/dev/null
command -v ossutil >/dev/null
command -v sha512sum >/dev/null

exec 9>/run/lock/bailongma-update-publish.lock
flock -x 9

for arch in "$@"; do
  case "$arch" in x64|arm64) ;; *) echo "unsafe architecture" >&2; exit 2 ;; esac
  current_file="/srv/bailongma-updates/stable/$platform/$arch/$manifest_name"
  if [ -f "$current_file" ]; then
    current=$(sed -n 's/^version:[[:space:]]*//p' "$current_file" | head -n 1 | tr -d "'\"")
    comparison=$(awk -v a="$version" -v b="$current" 'BEGIN {
      na=split(a, av, "."); nb=split(b, bv, ".");
      if (na != 3 || nb != 3) exit 2;
      for (i=1; i<=3; i++) {
        if (av[i] !~ /^[0-9]+$/ || bv[i] !~ /^[0-9]+$/) exit 2;
        if ((av[i] + 0) > (bv[i] + 0)) { print 1; exit }
        if ((av[i] + 0) < (bv[i] + 0)) { print -1; exit }
      }
      print 0
    }') || { echo "invalid remote version for $arch" >&2; exit 2; }
    if [ "$comparison" -le 0 ]; then
      echo "refusing non-increasing $arch release: remote=$current local=$version" >&2
      exit 3
    fi
  fi
done

tab=$(printf '\t')
requested_archs=" $* "
while IFS="$tab" read -r arch kind stage_name remote_name expected_hash expected_size content_type; do
  case "$arch" in x64|arm64) ;; *) echo "invalid inventory architecture" >&2; exit 2 ;; esac
  case "$requested_archs" in *" $arch "*) ;; *) echo "inventory contains an unrequested architecture" >&2; exit 2 ;; esac
  case "$kind" in artifact|manifest) ;; *) echo "invalid inventory kind" >&2; exit 2 ;; esac
  case "$stage_name$remote_name" in *[!A-Za-z0-9._-]*) echo "invalid inventory filename" >&2; exit 2 ;; esac
  case "$expected_hash" in *[!0-9a-f]*|'') echo "invalid inventory hash" >&2; exit 2 ;; esac
  case "$expected_size" in *[!0-9]*|'') echo "invalid inventory size" >&2; exit 2 ;; esac
  case "$content_type" in application/octet-stream|text/yaml) ;; *) echo "invalid content type" >&2; exit 2 ;; esac
  file="$stage/$stage_name"
  test -s "$file"
  actual_hash=$(sha512sum "$file" | awk '{print $1}')
  actual_size=$(wc -c < "$file" | tr -d ' ')
  test "$actual_hash" = "$expected_hash"
  test "$actual_size" = "$expected_size"
  if [ "$kind" = manifest ]; then
    test "$remote_name" = "$manifest_name"
    test "$(sed -n 's/^version:[[:space:]]*//p' "$file" | head -n 1 | tr -d "'\"")" = "$version"
  fi
done < "$inventory"

while IFS="$tab" read -r arch kind stage_name remote_name expected_hash expected_size content_type; do
  [ "$kind" = artifact ] || continue
  origin_dir="/srv/bailongma-updates/stable/$platform/$arch"
  origin_file="$origin_dir/$remote_name"
  object="oss://$bucket/stable/$platform/$arch/$remote_name"
  test ! -e "$origin_file" || { echo "origin artifact already exists: $platform/$arch/$remote_name" >&2; exit 3; }
  if ossutil stat "$object" >/dev/null 2>&1; then
    echo "OSS artifact already exists: $platform/$arch/$remote_name" >&2
    exit 3
  fi
done < "$inventory"

while IFS="$tab" read -r arch kind stage_name remote_name expected_hash expected_size content_type; do
  [ "$kind" = artifact ] || continue
  file="$stage/$stage_name"
  origin_dir="/srv/bailongma-updates/stable/$platform/$arch"
  object="oss://$bucket/stable/$platform/$arch/$remote_name"
  install -d -m 755 "$origin_dir"
  ossutil cp "$file" "$object" --meta "Cache-Control:public, max-age=31536000, immutable#Content-Type:$content_type"
  temp_origin="$origin_dir/.${remote_name}.release-$$"
  install -m 644 "$file" "$temp_origin"
  mv "$temp_origin" "$origin_dir/$remote_name"
done < "$inventory"

verify_dir=$(mktemp -d "$stage/verify.XXXXXX")
trap 'rm -rf -- "$verify_dir"' EXIT HUP INT TERM
while IFS="$tab" read -r arch kind stage_name remote_name expected_hash expected_size content_type; do
  [ "$kind" = artifact ] || continue
  downloaded="$verify_dir/$arch-$remote_name"
  ossutil cp "oss://$bucket/stable/$platform/$arch/$remote_name" "$downloaded"
  test "$(sha512sum "$downloaded" | awk '{print $1}')" = "$expected_hash"
  test "$(wc -c < "$downloaded" | tr -d ' ')" = "$expected_size"
  test "$(sha512sum "/srv/bailongma-updates/stable/$platform/$arch/$remote_name" | awk '{print $1}')" = "$expected_hash"
done < "$inventory"

while IFS="$tab" read -r arch kind stage_name remote_name expected_hash expected_size content_type; do
  [ "$kind" = manifest ] || continue
  file="$stage/$stage_name"
  origin_dir="/srv/bailongma-updates/stable/$platform/$arch"
  object="oss://$bucket/stable/$platform/$arch/$remote_name"
  ossutil cp -f "$file" "$object" --meta "Cache-Control:no-store, no-cache, must-revalidate#Content-Type:$content_type"
  downloaded="$verify_dir/$arch-$remote_name"
  ossutil cp -f "$object" "$downloaded"
  test "$(sha512sum "$downloaded" | awk '{print $1}')" = "$expected_hash"
  temp_origin="$origin_dir/.${remote_name}.release-$$"
  install -m 644 "$file" "$temp_origin"
  mv "$temp_origin" "$origin_dir/$remote_name"
done < "$inventory"
`
  run('ssh', [
    ...SSH_OPTIONS,
    host,
    'sh', '-s', '--', remoteDir, version, BUCKET, config.platform, productName,
    config.manifestName, inventoryName, ...archs,
  ], { input: remoteScript, cwd: root })
}

async function requestFollowingRedirects(url, { headers = {}, expectedFinalStatus, body = 'text' }) {
  let current = new URL(url)
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    const requestHeaders = { ...headers }
    if (current.hostname !== 'updates.bailongma.ai') delete requestHeaders['X-Bailongma-Updater']
    let response
    try {
      response = await fetch(current, { headers: requestHeaders, redirect: 'manual' })
    } catch (error) {
      throw new Error(`HTTPS verification request failed for ${current.hostname}: ${error?.cause?.code || error.message}`)
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      if (!location) throw new Error('Update gateway returned a redirect without Location')
      current = new URL(location, current)
      if (!['updates.bailongma.ai', 'download.bailongma.ai'].includes(current.hostname)) {
        throw new Error(`Update gateway redirected to unexpected host: ${current.hostname}`)
      }
      continue
    }
    if (response.status !== expectedFinalStatus) {
      await response.body?.cancel()
      throw new Error(`Expected HTTP ${expectedFinalStatus} from ${current.hostname}, got ${response.status}`)
    }
    if (body === 'none') return { headers: response.headers, bytes: new Uint8Array(await response.arrayBuffer()) }
    if (body === 'hash') {
      const hash = crypto.createHash('sha512')
      let size = 0
      for await (const chunk of response.body) {
        hash.update(chunk)
        size += chunk.length
      }
      return { headers: response.headers, hash: hash.digest('hex'), size }
    }
    return { headers: response.headers, text: await response.text() }
  }
  throw new Error('Too many update download redirects')
}

async function verifyPublished(config, artifacts) {
  for (const artifact of artifacts) {
    const baseUrl = `${UPDATE_ORIGIN}/stable/${config.platform}/${artifact.arch}`
    const expectedMetadata = fs.readFileSync(artifact.metadataPath, 'utf8').trim()
    const legacy = await requestFollowingRedirects(`${baseUrl}/${config.manifestName}`, {
      expectedFinalStatus: 200,
    })
    const accelerated = await requestFollowingRedirects(`${baseUrl}/${config.manifestName}`, {
      headers: { 'X-Bailongma-Updater': UPDATER_HEADER },
      expectedFinalStatus: 200,
    })
    if (legacy.text.trim() !== expectedMetadata) throw new Error(`${artifact.arch} origin metadata verification failed`)
    if (accelerated.text.trim() !== expectedMetadata) throw new Error(`${artifact.arch} OSS metadata verification failed`)

    const fullDownload = await requestFollowingRedirects(`${baseUrl}/${artifact.primary.remoteName}`, {
      headers: { 'X-Bailongma-Updater': UPDATER_HEADER },
      expectedFinalStatus: 200,
      body: 'hash',
    })
    if (fullDownload.size !== artifact.primary.size || fullDownload.hash !== artifact.primary.hash.hex) {
      throw new Error(`${artifact.arch} HTTPS artifact SHA-512 verification failed`)
    }

    const range = await requestFollowingRedirects(`${baseUrl}/${artifact.primary.remoteName}`, {
      headers: { 'X-Bailongma-Updater': UPDATER_HEADER, Range: 'bytes=0-1023' },
      expectedFinalStatus: 206,
      body: 'none',
    })
    const contentRange = range.headers.get('content-range') || ''
    const match = contentRange.match(/^bytes 0-1023\/(\d+)$/)
    if (!match || Number(match[1]) !== artifact.primary.size || range.bytes.length !== 1024) {
      throw new Error(`${artifact.arch} OSS Range verification returned invalid length metadata`)
    }
    console.log(
      `[publish:${config.platform}] ${artifact.arch} origin/OSS manifests, remote SHA-512, and HTTP Range verified`,
    )
  }
}

async function confirmPublish(config, productName, version, archs) {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await prompt.question(
      `Publish ${productName} ${version} for ${config.displayName} ${archs.join(' + ')}? Type the version to continue: `,
    )
    if (answer.trim() !== version) throw new Error('Publication cancelled')
  } finally {
    prompt.close()
  }
}

export function validateReleaseIdentity(productName, version) {
  parseNumericVersion(version)
  if (!/^[A-Za-z0-9._-]+$/.test(productName)) {
    throw new Error(`Product name is unsafe for release filenames: ${productName}`)
  }
}

export async function publishUpdates({
  platform,
  root,
  pkg,
  argv = process.argv.slice(2),
  releaseOptions = {},
  onEvent = () => {},
}) {
  const productName = String(pkg.productName || 'Bailongma').trim()
  const version = String(pkg.version || '').trim()
  validateReleaseIdentity(productName, version)
  const config = platformConfig(platform, { root, productName, version })
  const options = parseArgs(argv, config.supportedArchs)
  const stagingPercentage = Number(releaseOptions.stagingPercentage ?? 100)
  const releaseNotes = String(releaseOptions.releaseNotes || '')
  const emit = (type, detail = {}) => onEvent({ type, platform, version, at: new Date().toISOString(), ...detail })

  if (!options.dryRun || !options.skipSmoke) {
    if (process.platform !== config.expectedHostPlatform) {
      throw new Error(`${config.displayName} releases must be checked on ${config.expectedHostPlatform}, got ${process.platform}`)
    }
    if (config.expectedHostArch && process.arch !== config.expectedHostArch) {
      throw new Error(`${config.displayName} x64 releases must be checked by an x64 Node process, got ${process.arch}`)
    }
  }

  if (!options.skipSmoke) {
    emit('check', { name: 'artifact-smoke', status: 'running' })
    const [command, args] = config.smoke(options.archs)
    run(command, args, { cwd: root })
    emit('check', { name: 'artifact-smoke', status: 'passed' })
  }

  const metadataDir = fs.mkdtempSync(path.join(root, 'dist', `.bailongma-${platform}-release-`))
  let remoteDir = ''
  try {
    const releaseDate = new Date().toISOString()
    const artifacts = options.archs.map(arch => ({ arch, ...config.collect(arch), manifestName: config.manifestName }))
    for (const artifact of artifacts) {
      artifact.metadataPath = path.join(metadataDir, `${path.parse(config.manifestName).name}-${artifact.arch}.yml`)
      fs.writeFileSync(
        artifact.metadataPath,
        createMetadata({
          platform,
          version,
          artifact,
          releaseDate,
          releaseNotes,
          stagingPercentage,
        }),
        { mode: 0o600 },
      )
      console.log(
        `[publish:${platform}] prepared ${artifact.arch}: ${artifact.files.length} artifact(s), `
        + `${(artifact.primary.size / 1024 / 1024).toFixed(1)} MiB primary file`,
      )
      emit('artifact', {
        arch: artifact.arch,
        status: 'validated',
        files: artifact.files.map(file => ({ name: file.remoteName, size: file.size, sha512: file.hash.hex })),
      })
    }
    const inventoryPath = createInventory(metadataDir, artifacts)

    if (options.dryRun) {
      console.log(`[publish:${platform}] dry run complete; hashes and metadata verified; nothing was uploaded`)
      emit('dry-run-complete', { archs: options.archs, stagingPercentage })
      return {
        dryRun: true,
        version,
        archs: options.archs,
        stagingPercentage,
        artifacts: artifacts.map(artifact => ({
          arch: artifact.arch,
          files: artifact.files.map(file => ({ name: file.remoteName, size: file.size, sha512: file.hash.hex })),
          metadata: fs.readFileSync(artifact.metadataPath, 'utf8'),
        })),
      }
    }

    emit('remote-read', { status: 'connecting' })
    run('ssh', [...SSH_OPTIONS, options.host, 'true'], { cwd: root })
    const remoteVersions = readRemoteVersions(root, options.host, config, options.archs)
    for (const arch of options.archs) {
      console.log(`[publish:${platform}] ${arch} current remote version: ${remoteVersions.get(arch) || '(none)'}`)
    }
    validateRemoteVersions(version, remoteVersions, options.archs)
    emit('remote-read', { status: 'validated', versions: Object.fromEntries(remoteVersions) })
    if (!options.yes) await confirmPublish(config, productName, version, options.archs)

    remoteDir = run(
      'ssh',
      [...SSH_OPTIONS, options.host, 'mktemp', '-d', '/srv/bailongma-release-staging.XXXXXX'],
      { capture: true, cwd: root },
    )
    if (!/^\/srv\/bailongma-release-staging\.[A-Za-z0-9]+$/.test(remoteDir)) {
      throw new Error(`Unexpected remote staging directory: ${remoteDir}`)
    }

    const uploadFiles = [
      ...artifacts.flatMap(artifact => [...artifact.files.map(file => file.filePath), artifact.metadataPath]),
      inventoryPath,
    ]
    const uploadPaths = uploadFiles.map(filePath => {
      const relative = path.relative(root, filePath)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Release upload file escaped the project root: ${filePath}`)
      }
      return relative.split(path.sep).join('/')
    })
    console.log(`[publish:${platform}] uploading ${uploadFiles.length} files to Hong Kong staging`)
    const uploadSizes = uploadFiles.map(filePath => fs.statSync(filePath).size)
    const totalUploadBytes = uploadSizes.reduce((sum, size) => sum + size, 0)
    let uploadedBytes = 0
    const uploadStartedAt = Date.now()
    emit('staging', { status: 'uploading', fileCount: uploadFiles.length, totalBytes: totalUploadBytes })
    for (let index = 0; index < uploadPaths.length; index += 1) {
      const relativePath = uploadPaths[index]
      emit('file-progress', {
        name: path.basename(relativePath),
        status: 'uploading',
        fileIndex: index,
        fileCount: uploadPaths.length,
        fileBytes: uploadSizes[index],
        uploadedBytes,
        totalBytes: totalUploadBytes,
      })
      run('scp', [...SSH_OPTIONS, relativePath, `${options.host}:${remoteDir}/`], { cwd: root })
      uploadedBytes += uploadSizes[index]
      const elapsedSeconds = Math.max(0.001, (Date.now() - uploadStartedAt) / 1000)
      const speed = uploadedBytes / elapsedSeconds
      emit('file-progress', {
        name: path.basename(relativePath),
        status: 'uploaded',
        fileIndex: index,
        fileCount: uploadPaths.length,
        fileBytes: uploadSizes[index],
        uploadedBytes,
        totalBytes: totalUploadBytes,
        speed,
        etaSeconds: speed > 0 ? Math.ceil((totalUploadBytes - uploadedBytes) / speed) : null,
      })
    }
    emit('staging', { status: 'uploaded' })

    // The remote transaction publishes every immutable artifact for all requested
    // architectures, verifies them, and only then switches all manifests. From
    // this boundary onward cancellation must be treated as uncertain.
    emit('metadata-boundary', { status: 'entered' })
    try {
      publishRemote(
        root,
        options.host,
        remoteDir,
        config,
        version,
        productName,
        path.basename(inventoryPath),
        options.archs,
      )
    } catch (publicationError) {
      emit('verify-release', { status: 'forced', reason: 'remote publication returned an error after metadata boundary' })
      try {
        await verifyPublished(config, artifacts)
        emit('verify-release', { status: 'forced-complete' })
      } catch (verificationError) {
        throw new Error(
          `${publicationError.message}\nForced remote verification also failed: ${verificationError.message}`,
        )
      }
      throw publicationError
    }
    emit('metadata-boundary', { status: 'completed' })
    emit('verify-release', { status: 'running' })
    await verifyPublished(config, artifacts)
    emit('verify-release', { status: 'passed' })
    console.log(`[publish:${platform}] ${productName} ${version} ${config.displayName} release published successfully`)
    return { dryRun: false, version, archs: options.archs, stagingPercentage }
  } finally {
    fs.rmSync(metadataDir, { recursive: true, force: true })
    if (remoteDir) {
      try {
        run('ssh', [...SSH_OPTIONS, options.host, 'rm', '-rf', '--', remoteDir], { cwd: root })
      } catch (error) {
        console.warn(`[publish:${platform}] failed to clean remote staging directory ${remoteDir}: ${error.message}`)
      }
    }
  }
}
