import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-weather-fallback-'))
process.env.BAILONGMA_USER_DIR = tmp
process.env.BAILONGMA_RESOURCES_DIR = process.cwd()

const originalFetch = globalThis.fetch
let closeDBForTest = null
try {
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    if (String(url).includes('wttr.in')) return { ok: false, status: 500 }
    if (String(url).includes('api.open-meteo.com')) {
      return {
        ok: true,
        async json() {
          return {
            current: {
              temperature_2m: 26,
              relative_humidity_2m: 71,
              apparent_temperature: 28,
              weather_code: 2,
              wind_speed_10m: 12,
              wind_direction_10m: 90,
              visibility: 9000,
            },
            daily: {
              time: ['2026-08-06', '2026-08-07', '2026-08-08'],
              weather_code: [2, 61, 1],
              temperature_2m_max: [31, 30, 32],
              temperature_2m_min: [24, 23, 24],
            },
          }
        },
      }
    }
    throw new Error(`unexpected URL: ${url}`)
  }

  const { fetchAndCacheWeather } = await import('./weather.js')
  ;({ closeDBForTest } = await import('./db.js'))
  const result = await fetchAndCacheWeather('31.2304,121.5440')
  assert(result, 'Open-Meteo should provide a result after wttr.in HTTP 500')
  assert.equal(result.cardProps.temp, 26)
  assert.equal(result.cardProps.condition, '多云')
  assert.equal(result.cardProps.forecast.length, 3)
  assert.equal(calls.length, 2, 'coordinate locations need only the primary request and one fallback request')
  assert(calls[1].includes('api.open-meteo.com'))
  console.log('PASS weather falls back to Open-Meteo after wttr.in failure')
} finally {
  globalThis.fetch = originalFetch
  try { closeDBForTest?.() } catch {}
  fs.rmSync(tmp, { recursive: true, force: true })
}
