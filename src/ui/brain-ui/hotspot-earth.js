// Three.js 3D 地球组件 — 支持拖拽旋转、滚轮缩放、入场动画

const THREE_LOCAL = './vendor/three/three.module.js';
const THREE_CDN = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
const THREE_CDN_FALLBACK = 'https://unpkg.com/three@0.160.0/build/three.module.js';

// 贴图资源（NASA + mrdoob/three.js 公开贴图）
const TEX = {
  earth:   new URL('./vendor/earth/earth_atmos_2048.jpg', import.meta.url).href,
  normal:  new URL('./vendor/earth/earth_normal_2048.jpg', import.meta.url).href,
  specular:new URL('./vendor/earth/earth_specular_2048.jpg', import.meta.url).href,
  clouds:  new URL('./vendor/earth/earth_clouds_2048.png', import.meta.url).href,
};

// CDN 贴图失败时的程序生成 fallback 地球贴图
function createProceduralEarthTexture(T) {
  const W = 1024, H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  // 海洋
  const oceanGrad = ctx.createLinearGradient(0, 0, 0, H);
  oceanGrad.addColorStop(0,   '#061a2e');
  oceanGrad.addColorStop(0.3, '#0a2d4e');
  oceanGrad.addColorStop(0.5, '#0d3860');
  oceanGrad.addColorStop(0.7, '#0a2d4e');
  oceanGrad.addColorStop(1,   '#061a2e');
  ctx.fillStyle = oceanGrad;
  ctx.fillRect(0, 0, W, H);

  // 大陆（绿褐色）
  ctx.fillStyle = '#3a6b25';

  // 北美
  const p = (x, y) => [x / 360 * W, (90 - y) / 180 * H];
  function poly(coords) {
    ctx.beginPath();
    coords.forEach(([x, y], i) => {
      const [cx, cy] = p(x, y); i === 0 ? ctx.moveTo(cx, cy) : ctx.lineTo(cx, cy);
    });
    ctx.closePath(); ctx.fill();
  }
  // 北美
  poly([[-170,72],[-60,72],[-55,45],[-65,25],[-85,15],[-115,20],[-130,30],[-140,55],[-165,62]]);
  // 格陵兰
  poly([[-73,76],[-20,83],[-17,76],[-30,70],[-55,68],[-66,72]]);
  // 南美
  poly([[-82,12],[-60,12],[-35,5],[-35,-25],[-55,-55],[-68,-55],[-75,-40],[-80,-10]]);
  // 欧洲
  poly([[0,72],[30,72],[35,60],[30,45],[15,38],[0,38],[-10,45],[-10,60]]);
  // 非洲
  poly([[-18,38],[52,38],[52,10],[45,-10],[35,-35],[20,-55],[10,-35],[0,0],[-18,15]]);
  // 亚洲
  poly([[30,72],[180,72],[180,40],[140,20],[120,10],[100,5],[80,12],[60,20],[40,38],[28,60]]);
  // 东南亚半岛
  poly([[95,25],[110,10],[105,0],[95,5],[90,15]]);
  // 澳大利亚
  poly([[114,-22],[154,-22],[154,-39],[140,-38],[125,-33],[113,-28]]);
  // 南极（白色）
  ctx.fillStyle = 'rgba(200,225,255,0.55)';
  ctx.beginPath();
  ctx.rect(0, H * 0.89, W, H * 0.11); ctx.fill();
  // 北极（白色）
  ctx.beginPath();
  ctx.rect(0, 0, W, H * 0.04); ctx.fill();

  const tex = new T.CanvasTexture(canvas);
  if (T.SRGBColorSpace) tex.colorSpace = T.SRGBColorSpace;
  return tex;
}

// 主要城市热点坐标 [lat, lon]
const HOTSPOT_COORDS = [
  { lat: 39.9, lon: 116.4, label: '北京' },
  { lat: 31.2, lon: 121.5, label: '上海' },
  { lat: 22.5, lon: 114.1, label: '深圳' },
  { lat: 40.7, lon: -74.0, label: '纽约' },
  { lat: 51.5, lon: -0.1,  label: '伦敦' },
  { lat: 48.9, lon: 2.3,   label: '巴黎' },
  { lat: 35.7, lon: 139.7, label: '东京' },
  { lat: -33.9, lon: 151.2,label: '悉尼' },
  { lat: 55.8, lon: 37.6,  label: '莫斯科' },
  { lat: 19.4, lon: -99.1, label: '墨西哥城' },
  { lat: -23.5, lon: -46.6,label: '圣保罗' },
  { lat: 28.6, lon: 77.2,  label: '新德里' },
];

let THREE = null;

async function loadThree() {
  if (THREE) return THREE;
  try {
    const mod = await import(THREE_LOCAL);
    THREE = mod;
  } catch {
    try {
      const mod = await import(THREE_CDN);
      THREE = mod;
    } catch {
      const mod = await import(THREE_CDN_FALLBACK);
      THREE = mod;
    }
  }
  return THREE;
}

function latLonToVec3(lat, lon, radius) {
  const phi   = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
     radius * Math.cos(phi),
     radius * Math.sin(phi) * Math.sin(theta),
  );
}

export class HotspotEarth {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = null;
    this.scene    = null;
    this.camera   = null;
    this.earth    = null;
    this.clouds   = null;
    this.atmo     = null;
    this.atmo2    = null;
    this.stars    = null;
    this.hotspots = null;

    // 旋转状态
    this.isDragging = false;
    this.prevMouse  = { x: 0, y: 0 };
    this.rotX = 0.1;      // 当前 X 轴旋转（限制在 ±π/2）
    this.rotY = 0;        // 当前 Y 轴旋转
    this.velX = 0;        // 惯性速度
    this.velY = 0.0008;   // 初始自转速度

    // 相机距离
    this.camDist    = 3.25;
    this.camDistMin = 2.35;
    this.camDistMax = 4.5;

    // 入场动画
    this.appearing   = false;
    this.appearScale = 0;

    this.animFrame = null;
    this._bound = {};
    this.disposed = false;
  }

  async init() {
    const T = await loadThree();
    if (this.disposed) return null;

    // ── 场景 ──────────────────────────────────────────────
    this.scene = new T.Scene();

    // ── 相机 ──────────────────────────────────────────────
    const w = this.canvas.clientWidth  || 400;
    const h = this.canvas.clientHeight || 400;
    this.camera = new T.PerspectiveCamera(45, w / h, 0.1, 100);
    this.camera.position.set(0, 0, this.camDist);

    // ── 渲染器 ────────────────────────────────────────────
    this.renderer = new T.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
      // 引导驱动用核显：装饰性场景不值得唤醒双显卡笔记本的独显
      powerPreference: 'low-power',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h, false);
    if (T.SRGBColorSpace) this.renderer.outputColorSpace = T.SRGBColorSpace;
    if (T.ACESFilmicToneMapping) {
      this.renderer.toneMapping = T.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.15;
    }

    // ── 光源 ──────────────────────────────────────────────
    const sun = new T.DirectionalLight(0xffffff, 2.35);
    sun.position.set(5, 2.2, 4.5);
    this.scene.add(sun);
    this.scene.add(new T.HemisphereLight(0xdcecff, 0x111827, 0.72));
    this.scene.add(new T.AmbientLight(0xffffff, 0.16));

    // ── 贴图加载器 ────────────────────────────────────────
    const loader = new T.TextureLoader();
    const load   = (url) => new Promise((res) => loader.load(url, res, undefined, () => res(null)));

    const [earthTex, normalTex, specTex, cloudTex] = await Promise.all([
      load(TEX.earth),
      load(TEX.normal),
      load(TEX.specular),
      load(TEX.clouds),
    ]);
    // 面板在贴图加载期间被关闭时，不能在后台继续完成场景初始化。
    if (this.disposed) {
      [earthTex, normalTex, specTex, cloudTex].forEach((texture) => texture?.dispose?.());
      return null;
    }
    [earthTex, cloudTex].forEach((tex) => {
      if (tex && T.SRGBColorSpace) tex.colorSpace = T.SRGBColorSpace;
    });

    // ── 地球球体 ──────────────────────────────────────────

    const usedEarthTex = earthTex || createProceduralEarthTexture(T);

    const geo = new T.SphereGeometry(1, 64, 64);
    const mat = new T.MeshPhongMaterial({
      map:         usedEarthTex,
      normalMap:   normalTex  || undefined,
      specularMap: specTex    || undefined,
      specular:    new T.Color(0x1d3557),
      shininess:   28,
    });
    this.earth = new T.Mesh(geo, mat);
    this.scene.add(this.earth);

    // ── 云层 ──
    if (cloudTex) {
      const cloudGeo = new T.SphereGeometry(1.012, 48, 48);
      const cloudMat = new T.MeshPhongMaterial({
        map:         cloudTex,
        transparent: true,
        opacity:     0.75,
        depthWrite:  false,
        emissive:    new T.Color(0x666666),
      });
      this.clouds = new T.Mesh(cloudGeo, cloudMat);
      this.scene.add(this.clouds);
    }

    // ── 大气层辉光 ────────────────────────────────────────
    const atmoGeo = new T.SphereGeometry(1.06, 32, 32);
    const atmoMat = new T.MeshBasicMaterial({
      color:       0x4488ff,
      transparent: true,
      opacity:     0.06,
      side:        T.BackSide,
      depthWrite:  false,
    });
    this.atmo = new T.Mesh(atmoGeo, atmoMat);
    this.scene.add(this.atmo);

    // ── 第二层稍厚大气（浅蓝边缘）—— 必须保存引用才能参与出场动画 ──
    const atmo2Geo = new T.SphereGeometry(1.035, 32, 32);
    const atmo2Mat = new T.MeshBasicMaterial({
      color:       0x88ccff,
      transparent: true,
      opacity:     0.035,
      side:        T.FrontSide,
      depthWrite:  false,
    });
    this.atmo2 = new T.Mesh(atmo2Geo, atmo2Mat);
    this.scene.add(this.atmo2);

    // ── 星空粒子 ──────────────────────────────────────────
    const starVerts = [];
    for (let i = 0; i < 2000; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi   = Math.acos(2 * Math.random() - 1);
      const r     = 18 + Math.random() * 12;
      starVerts.push(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.cos(phi),
        r * Math.sin(phi) * Math.sin(theta),
      );
    }
    const starGeo = new T.BufferGeometry();
    starGeo.setAttribute('position', new T.Float32BufferAttribute(starVerts, 3));
    const starMat = new T.PointsMaterial({ color: 0xffffff, size: 0.06, sizeAttenuation: true });
    this.stars = new T.Points(starGeo, starMat);
    this.scene.add(this.stars);

    // ── 热点标记 ──────────────────────────────────────────
    this._buildHotspots(T);

    // ── 事件监听 ──────────────────────────────────────────
    this._bindEvents();

    // 只有真实首帧成功提交后才报告初始化完成。持续动画由面板生命周期在可见时
    // 调用 resume() 启动，避免面板已关闭但贴图刚加载完时短暂创建后台循环。
    this._checkResize();
    this.renderer.render(this.scene, this.camera);
    return this;
  }

  _buildHotspots(T) {
    const group = new T.Group();
    HOTSPOT_COORDS.forEach(({ lat, lon }) => {
      const pos = latLonToVec3(lat, lon, 1.025);
      // 外环
      const ringGeo = new T.RingGeometry(0.016, 0.026, 16);
      const ringMat = new T.MeshBasicMaterial({
        color: 0xff4444, transparent: true, opacity: 0.85, side: T.DoubleSide,
      });
      const ring = new T.Mesh(ringGeo, ringMat);
      ring.position.copy(pos);
      ring.lookAt(pos.clone().multiplyScalar(2));
      // 中心点
      const dotGeo = new T.CircleGeometry(0.009, 12);
      const dotMat = new T.MeshBasicMaterial({ color: 0xff8888, side: T.DoubleSide });
      const dot    = new T.Mesh(dotGeo, dotMat);
      dot.position.copy(pos);
      dot.lookAt(pos.clone().multiplyScalar(2));

      group.add(ring, dot);
    });
    this.hotspots = group;
    this.earth.add(group);
  }

  _bindEvents() {
    const c = this.canvas;
    const onDown = (e) => {
      this.isDragging = true;
      const p = e.touches ? e.touches[0] : e;
      this.prevMouse = { x: p.clientX, y: p.clientY };
      this.velX = 0;
      this.velY = 0;
    };
    const onMove = (e) => {
      if (!this.isDragging) return;
      e.preventDefault();
      const p = e.touches ? e.touches[0] : e;
      const dx = p.clientX - this.prevMouse.x;
      const dy = p.clientY - this.prevMouse.y;
      this.velY = dx * 0.003;
      this.velX = dy * 0.003;
      this.rotY += this.velY;
      this.rotX += this.velX;
      this.rotX = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, this.rotX));
      this.prevMouse = { x: p.clientX, y: p.clientY };
    };
    const onUp = () => { this.isDragging = false; };
    const onWheel = (e) => {
      e.preventDefault();
      this.camDist += e.deltaY * 0.002;
      this.camDist = Math.max(this.camDistMin, Math.min(this.camDistMax, this.camDist));
    };
    c.addEventListener('mousedown',  onDown);
    c.addEventListener('mousemove',  onMove);
    c.addEventListener('mouseup',    onUp);
    c.addEventListener('mouseleave', onUp);
    c.addEventListener('touchstart', onDown, { passive: true });
    c.addEventListener('touchmove',  onMove, { passive: false });
    c.addEventListener('touchend',   onUp);
    c.addEventListener('wheel',      onWheel, { passive: false });
    this._bound = { onDown, onMove, onUp, onWheel };
  }

  // 触发入场放大动画
  triggerAppear() {
    this.appearing   = true;
    this.appearScale = 0;
    if (this.earth)  this.earth.scale.setScalar(0);
    if (this.clouds) this.clouds.scale.setScalar(0);
    if (this.atmo)   this.atmo.scale.setScalar(0);
    if (this.atmo2)  this.atmo2.scale.setScalar(0);
    if (this.stars)  this.stars.material.opacity = 0;
  }

  _animate() {
    if (this.disposed || !this.renderer || !this.scene || !this.camera) return;
    this.animFrame = requestAnimationFrame(() => this._animate());

    // 入场动画（弹簧效果）
    if (this.appearing) {
      this.appearScale += (1 - this.appearScale) * 0.07;
      const s = this.appearScale;
      if (this.earth)  this.earth.scale.setScalar(s);
      if (this.clouds) this.clouds.scale.setScalar(s);
      if (this.atmo)   this.atmo.scale.setScalar(s);
      if (this.atmo2)  this.atmo2.scale.setScalar(s);
      if (this.stars)  this.stars.material.opacity = Math.min(1, s * 1.5);
      if (s > 0.999) {
        this.appearing = false;
        if (this.earth)  this.earth.scale.setScalar(1);
        if (this.clouds) this.clouds.scale.setScalar(1);
        if (this.atmo)   this.atmo.scale.setScalar(1);
        if (this.atmo2)  this.atmo2.scale.setScalar(1);
        if (this.stars)  this.stars.material.opacity = 1;
      }
    }

    // 惯性旋转衰减
    if (!this.isDragging) {
      this.velX *= 0.92;
      this.velY *= 0.92;
      this.rotX += this.velX;
      this.rotY += this.velY + 0.0018; // 持续自转
      this.rotX = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, this.rotX));
    }

    if (this.earth) {
      this.earth.rotation.x = this.rotX;
      this.earth.rotation.y = this.rotY;
    }
    // 云层略慢于地球，形成相对漂移
    if (this.clouds) {
      this.clouds.rotation.x = this.rotX;
      this.clouds.rotation.y = this.rotY + performance.now() * 0.000008;
    }

    // 相机平滑追踪距离
    const curr = this.camera.position.length();
    const next = curr + (this.camDist - curr) * 0.1;
    this.camera.position.setLength(next);

    // 响应 canvas 尺寸变化
    this._checkResize();

    this.renderer.render(this.scene, this.camera);
  }

  _checkResize() {
    const c   = this.canvas;
    const w   = c.clientWidth;
    const h   = c.clientHeight;
    if (!w || !h) return;
    const dpr = this.renderer.getPixelRatio();
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
  }

  // 暂停/恢复渲染循环：热点面板隐藏时整个场景不可见，rAF 却不会因元素隐藏
  // 而停（只有页面级隐藏才节流），不暂停的话 GPU 会一直全速画看不见的地球。
  pause() {
    if (this.animFrame) {
      cancelAnimationFrame(this.animFrame);
      this.animFrame = null;
    }
  }

  resume() {
    if (!this.animFrame && this.renderer) this._animate();
  }

  // 新建场景首次展示时，从缩小状态开始动画，并同步提交第一个非空帧。
  // 生命周期控制器会在本方法成功返回后才撤掉加载反馈。
  present() {
    this.triggerAppear();
    this.resume();
    return this;
  }

  isUsable() {
    if (this.disposed || !this.canvas || !this.renderer || !this.scene || !this.camera) return false;
    try {
      return !this.renderer.getContext?.().isContextLost?.();
    } catch {
      return false;
    }
  }

  dispose() {
    if (this.disposed) return null;
    this.disposed = true;
    if (this.animFrame) cancelAnimationFrame(this.animFrame);
    this.animFrame = null;
    const c = this.canvas;
    const b = this._bound;
    if (b.onDown)  c.removeEventListener('mousedown',  b.onDown);
    if (b.onMove)  c.removeEventListener('mousemove',  b.onMove);
    if (b.onUp)    c.removeEventListener('mouseup',    b.onUp);
    if (b.onUp)    c.removeEventListener('mouseleave', b.onUp);
    if (b.onDown)  c.removeEventListener('touchstart', b.onDown);
    if (b.onMove)  c.removeEventListener('touchmove',  b.onMove);
    if (b.onUp)    c.removeEventListener('touchend',   b.onUp);
    if (b.onWheel) c.removeEventListener('wheel',      b.onWheel);
    this.scene?.traverse((node) => {
      node.geometry?.dispose?.();
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of materials) {
        if (!material) continue;
        for (const value of Object.values(material)) {
          if (value?.isTexture) value.dispose?.();
        }
        material.dispose?.();
      }
    });
    this.renderer?.renderLists?.dispose?.();
    this.renderer?.dispose();
    // WebGLRenderer.dispose() 会清空 three 的缓存；强制丢失 context 可立即归还 GPU 资源。
    this.renderer?.forceContextLoss?.();

    // WEBGL_lose_context 会让当前 canvas 继续绑定一个已丢失的 context。若下次打开热点
    // 仍复用它，新的 WebGLRenderer 可能只能拿到这个失效 context，最终显示为空白。
    // 原位换成无事件监听、无 WebGL context 的新 canvas，既保留立即回收 GPU 的策略，
    // 又让下一次懒加载可以创建全新的 context。
    let replacementCanvas = null;
    if (c?.parentNode && typeof c.cloneNode === 'function' && typeof c.replaceWith === 'function') {
      replacementCanvas = c.cloneNode(false);
      c.replaceWith(replacementCanvas);
    }
    this.canvas = null;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.earth = null;
    this.clouds = null;
    this.atmo = null;
    this.atmo2 = null;
    this.stars = null;
    this.hotspots = null;
    return replacementCanvas;
  }
}
