import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const CACHE_TTL_MS = 60_000
const MAX_DEVICES = 40

let cachedSnapshot = null
let cachedAt = 0

function safeExecFile(command, args = [], timeout = 6_000) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    }).trim()
  } catch {
    return ''
  }
}

function safeJson(raw, fallback = null) {
  try { return JSON.parse(String(raw || '')) } catch { return fallback }
}

function finitePercent(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null
  const raw = String(value).trim()
  const percentText = raw.match(/(-?\d+(?:\.\d+)?)\s*%/)?.[1]
  const number = Number(percentText ?? value)
  if (!Number.isFinite(number)) return null
  // Windows device properties may use values above 100 as an unsupported or
  // unknown sentinel. Treat out-of-range data as unavailable instead of
  // turning it into a false 0%/100% reading.
  if (number < 0 || number > 100) return null
  return Math.round(number)
}

// Device names and manufacturers originate outside the application (for
// example, a Bluetooth accessory can advertise an arbitrary name). Keep that
// data readable while preventing it from becoming prompt markup or adding
// forged lines to the injected context.
function safeDisplayText(value, fallback = '', maxLength = 160) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return (text || fallback).slice(0, maxLength)
}

function normalizeTransport(value = '') {
  const text = String(value || '').toLowerCase()
  if (text.includes('bluetooth')) return 'bluetooth'
  if (text.includes('usb')) return 'usb'
  if (text.includes('built') || text.includes('internal')) return 'built_in'
  if (text.includes('hdmi') || text.includes('displayport')) return 'display'
  if (text.includes('pci')) return 'internal'
  return text ? text.replace(/^coreaudio_device_type_/, '') : 'unknown'
}

function normalizeKind(type = '', name = '', capabilities = []) {
  const text = `${type} ${name} ${(capabilities || []).join(' ')}`.toLowerCase()
  if (/keyboard|键盘/.test(text)) return 'keyboard'
  if (/mouse|trackpad|鼠标|触控板/.test(text)) return 'mouse'
  if (/headset|headphone|airpods|耳机/.test(text)) return 'headset'
  if (/microphone|\bmic\b|麦克风|话筒/.test(text)) return 'microphone'
  if (/speaker|扬声器|音箱/.test(text)) return 'speaker'
  if (/audio|input|output|音频/.test(text)) return 'audio'
  return 'peripheral'
}

function deviceId(device = {}) {
  return crypto.createHash('sha256')
    .update(`${device.kind}|${device.name}|${device.transport}`.toLowerCase())
    .digest('hex')
    .slice(0, 16)
}

function normalizeDevice(device = {}) {
  const capabilities = [...new Set((device.capabilities || [])
    .map(value => safeDisplayText(value, '', 80))
    .filter(Boolean))]
  const normalized = {
    id: '',
    name: safeDisplayText(device.name, 'Unknown device', 160),
    kind: normalizeKind(device.kind, device.name, capabilities),
    transport: normalizeTransport(device.transport),
    connected: device.connected !== false,
    battery_percent: finitePercent(device.battery_percent),
    capabilities,
    manufacturer: safeDisplayText(device.manufacturer, '', 120),
  }
  normalized.id = deviceId(normalized)
  return normalized
}

function mergeDevices(devices = []) {
  const byKey = new Map()
  for (const raw of devices) {
    const device = normalizeDevice(raw)
    const key = device.name.toLowerCase()
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, device)
      continue
    }
    existing.connected = existing.connected || device.connected
    if (existing.battery_percent === null && device.battery_percent !== null) {
      existing.battery_percent = device.battery_percent
    }
    if (existing.kind === 'peripheral' && device.kind !== 'peripheral') existing.kind = device.kind
    if (existing.transport === 'unknown' && device.transport !== 'unknown') existing.transport = device.transport
    existing.capabilities = [...new Set([...existing.capabilities, ...device.capabilities])]
    if (!existing.manufacturer && device.manufacturer) existing.manufacturer = device.manufacturer
  }
  return [...byKey.values()]
    .sort((a, b) => Number(b.connected) - Number(a.connected) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
    .slice(0, MAX_DEVICES)
}

export function parseMacHostPower(raw = '') {
  const text = String(raw || '')
  const source = text.match(/Now drawing from '([^']+)'/i)?.[1] || ''
  const match = text.match(/(\d+)%;\s*(charging|discharging|finishing charge|charged|not charging|AC attached)/i)
  return {
    name: os.hostname(),
    battery_percent: match ? finitePercent(match[1]) : null,
    charging: match ? !/^(discharging|not charging)$/i.test(match[2]) : null,
    power_source: /ac power/i.test(source) ? 'ac' : /battery power/i.test(source) ? 'battery' : 'unknown',
  }
}

export function parseMacHidBattery(raw = '') {
  const batteries = new Map()
  for (const block of String(raw || '').split(/(?=^\+-o\s)/m)) {
    const serial = block.match(/"SerialNumber"\s*=\s*"([^"]+)"/i)?.[1]
      || block.match(/"DeviceAddress"\s*=\s*"([^"]+)"/i)?.[1]
    const percent = finitePercent(block.match(/"BatteryPercent"\s*=\s*(\d+)/i)?.[1])
    if (!serial || percent === null) continue
    batteries.set(serial.replace(/-/g, ':').toUpperCase(), {
      battery_percent: percent,
      transport: block.match(/"Transport"\s*=\s*"([^"]+)"/i)?.[1] || '',
      manufacturer: block.match(/"Manufacturer"\s*=\s*"([^"]+)"/i)?.[1] || '',
    })
  }
  return batteries
}

export function parseMacBluetooth(raw = '', hidBatteryRaw = '') {
  const parsed = safeJson(raw, {})
  const batteries = parseMacHidBattery(hidBatteryRaw)
  const devices = []
  for (const controller of parsed?.SPBluetoothDataType || []) {
    for (const [group, connected] of [['device_connected', true], ['device_not_connected', false]]) {
      for (const item of controller?.[group] || []) {
        for (const [name, detail = {}] of Object.entries(item || {})) {
          const address = String(detail.device_address || '').toUpperCase()
          const battery = batteries.get(address)
          devices.push({
            name,
            kind: detail.device_minorType || '',
            transport: battery?.transport || 'bluetooth',
            connected,
            battery_percent: detail.device_batteryLevel ?? battery?.battery_percent ?? null,
            manufacturer: battery?.manufacturer || '',
            capabilities: [detail.device_minorType || '', detail.device_services || ''].filter(Boolean),
          })
        }
      }
    }
  }
  return devices
}

function walkProfilerItems(value, visit) {
  if (Array.isArray(value)) {
    for (const item of value) walkProfilerItems(item, visit)
    return
  }
  if (!value || typeof value !== 'object') return
  visit(value)
  for (const nested of Object.values(value)) walkProfilerItems(nested, visit)
}

export function parseMacAudio(raw = '') {
  const parsed = safeJson(raw, {})
  const devices = []
  walkProfilerItems(parsed?.SPAudioDataType || [], item => {
    const name = item._name
    const inputs = Number(item.coreaudio_device_input) || 0
    const outputs = Number(item.coreaudio_device_output) || 0
    if (!name || (inputs <= 0 && outputs <= 0)) return
    const capabilities = []
    if (inputs > 0) capabilities.push('audio_input')
    if (outputs > 0) capabilities.push('audio_output')
    devices.push({
      name,
      kind: inputs > 0 && outputs === 0 ? 'microphone' : outputs > 0 && inputs === 0 ? 'speaker' : 'audio',
      transport: item.coreaudio_device_transport || '',
      connected: true,
      battery_percent: null,
      manufacturer: item.coreaudio_device_manufacturer || '',
      capabilities,
    })
  })
  return devices
}

export function parseMacUsb(raw = '') {
  const parsed = safeJson(raw, {})
  const devices = []
  walkProfilerItems(parsed?.SPUSBDataType || [], item => {
    const name = String(item._name || '').trim()
    if (!name || !/(keyboard|mouse|trackpad|headset|headphone|microphone|\bmic\b|audio|键盘|鼠标|耳机|麦克风)/i.test(name)) return
    devices.push({
      name,
      kind: name,
      transport: 'usb',
      connected: true,
      battery_percent: null,
      manufacturer: item.manufacturer || item._name || '',
      capabilities: ['usb'],
    })
  })
  return devices
}

function collectMacSnapshot() {
  const host = parseMacHostPower(safeExecFile('pmset', ['-g', 'batt'], 2_000))
  const hid = safeExecFile('ioreg', ['-r', '-c', 'AppleDeviceManagementHIDEventService', '-l'], 3_000)
  const bluetooth = safeExecFile('system_profiler', ['SPBluetoothDataType', '-json', '-detailLevel', 'full'], 6_000)
  const audio = safeExecFile('system_profiler', ['SPAudioDataType', '-json', '-detailLevel', 'mini'], 5_000)
  const usb = safeExecFile('system_profiler', ['SPUSBDataType', '-json', '-detailLevel', 'mini'], 5_000)
  return {
    host,
    devices: mergeDevices([
      ...parseMacBluetooth(bluetooth, hid),
      ...parseMacAudio(audio),
      ...parseMacUsb(usb),
    ]),
  }
}

function collectWindowsSnapshot() {
  const script = [
    '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding;',
    "$b=Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1;",
    "$d=Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object {$_.Class -in @('Keyboard','Mouse','AudioEndpoint','Bluetooth','HIDClass')} | Select-Object -First 80 | ForEach-Object {",
    "$level=(Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName 'DEVPKEY_Device_BatteryLevel' -ErrorAction SilentlyContinue).Data;",
    "$manufacturer=(Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName 'DEVPKEY_Device_Manufacturer' -ErrorAction SilentlyContinue).Data;",
    "[PSCustomObject]@{FriendlyName=$_.FriendlyName;Class=$_.Class;Manufacturer=$manufacturer;Status=$_.Status;InstanceId=$_.InstanceId;Present=$true;BatteryLevel=$level}};",
    "[PSCustomObject]@{battery=$b;devices=@($d)} | ConvertTo-Json -Depth 4 -Compress",
  ].join('')
  return parseWindowsDeviceInformation(
    safeExecFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 8_000),
  )
}

export function parseWindowsDeviceInformation(raw = '', hostName = os.hostname()) {
  const parsed = typeof raw === 'string' ? safeJson(raw, {}) : raw || {}
  const battery = parsed?.battery || null
  const devices = (Array.isArray(parsed?.devices) ? parsed.devices : parsed?.devices ? [parsed.devices] : [])
    .filter(item => item?.FriendlyName)
    .map(item => {
      const instanceId = String(item.InstanceId || '')
      const deviceClass = String(item.Class || '')
      const transport = deviceClass.toLowerCase() === 'bluetooth' || /^(?:BTH|BTHENUM|BTHLEDEVICE)\\/i.test(instanceId)
        ? 'bluetooth'
        : /^USB\\/i.test(instanceId)
          ? 'usb'
          : 'unknown'
      return {
        name: item.FriendlyName,
        kind: deviceClass,
        transport,
        connected: item.Present !== false,
        battery_percent: finitePercent(item.BatteryLevel),
        manufacturer: item.Manufacturer || '',
        capabilities: [deviceClass, item.Status ? `status:${item.Status}` : ''].filter(Boolean),
      }
    })
  const rawBatteryStatus = battery?.BatteryStatus
  const batteryStatus = rawBatteryStatus === null || rawBatteryStatus === undefined || String(rawBatteryStatus).trim() === ''
    ? Number.NaN
    : Number(rawBatteryStatus)
  const hasBatteryStatus = Number.isFinite(batteryStatus)
  return {
    host: {
      name: hostName,
      battery_percent: finitePercent(battery?.EstimatedChargeRemaining),
      charging: battery && hasBatteryStatus ? [6, 7, 8, 9].includes(batteryStatus) : null,
      power_source: !battery
        ? 'ac'
        : [1, 4, 5].includes(batteryStatus)
          ? 'battery'
          : [2, 3, 6, 7, 8, 9, 11].includes(batteryStatus)
            ? 'ac'
            : 'unknown',
    },
    devices: mergeDevices(devices),
  }
}

function readLinuxHostPower() {
  const root = '/sys/class/power_supply'
  let entries = []
  try { entries = fs.readdirSync(root) } catch {}
  const batteryName = entries.find(name => /^BAT/i.test(name))
  if (!batteryName) return { name: os.hostname(), battery_percent: null, charging: null, power_source: 'ac' }
  const read = file => {
    try { return fs.readFileSync(path.join(root, batteryName, file), 'utf8').trim() } catch { return '' }
  }
  const status = read('status')
  return {
    name: os.hostname(),
    battery_percent: finitePercent(read('capacity')),
    charging: status ? !/^discharging$/i.test(status) : null,
    power_source: /^discharging$/i.test(status) ? 'battery' : 'ac',
  }
}

function collectLinuxSnapshot() {
  const devices = []
  const upowerDevices = safeExecFile('upower', ['-e'], 3_000).split(/\r?\n/).filter(Boolean)
  for (const devicePath of upowerDevices.slice(0, 30)) {
    if (!/(mouse|keyboard|headset|headphone|bluetooth)/i.test(devicePath)) continue
    const detail = safeExecFile('upower', ['-i', devicePath], 2_000)
    const name = detail.match(/^\s*model:\s*(.+)$/mi)?.[1] || path.basename(devicePath)
    devices.push({
      name,
      kind: devicePath,
      transport: /bluetooth/i.test(devicePath) ? 'bluetooth' : 'unknown',
      connected: !/^\s*state:\s*disconnected/im.test(detail),
      battery_percent: finitePercent(detail.match(/^\s*percentage:\s*(\d+)%/mi)?.[1]),
      capabilities: ['upower'],
    })
  }
  return { host: readLinuxHostPower(), devices: mergeDevices(devices) }
}

export function collectDeviceInformation({ force = false } = {}) {
  const now = Date.now()
  if (!force && cachedSnapshot && now - cachedAt < CACHE_TTL_MS) return cachedSnapshot
  const collected = process.platform === 'darwin'
    ? collectMacSnapshot()
    : process.platform === 'win32'
      ? collectWindowsSnapshot()
      : collectLinuxSnapshot()
  cachedSnapshot = {
    version: 1,
    platform: process.platform,
    sampled_at: new Date(now).toISOString(),
    host: collected.host,
    devices: collected.devices,
  }
  cachedAt = now
  return cachedSnapshot
}

export function __setDeviceInformationForTest(snapshot = null) {
  cachedSnapshot = snapshot ? {
    version: 1,
    platform: snapshot.platform || process.platform,
    sampled_at: snapshot.sampled_at || new Date().toISOString(),
    host: snapshot.host || { name: 'Test computer', battery_percent: null, charging: null, power_source: 'unknown' },
    devices: mergeDevices(snapshot.devices || []),
  } : null
  cachedAt = cachedSnapshot ? Date.now() : 0
}

export function getDeviceInformationSnapshot() {
  return collectDeviceInformation()
}

function formatBattery(percent) {
  return percent === null || percent === undefined ? 'battery unknown/not exposed' : `battery ${percent}%`
}

export function formatDeviceInformationBlock(snapshot = collectDeviceInformation()) {
  if (!snapshot) return ''
  const host = snapshot.host || {}
  const lines = [
    '## Device and Peripheral Snapshot',
    `Sampled at: ${snapshot.sampled_at}`,
    `Computer: ${safeDisplayText(host.name, 'this computer', 160)} — ${formatBattery(host.battery_percent)}`
      + (host.charging === true ? ', charging' : host.charging === false ? ', discharging' : '')
      + (host.power_source && host.power_source !== 'unknown' ? `, power source ${host.power_source}` : ''),
  ]
  const connected = (snapshot.devices || []).filter(device => device.connected)
  const disconnected = (snapshot.devices || []).filter(device => !device.connected)
  if (connected.length > 0) {
    lines.push('Connected devices:')
    for (const device of connected) {
      const roles = device.capabilities?.length
        ? `; ${device.capabilities.map(value => safeDisplayText(value, '', 80)).filter(Boolean).join(', ')}`
        : ''
      lines.push(`- ${safeDisplayText(device.name, 'Unknown device', 160)} [${safeDisplayText(device.kind, 'peripheral', 40)}; ${safeDisplayText(device.transport, 'unknown', 40)}${roles}]: ${formatBattery(device.battery_percent)}`)
    }
  } else {
    lines.push('Connected devices: none detected by the available system interfaces.')
  }
  if (disconnected.length > 0) {
    lines.push('Known but currently disconnected devices:')
    for (const device of disconnected.slice(0, 12)) {
      lines.push(`- ${safeDisplayText(device.name, 'Unknown device', 160)} [${safeDisplayText(device.kind, 'peripheral', 40)}; ${safeDisplayText(device.transport, 'unknown', 40)}]`)
    }
  }
  lines.push('Battery unknown means the operating system or device did not expose a value. Never infer or invent one.')
  lines.push('This provider supplies facts only. Use any accompanying subscription intent plus current context to decide whether a notification is useful.')
  return lines.join('\n')
}

export function getDeviceInformationBlock() {
  return formatDeviceInformationBlock(collectDeviceInformation())
}
