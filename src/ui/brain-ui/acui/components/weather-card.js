// ACUI WeatherCard — 原生 Web Component（移植自设计稿）
// 用法：ui_show("WeatherCard", { city, temp, condition, feel?, high?, low?, desc?, wind?, forecast? })
// 行为：挂载 → 入场动画 → 10s 自动关闭（向右滑出）

const AUTO_DISMISS_MS = 10000

// 中文 condition 映射到视觉风格 key
function pickKind(condition = '') {
  const c = String(condition)
  if (/暴雨/.test(c)) return 'heavyRain'
  if (/台风/.test(c)) return 'typhoon'
  if (/高温|酷热/.test(c)) return 'heat'
  if (/雷|雷暴|雷阵雨/.test(c)) return 'storm'
  if (/雪/.test(c)) return 'snowy'
  if (/雾|霾|沙尘/.test(c)) return 'foggy'
  if (/雨/.test(c)) return 'rainy'
  if (/多云|阴/.test(c)) return 'cloudy'
  if (/晴|sunny|clear/i.test(c)) return 'sunny'
  return 'cloudy'
}

const KIND_STYLE = {
  sunny:    { gradient:'linear-gradient(135deg,#0f2355 0%,#1e4080 45%,#c2700a 100%)', accent:'#fbbf24', accentDim:'rgba(251,191,36,0.25)', textSub:'rgba(255,220,120,0.8)', particles:'rays',     iconAnim:'floatY 3s ease-in-out infinite' },
  cloudy:   { gradient:'linear-gradient(135deg,#0f1825 0%,#1e3050 45%,#3a4f6a 100%)', accent:'#94a3b8', accentDim:'rgba(148,163,184,0.2)', textSub:'rgba(180,205,235,0.8)', particles:'clouds', iconAnim:'none' },
  rainy:    { gradient:'linear-gradient(135deg,#060d18 0%,#0d2035 45%,#104060 100%)', accent:'#38bdf8', accentDim:'rgba(56,189,248,0.2)',  textSub:'rgba(130,200,255,0.8)', particles:'rain',   iconAnim:'none' },
  snowy:    { gradient:'linear-gradient(135deg,#0a1220 0%,#162035 45%,#243348 100%)', accent:'#bae6fd', accentDim:'rgba(186,230,253,0.2)', textSub:'rgba(180,225,255,0.8)', particles:'snow',   iconAnim:'floatY 4s ease-in-out infinite' },
  storm:    { gradient:'linear-gradient(135deg,#030508 0%,#0a1020 45%,#141e2e 100%)', accent:'#facc15', accentDim:'rgba(250,204,21,0.2)',  textSub:'rgba(200,225,150,0.8)', particles:'storm',  iconAnim:'none' },
  heat:     { gradient:'linear-gradient(135deg,#1a0500 0%,#3d0e00 45%,#7a1500 100%)', accent:'#ff6b35', accentDim:'rgba(255,107,53,0.3)',  textSub:'rgba(255,180,120,0.85)', particles:'heat',  iconAnim:'none', warningLevel:'红色', warningColor:'#ef4444' },
  typhoon:  { gradient:'linear-gradient(135deg,#060412 0%,#0f0a28 45%,#1a1040 100%)', accent:'#a855f7', accentDim:'rgba(168,85,247,0.3)',  textSub:'rgba(200,170,255,0.85)', particles:'typhoon', iconAnim:'none', warningLevel:'橙色', warningColor:'#f97316' },
  heavyRain:{ gradient:'linear-gradient(135deg,#030a14 0%,#061525 45%,#0a2035 100%)', accent:'#3b82f6', accentDim:'rgba(59,130,246,0.3)',  textSub:'rgba(130,195,255,0.85)', particles:'heavyRain', iconAnim:'none', warningLevel:'红色', warningColor:'#ef4444' },
  foggy:    { gradient:'linear-gradient(135deg,#120e06 0%,#241a08 45%,#332510 100%)', accent:'#d97706', accentDim:'rgba(217,119,6,0.2)',   textSub:'rgba(220,190,120,0.8)', particles:'fog',    iconAnim:'none' },
}

// ── SVG 图标（每个返回 string，size 通过 viewBox 缩放） ──
function svgSun(size = 80) {
  const rays = [0,45,90,135,180,225,270,315].map((deg, i) => {
    const r = deg * Math.PI / 180
    const x1 = 32 + Math.cos(r) * 17, y1 = 32 + Math.sin(r) * 17
    const x2 = 32 + Math.cos(r) * 24, y2 = 32 + Math.sin(r) * 24
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#fde68a" stroke-width="2.5" stroke-linecap="round" style="animation: shimmer ${1.5 + i * 0.2}s ease-in-out infinite; animation-delay: ${i * 0.15}s"/>`
  }).join('')
  return `<svg width="${size}" height="${size}" viewBox="0 0 64 64" fill="none">
    ${rays}
    <circle cx="32" cy="32" r="13" fill="#fbbf24"/>
    <circle cx="32" cy="32" r="13" fill="url(#sunGrad)"/>
    <defs><radialGradient id="sunGrad" cx="35%" cy="30%">
      <stop offset="0%" stop-color="#fff176" stop-opacity="0.6"/>
      <stop offset="100%" stop-color="#f59e0b" stop-opacity="0"/>
    </radialGradient></defs>
  </svg>`
}

function svgCloud(size = 80, { rain = false, snow = false, storm = false } = {}) {
  const dark = rain || snow || storm
  const rainDrops = rain ? [20,28,36,44].map((x,i) =>
    `<line x1="${x}" y1="40" x2="${x-3}" y2="52" stroke="#7dd3fc" stroke-width="2" stroke-linecap="round" style="animation: rainDrop 1s linear infinite; animation-delay: ${i*0.2}s"/>`
  ).join('') : ''
  const snowDots = snow ? [20,29,38,47].map((x,i) =>
    `<circle cx="${x}" cy="48" r="2" fill="#bae6fd" style="animation: snowFall 1.8s linear infinite; animation-delay: ${i*0.35}s"/>`
  ).join('') : ''
  const stormBolt = storm ? `
    ${[20,30].map((x,i) => `<line x1="${x+i*4}" y1="40" x2="${x-3+i*4}" y2="52" stroke="#7dd3fc" stroke-width="1.5" stroke-linecap="round" opacity="0.7" style="animation: rainDrop 0.8s linear infinite; animation-delay: ${i*0.15}s"/>`).join('')}
    <polygon points="38,36 33,46 37,46 31,58 42,44 37,44" fill="#fde68a" style="animation: lightning 2.5s ease-in-out infinite"/>
  ` : ''
  return `<svg width="${size}" height="${size}" viewBox="0 0 64 64" fill="none">
    <defs>
      <linearGradient id="cloudG${size}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#cbd5e1"/><stop offset="100%" stop-color="#94a3b8"/></linearGradient>
      <linearGradient id="darkCloudG${size}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#475569"/><stop offset="100%" stop-color="#1e293b"/></linearGradient>
    </defs>
    <ellipse cx="38" cy="26" rx="14" ry="10" fill="${dark ? '#334155' : '#b0bec5'}" opacity="0.7"/>
    <path d="M14 36 Q14 24 26 24 Q28 16 38 18 Q48 18 48 28 Q54 28 54 36 Z" fill="${dark ? `url(#darkCloudG${size})` : `url(#cloudG${size})`}"/>
    ${rainDrops}${snowDots}${stormBolt}
  </svg>`
}

function svgFog(size = 80) {
  const lines = [{y:22,w:36,x:14},{y:30,w:28,x:18},{y:38,w:36,x:14},{y:46,w:24,x:20}].map((l,i) =>
    `<rect x="${l.x}" y="${l.y}" width="${l.w}" height="4" rx="2" fill="rgba(${180+i*10},${160+i*8},${120+i*6},0.7)" style="animation: fogDrift ${3+i*0.7}s ease-in-out infinite; animation-delay: ${i*0.5}s"/>`
  ).join('')
  return `<svg width="${size}" height="${size}" viewBox="0 0 64 64" fill="none">${lines}</svg>`
}

function svgSnow(size = 80) {
  const arms = [0,60,120,180,240,300].map(deg => `
    <g transform="rotate(${deg} 32 32)">
      <line x1="32" y1="10" x2="32" y2="54" stroke="#bae6fd" stroke-width="2.5" stroke-linecap="round"/>
      <line x1="24" y1="22" x2="32" y2="30" stroke="#bae6fd" stroke-width="2" stroke-linecap="round"/>
      <line x1="40" y1="22" x2="32" y2="30" stroke="#bae6fd" stroke-width="2" stroke-linecap="round"/>
    </g>
  `).join('')
  return `<svg width="${size}" height="${size}" viewBox="0 0 64 64" fill="none">${arms}<circle cx="32" cy="32" r="4" fill="#e0f2fe"/></svg>`
}

function svgHeat(size = 80) {
  const rays = [0,45,90,135,180,225,270,315].map((deg, i) => {
    const r = deg * Math.PI / 180
    return `<line x1="${40+Math.cos(r)*18}" y1="${40+Math.sin(r)*18}" x2="${40+Math.cos(r)*28}" y2="${40+Math.sin(r)*28}" stroke="#ff9555" stroke-width="2.5" stroke-linecap="round" style="animation: shimmer ${1.2+i*0.15}s ease-in-out infinite; animation-delay: ${i*0.12}s"/>`
  }).join('')
  const waves = [0,1,2].map(i =>
    `<path d="M${18+i*8},${58+i*3} Q${28+i*8},${53+i*3} ${38+i*8},${58+i*3} Q${48+i*8},${63+i*3} ${58+i*8},${58+i*3}" stroke="rgba(255,140,50,0.5)" stroke-width="1.5" fill="none" stroke-linecap="round" style="animation: heatWave ${1.5+i*0.3}s ease-in-out infinite; animation-delay: ${i*0.2}s"/>`
  ).join('')
  return `<svg width="${size}" height="${size}" viewBox="0 0 80 80" fill="none">
    <defs><radialGradient id="heatCore${size}" cx="40%" cy="35%"><stop offset="0%" stop-color="#ff6b35"/><stop offset="100%" stop-color="#cc2200"/></radialGradient></defs>
    ${rays}
    <circle cx="40" cy="40" r="15" fill="url(#heatCore${size})"/>
    <circle cx="40" cy="40" r="15" fill="rgba(255,200,100,0.15)"/>
    ${waves}
  </svg>`
}

function svgTyphoon(size = 80) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 80 80" fill="none">
    <circle cx="40" cy="40" r="36" stroke="rgba(120,80,200,0.3)" stroke-width="1"/>
    <circle cx="40" cy="40" r="24" stroke="rgba(120,80,200,0.4)" stroke-width="1.5"/>
    <g style="transform-origin: 40px 40px; animation: typhoonSpin 4s linear infinite">
      <path d="M40,10 Q60,20 55,40 Q50,60 40,55 Q30,50 35,40 Q40,30 40,10Z" fill="rgba(140,100,220,0.5)"/>
      <path d="M40,70 Q20,60 25,40 Q30,20 40,25 Q50,30 45,40 Q40,50 40,70Z" fill="rgba(100,160,220,0.5)"/>
    </g>
    <g style="transform-origin: 40px 40px; animation: typhoonSpin2 3s linear infinite">
      <path d="M10,40 Q20,20 40,25 Q60,30 55,40 Q50,50 40,45 Q20,40 10,40Z" fill="rgba(80,200,180,0.3)"/>
    </g>
    <circle cx="40" cy="40" r="6" fill="rgba(255,255,255,0.9)"/>
    <circle cx="40" cy="40" r="3" fill="rgba(140,100,220,1)"/>
  </svg>`
}

function svgHeavyRain(size = 80) {
  const drops = [16,24,32,40,48,56].map((x, i) => `
    <line x1="${x}" y1="48" x2="${x-4}" y2="62" stroke="#60a5fa" stroke-width="2" stroke-linecap="round" style="animation: heavyRain ${0.6+i*0.08}s linear infinite; animation-delay: ${i*0.1}s"/>
    <line x1="${x+3}" y1="56" x2="${x-1}" y2="72" stroke="#3b82f6" stroke-width="1.5" stroke-linecap="round" style="animation: heavyRain ${0.6+i*0.08}s linear infinite; animation-delay: ${i*0.1+0.3}s"/>
  `).join('')
  return `<svg width="${size}" height="${size}" viewBox="0 0 80 80" fill="none">
    <defs><linearGradient id="darkCloud2" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#1e2a3a"/><stop offset="100%" stop-color="#0a1520"/></linearGradient></defs>
    <ellipse cx="50" cy="28" rx="18" ry="12" fill="#1e293b" opacity="0.8"/>
    <path d="M12 44 Q12 28 28 28 Q30 18 44 20 Q58 20 58 32 Q66 32 66 44 Z" fill="url(#darkCloud2)"/>
    ${drops}
  </svg>`
}

function pickIcon(kind, size = 80) {
  switch (kind) {
    case 'sunny':     return svgSun(size)
    case 'cloudy':    return svgCloud(size)
    case 'rainy':     return svgCloud(size, { rain: true })
    case 'snowy':     return svgSnow(size)
    case 'storm':     return svgCloud(size, { storm: true })
    case 'foggy':     return svgFog(size)
    case 'heat':      return svgHeat(size)
    case 'typhoon':   return svgTyphoon(size)
    case 'heavyRain': return svgHeavyRain(size)
    default:          return svgCloud(size)
  }
}

// ── 粒子层 HTML 生成 ──
function rng(seed) {
  let s = seed | 0
  return () => { s = (s * 9301 + 49297) % 233280; return s / 233280 }
}

function particlesHTML(type, seed = 7) {
  const r = rng(seed)
  if (type === 'rain') {
    return Array.from({length: 20}, (_, i) => {
      const left = r() * 100, delay = r() * 2.5, dur = 0.7 + r() * 1.0
      return `<div style="position:absolute;left:${left}%;top:0;width:1.5px;height:12px;background:rgba(130,200,255,0.5);border-radius:1px;animation:rainDrop ${dur}s linear infinite;animation-delay:${delay}s;transform:rotate(8deg)"></div>`
    }).join('')
  }
  if (type === 'snow') {
    return Array.from({length: 16}, (_, i) => {
      const left = r() * 100, delay = r() * 2.5, dur = 2.2 + r() * 1.0
      return `<div style="position:absolute;left:${left}%;top:0;width:3px;height:3px;border-radius:50%;background:rgba(200,235,255,0.85);animation:snowFall ${dur}s linear infinite;animation-delay:${delay}s"></div>`
    }).join('')
  }
  if (type === 'rays') {
    return [0,1,2,3,4].map(i =>
      `<div style="position:absolute;bottom:-10%;right:5%;width:1.5px;height:80%;background:linear-gradient(to top,rgba(251,191,36,0.15),transparent);transform-origin:bottom right;transform:rotate(${-35+i*12}deg);animation:shimmer ${2+i*0.4}s ease-in-out infinite;animation-delay:${i*0.3}s"></div>`
    ).join('')
  }
  if (type === 'clouds') {
    return [{t:10,l:5,w:55,d:0},{t:25,l:55,w:40,d:2}].map((c,i) =>
      `<div style="position:absolute;top:${c.t}%;left:${c.l}%;width:${c.w}%;height:20px;background:rgba(180,200,230,0.15);border-radius:40px;filter:blur(5px);animation:cloudDrift ${4+i*2}s ease-in-out infinite;animation-delay:${c.d}s"></div>`
    ).join('')
  }
  if (type === 'storm') {
    const rains = Array.from({length: 16}, (_, i) => {
      const left = r() * 100, delay = r() * 2.5, dur = (0.7 + r() * 1.0) * 0.7
      return `<div style="position:absolute;left:${left}%;top:0;width:1.5px;height:14px;background:rgba(100,160,200,0.45);border-radius:1px;animation:rainDrop ${dur}s linear infinite;animation-delay:${delay}s;transform:rotate(10deg)"></div>`
    }).join('')
    return `${rains}
      <div style="position:absolute;inset:0;background:rgba(220,200,255,0.22);border-radius:inherit;animation:cardFlash 2.8s ease-in-out infinite;pointer-events:none"></div>
      <div style="position:absolute;inset:0;background:rgba(255,255,255,0.12);border-radius:inherit;animation:cardFlash 2.8s ease-in-out infinite;animation-delay:0.08s;pointer-events:none"></div>
      <svg style="position:absolute;top:0;left:30%;width:80px;height:100%;opacity:0;animation:cardFlash 2.8s ease-in-out infinite;animation-delay:0.02s" viewBox="0 0 80 120" fill="none">
        <polygon points="50,0 20,55 42,55 10,120 65,48 40,48" fill="rgba(255,255,255,0.7)" filter="url(#stormGlow)"/>
        <defs><filter id="stormGlow"><feGaussianBlur stdDeviation="4" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
      </svg>
      <div style="position:absolute;inset:0;border-radius:inherit;border:1.5px solid rgba(200,160,255,0.8);box-shadow:0 0 40px rgba(160,100,255,0.4),inset 0 0 24px rgba(180,120,255,0.08);opacity:0;animation:cardFlash 2.8s ease-in-out infinite;animation-delay:0.01s;pointer-events:none"></div>`
  }
  if (type === 'heat') {
    return [0,1,2,3,4].map(i =>
      `<div style="position:absolute;top:${25+i*12}%;left:0;right:0;height:20px;background:rgba(255,100,20,0.07);filter:blur(10px);animation:heatWave ${2.5+i*0.6}s ease-in-out infinite;animation-delay:${i*0.4}s"></div>`
    ).join('')
  }
  if (type === 'typhoon') {
    return `
      <div style="position:absolute;top:50%;right:-30%;transform:translateY(-50%);width:160px;height:160px;border-radius:50%;border:1px solid rgba(168,85,247,0.15);animation:typhoonSpin 8s linear infinite;opacity:0.5"></div>
      <div style="position:absolute;top:50%;right:-20%;transform:translateY(-50%);width:100px;height:100px;border-radius:50%;border:1px solid rgba(168,85,247,0.2);animation:typhoonSpin2 5s linear infinite"></div>`
  }
  if (type === 'heavyRain') {
    return Array.from({length: 28}, (_, i) => {
      const left = r() * 100, delay = r() * 1.5, dur = 0.4 + r() * 0.5
      return `<div style="position:absolute;left:${left}%;top:0;width:1.5px;height:16px;background:rgba(80,150,255,0.5);border-radius:1px;animation:heavyRain ${dur}s linear infinite;animation-delay:${delay}s;transform:rotate(10deg)"></div>`
    }).join('')
  }
  if (type === 'fog') {
    return [0,1,2,3].map(i =>
      `<div style="position:absolute;top:${18+i*18}%;left:0;right:0;height:16px;background:rgba(200,175,120,0.07);filter:blur(7px);animation:fogDrift ${3+i*0.9}s ease-in-out infinite;animation-delay:${i*0.7}s"></div>`
    ).join('')
  }
  return ''
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
}

export class WeatherCard extends HTMLElement {
  static componentName = 'WeatherCard'
  static tagName = 'acui-weather-card'

  constructor() {
    super()
    this.attachShadow({ mode: 'open' })
    this._timer = null
  }

  set props(v) { this._props = v; this._render() }
  get props()  { return this._props }

  connectedCallback() {
    if (this._timer) clearTimeout(this._timer)
    this._timer = setTimeout(() => {
      this.dispatchEvent(new CustomEvent('acui:dismiss', {
        bubbles: true, composed: true, detail: { by: 'auto-timeout' }
      }))
    }, AUTO_DISMISS_MS)
  }

  disconnectedCallback() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null }
  }

  _render() {
    const p = this._props || {}
    const kind = pickKind(p.condition)
    const style = KIND_STYLE[kind]

    const city      = p.city      ?? ''
    const temp      = p.temp      ?? ''
    const condition = p.condition ?? ''
    const desc      = p.desc      ?? condition
    const feel      = p.feel
    const high      = p.high
    const low       = p.low
    const wind      = p.wind      ?? ''
    const forecast  = Array.isArray(p.forecast) ? p.forecast.slice(0, 3) : []
    const warn      = p.warning || (style.warningLevel ? { level: style.warningLevel, color: style.warningColor } : null)

    const subline = [
      feel != null ? `体感 <span style="color:rgba(255,255,255,0.6)">${esc(feel)}°</span>` : null,
      (high != null || low != null) ? `<span style="color:rgba(255,255,255,0.6)">${esc(high ?? '')}°</span><span style="color:rgba(255,255,255,0.3)"> / ${esc(low ?? '')}°</span>` : null,
    ].filter(Boolean).join(' &nbsp;·&nbsp; ')

    const forecastHTML = forecast.length ? `
      <div class="forecast">
        ${forecast.map((f, i) => {
          const fkind = pickKind(f.condition || f.i)
          const day = f.day ?? f.d ?? f.time ?? ''
          const h = f.high ?? f.h ?? f.temp ?? ''
          const l = f.low  ?? f.l ?? ''
          return `
            <div class="fc" style="${i === 0 ? `border:1px solid ${style.accent}35` : ''}">
              <span class="fc-icon">${pickIcon(fkind, 22)}</span>
              <div>
                <div class="fc-day">${esc(day)}</div>
                <div class="fc-temp">${esc(h)}°${l !== '' ? `<span class="fc-low"> ${esc(l)}°</span>` : ''}</div>
              </div>
            </div>
          `
        }).join('')}
      </div>
    ` : ''

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; font-family: 'Inter', -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }

        @keyframes fadeIn   { from{opacity:0;transform:translateY(14px) scale(.97)} to{opacity:1;transform:translateY(0) scale(1)} }
        @keyframes floatY   { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-5px)} }
        @keyframes shimmer  { 0%,100%{opacity:.5} 50%{opacity:1} }
        @keyframes rainDrop { 0%{transform:translateY(-8px);opacity:0} 15%{opacity:.7} 100%{transform:translateY(80px);opacity:0} }
        @keyframes snowFall { 0%{transform:translateY(-8px) rotate(0);opacity:0} 15%{opacity:.85} 100%{transform:translateY(80px) rotate(360deg);opacity:0} }
        @keyframes cloudDrift { 0%,100%{transform:translateX(0)} 50%{transform:translateX(5px)} }
        @keyframes lightning { 0%,88%,100%{opacity:0} 90%,96%{opacity:1} }
        @keyframes cardFlash  { 0%,87%,100%{opacity:0} 89%{opacity:1} 91%,99%{opacity:0} 93%{opacity:.6} }
        @keyframes fogDrift  { 0%{transform:translateX(-15px);opacity:0} 50%{opacity:.6} 100%{transform:translateX(15px);opacity:0} }
        @keyframes heatWave  { 0%,100%{transform:scaleX(1) translateY(0);opacity:.4} 50%{transform:scaleX(1.04) translateY(-3px);opacity:.7} }
        @keyframes typhoonSpin { from{transform:rotate(0)} to{transform:rotate(360deg)} }
        @keyframes typhoonSpin2 { from{transform:rotate(0)} to{transform:rotate(-360deg)} }
        @keyframes warningPulse { 0%,100%{box-shadow:0 0 0 0 rgba(255,50,50,.5)} 50%{box-shadow:0 0 0 8px rgba(255,50,50,0)} }
        @keyframes heavyRain { 0%{transform:translateY(-6px);opacity:0} 10%{opacity:1} 100%{transform:translateY(90px);opacity:0} }

        .card {
          width: 520px; max-width: 100%; border-radius: 18px;
          background: ${style.gradient};
          border: 1px solid ${style.accentDim};
          box-shadow: 0 20px 56px rgba(0,0,0,.65), 0 0 30px ${style.accentDim};
          overflow: hidden; position: relative;
          animation: fadeIn .45s cubic-bezier(.16,1,.3,1) both;
        }
        .particles { position:absolute; inset:0; overflow:hidden; border-radius:inherit; pointer-events:none; z-index:1; }
        .scrim { position:absolute; inset:0; background:rgba(0,0,0,.15); border-radius:inherit; pointer-events:none; z-index:2; }
        .body { position:relative; z-index:3; display:flex; padding:28px 24px; }

        .left { display:flex; flex-direction:column; align-items:center; justify-content:center; width:150px; flex-shrink:0; gap:10px; }
        .icon-wrap { animation: ${style.iconAnim}; }
        .temp { color:#fff; font-size:58px; font-weight:200; line-height:1; letter-spacing:-2px; text-align:center; }
        .temp .deg { font-size:28px; color:rgba(255,255,255,.55); font-weight:300; }
        .desc { color:${style.textSub}; font-size:11px; margin-top:3px; font-weight:300; text-align:center; }

        .divider { width:1px; background:linear-gradient(to bottom, transparent, ${style.accent}50, transparent); margin:0 18px; flex-shrink:0; }

        .right { flex:1; display:flex; flex-direction:column; gap:12px; }
        .row { display:flex; align-items:center; justify-content:space-between; }
        .city { color:rgba(255,255,255,.9); font-size:14px; font-weight:500; }
        .sub  { color:rgba(255,255,255,.35); font-size:10px; margin-top:1px; }

        .badges { display:flex; gap:5px; align-items:center; }
        .ai-tag { background:rgba(255,255,255,.07); border:1px solid ${style.accentDim}; border-radius:5px; padding:2px 7px; color:${style.accent}; font-size:9px; letter-spacing:.06em; }
        .warn   { border-radius:5px; padding:2px 8px; font-size:9px; font-weight:600; letter-spacing:.05em; animation: warningPulse 1.5s ease-in-out infinite; }

        .stats { display:inline-flex; background:rgba(0,0,0,.22); border-radius:8px; padding:7px 12px; backdrop-filter:blur(4px); align-items:center; gap:6px; align-self:flex-start; }
        .stats-ico { color:rgba(255,255,255,.4); font-size:11px; }
        .stats-val { color:rgba(255,255,255,.8); font-size:12px; font-weight:400; }

        .forecast { display:flex; gap:6px; }
        .fc { flex:1; background:rgba(0,0,0,.18); border-radius:8px; padding:7px 6px; display:flex; align-items:center; gap:7px; backdrop-filter:blur(4px); border:1px solid transparent; }
        .fc-icon { display:inline-flex; }
        .fc-day  { color:rgba(255,255,255,.38); font-size:9px; }
        .fc-temp { color:rgba(255,255,255,.8); font-size:11px; font-weight:500; }
        .fc-low  { color:rgba(255,255,255,.3); font-weight:400; }
      </style>
      <div class="card">
        <div class="particles">${particlesHTML(style.particles)}</div>
        <div class="scrim"></div>
        <div class="body">
          <div class="left">
            <div class="icon-wrap">${pickIcon(kind, 80)}</div>
            <div>
              <div class="temp">${esc(temp)}<span class="deg">°</span></div>
              <div class="desc">${esc(desc)}</div>
            </div>
          </div>
          <div class="divider"></div>
          <div class="right">
            <div class="row">
              <div>
                <div class="city">${esc(city)}</div>
                ${subline ? `<div class="sub">${subline}</div>` : ''}
              </div>
              <div class="badges">
                ${warn ? `<div class="warn" style="background:${warn.color}26;border:1px solid ${warn.color}60;color:${warn.color}">⚠ ${esc(warn.level)}预警</div>` : ''}
                <div class="ai-tag">AI</div>
              </div>
            </div>
            ${wind ? `<div class="stats"><span class="stats-ico">🌬</span><span class="stats-val">${esc(wind)}</span></div>` : ''}
            ${forecastHTML}
          </div>
        </div>
      </div>
    `
  }
}

if (!customElements.get(WeatherCard.tagName)) {
  customElements.define(WeatherCard.tagName, WeatherCard)
}
