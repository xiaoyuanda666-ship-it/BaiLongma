import { apiUrl } from './api-client.js';
import { createPersonCardPanel } from './person-card-panel.js';
import { t, translateUiText } from './i18n/index.js';

let personCardActive = false;
let currentCard = null;
let imageLookupToken = 0;
let revealTimer = null;
let animationTimer = null;
let transitionFrame = null;
let personCardAwaitingAssistantSummary = false;

const PERSON_CARD_REVEAL_DELAY_MS = 1000;
const PERSON_CARD_SURFACE_TRANSITION_MS = 480;

const $ = (id) => document.getElementById(id);

function personCardTransitionDuration() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    ? 1
    : PERSON_CARD_SURFACE_TRANSITION_MS;
}

function clearPersonCardTimers() {
  if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
  if (animationTimer) { clearTimeout(animationTimer); animationTimer = null; }
  if (transitionFrame) { cancelAnimationFrame(transitionFrame); transitionFrame = null; }
}

function getCognitionModule() {
  return document.querySelector('.cognition-module');
}

function mountPersonCardPanel() {
  const existing = $('person-card-panel');
  if (existing) return existing;
  const module = getCognitionModule();
  if (!module) return null;

  const template = document.createElement('template');
  template.innerHTML = createPersonCardPanel().trim();
  const panel = template.content.firstElementChild;
  if (!panel) return null;
  panel.setAttribute('aria-hidden', 'false');
  module.appendChild(panel);
  panel.querySelector('#pc-exit-btn')?.addEventListener('click', () => {
    setPersonCardMode(false, { source: 'brain-ui' });
  });
  return panel;
}

function destroyPersonCardPanel() {
  $('person-card-panel')?.remove();
  const module = getCognitionModule();
  if (module) {
    delete module.dataset.personActive;
    delete module.dataset.personPhase;
  }
  $('cognition-surface')?.setAttribute('aria-hidden', 'false');
  document.body.classList.remove('person-card-mode');
  imageLookupToken += 1;
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(v => String(v || '').trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(/[,，、;；\n]/).map(v => v.trim()).filter(Boolean);
  return [];
}

function uniqueList(items = []) {
  return [...new Set(items.map(v => String(v || '').trim()).filter(Boolean))];
}

function cleanLine(value = '') {
  return String(value || '')
    .replace(/^[\s>*\-•·]+/, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function comparablePersonText(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{Script=Han}a-z0-9]+/gu, '');
}

function isUsefulAssistantPersonSummary(summary = '', card = {}) {
  const summaryKey = comparablePersonText(summary);
  const names = uniqueList([card.name, ...normalizeList(card.aliases)])
    .map(comparablePersonText)
    .filter(Boolean);
  if (!summaryKey || !names.length) return false;
  const matchedName = names.find(name => summaryKey.includes(name));
  if (!matchedName) return false;
  // “乔布斯。”这类复述不是简介，不能覆盖已经存在的人物资料。
  return summaryKey.length >= matchedName.length + 6;
}

function extractKnownForFromText(text = '') {
  const value = cleanLine(text);
  const items = [];
  const patterns = [
    /(?:创办了|创建了|创立了|代表作(?:包括|有)?|作品(?:包括|有)?|known for[:：]?)\s*([^。.!！？；;]+)/gi,
    /(?:创始人|创办人|联合创始人)/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(value))) {
      if (!match[1]) {
        const sentenceStart = Math.max(0, value.lastIndexOf('，', match.index) + 1);
        items.push(value.slice(sentenceStart, pattern.lastIndex));
        continue;
      }
      items.push(
        ...match[1]
          .split(/[,，、/和及与]|以及/)
          .map(part => cleanLine(part).replace(/^(?:了|的)\s*/, ''))
          .filter(Boolean),
      );
    }
  }

  return uniqueList(items).slice(0, 6);
}

function formatUpdatedAt(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function avatarLabel(name = '') {
  const value = String(name || '').trim();
  if (!value) return t('person.avatarFallback');
  const latinWords = value.split(/\s+/).filter(Boolean);
  if (latinWords.length > 1 && latinWords.every(word => /^[A-Za-z]/.test(word))) {
    return latinWords.slice(0, 2).map(word => word[0].toUpperCase()).join('');
  }
  return [...value.replace(/\s+/g, '')][0] || t('person.avatarFallback');
}

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function setHeroImage(src = '', name = '') {
  const hero = $('pc-hero');
  const heroImg = $('pc-hero-img');
  const fallback = $('pc-hero-fallback');
  const imageUrl = String(src || '').trim();
  if (fallback) fallback.textContent = avatarLabel(name);
  if (heroImg) {
    heroImg.src = imageUrl;
    heroImg.alt = imageUrl ? name : '';
    heroImg.hidden = !imageUrl;
  }
  if (hero) hero.classList.toggle('pc-hero-has-image', !!imageUrl);
}

async function findPersonImage(name = '') {
  const query = String(name || '').trim();
  if (!query || [t('person.card'), t('person.unknown'), '人物卡片', '未知人物'].includes(query)) return '';
  const summaryEndpoints = [
    `https://zh.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`,
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`,
  ];
  for (const url of summaryEndpoints) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) continue;
      const data = await res.json();
      const image = data?.thumbnail?.source || data?.originalimage?.source || '';
      if (image) return image;
    } catch {}
  }

  // 别名（如“乔布斯”）不一定是百科页面的精确标题；搜索 API 作为回退，
  // 避免大多数知名人物长期停留在文字占位图。
  const searchEndpoints = [
    `https://zh.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrlimit=1&prop=pageimages&piprop=thumbnail&pithumbsize=640&format=json&origin=*`,
    `https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrlimit=1&prop=pageimages&piprop=thumbnail&pithumbsize=640&format=json&origin=*`,
  ];
  for (const url of searchEndpoints) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) continue;
      const data = await res.json();
      const pages = Object.values(data?.query?.pages || {});
      const image = pages[0]?.thumbnail?.source || '';
      if (image) return image;
    } catch {}
  }
  return '';
}

function scheduleHeroImageLookup(card = {}) {
  const name = String(card.name || '').trim();
  const explicitImage = String(card.image || card.avatar || '').trim();
  const token = ++imageLookupToken;
  setHeroImage(explicitImage, name);
  if (explicitImage) return;
  findPersonImage(name).then((image) => {
    if (token !== imageLookupToken || !image) return;
    if (currentCard?.name !== name) return;
    if (!personCardActive || !$('person-card-panel')) return;
    currentCard = { ...currentCard, image, avatar: currentCard?.avatar || image };
    setHeroImage(image, name);
    reportPersonCardState(personCardActive, 'image_lookup', currentCard);
  });
}

function renderPersonCard(card = {}) {
  currentCard = card;
  if (!$('person-card-panel')) return;
  const name = String(card.name || t('person.unknown')).trim();
  setText('pc-name', name);
  setText('pc-title', translateUiText(card.title || t('person.card')));
  setText('pc-summary', translateUiText(card.summary || t('person.noSummary')));
  setText('pc-source', t('person.source', { source: translateUiText(card.source || t('person.card')) }));
  setText('pc-updated', formatUpdatedAt(card.updatedAt));
  scheduleHeroImageLookup(card);

  const knownList = $('pc-known-list');
  if (knownList) {
    const knownFor = normalizeList(card.knownFor);
    knownList.innerHTML = '';
    if (!knownFor.length) {
      const li = document.createElement('li');
      li.textContent = t('person.noIdentifiers');
      knownList.appendChild(li);
    } else {
      for (const item of knownFor.slice(0, 6)) {
        const li = document.createElement('li');
        li.textContent = item;
        knownList.appendChild(li);
      }
    }
  }

  const tagsEl = $('pc-tags');
  if (tagsEl) {
    tagsEl.innerHTML = '';
    const tags = normalizeList(card.tags);
    for (const tag of tags.slice(0, 8)) {
      const span = document.createElement('span');
      span.className = 'pc-tag';
      span.textContent = tag;
      tagsEl.appendChild(span);
    }
  }
}

function reportPersonCardState(visible, source = 'brain-ui', card = currentCard) {
  fetch(apiUrl('/person-card-state'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active: !!visible, source, card }),
  }).catch(() => {});
}

function revealPersonCardSurface(card, source) {
  const module = getCognitionModule();
  const cognitionSurface = $('cognition-surface');
  const panel = mountPersonCardPanel();
  if (!module || !panel) {
    personCardActive = false;
    reportPersonCardState(false, source, currentCard);
    return;
  }

  personCardActive = true;
  renderPersonCard(card);
  cognitionSurface?.setAttribute('aria-hidden', 'false');
  panel.setAttribute('aria-hidden', 'false');
  module.dataset.personActive = 'true';
  delete module.dataset.personPhase;

  // 与小窗口浏览器一致：先让右侧的初始位姿渲染一帧，再同步切换两层。
  void module.offsetWidth;
  transitionFrame = requestAnimationFrame(() => {
    transitionFrame = null;
    if (!personCardActive || !$('person-card-panel')) return;
    module.dataset.personPhase = 'person';
    const duration = personCardTransitionDuration();
    animationTimer = setTimeout(() => {
      animationTimer = null;
      if (!personCardActive || module.dataset.personPhase !== 'person') return;
      cognitionSurface?.setAttribute('aria-hidden', 'true');
    }, duration + 34);
  });
  reportPersonCardState(true, source, currentCard);
}

function concealPersonCardSurface({ source, report = true, onHidden = null } = {}) {
  const module = getCognitionModule();
  const cognitionSurface = $('cognition-surface');
  const panel = $('person-card-panel');
  personCardActive = false;
  cognitionSurface?.setAttribute('aria-hidden', 'false');

  if (!module || !panel || module.dataset.personPhase !== 'person') {
    destroyPersonCardPanel();
    if (report) reportPersonCardState(false, source, currentCard);
    onHidden?.();
    return;
  }

  const duration = personCardTransitionDuration();
  transitionFrame = requestAnimationFrame(() => {
    transitionFrame = null;
    delete module.dataset.personPhase;
    animationTimer = setTimeout(() => {
      animationTimer = null;
      destroyPersonCardPanel();
      onHidden?.();
    }, duration + 34);
  });
  if (report) reportPersonCardState(false, source, currentCard);
}

export function setPersonCardMode(visible, { source = 'brain-ui', card = null } = {}) {
  const nextVisible = !!visible;
  const panel = $('person-card-panel');
  clearPersonCardTimers();

  if (!nextVisible) {
    personCardAwaitingAssistantSummary = false;
    if (card) currentCard = card;
    concealPersonCardSurface({ source });
    return;
  }

  const nextCard = card || currentCard || {
    name: t('person.card'),
    title: t('person.standby'),
    summary: t('person.intro'),
    knownFor: [],
    tags: ['standby'],
    source: 'standby',
  };
  if (source === 'agent_event') personCardAwaitingAssistantSummary = true;
  const isDifferentPerson = card?.name && currentCard?.name && card.name !== currentCard.name;
  if (personCardActive && isDifferentPerson && panel) {
    concealPersonCardSurface({
      source,
      report: false,
      onHidden: () => revealPersonCardSurface(nextCard, source),
    });
    return;
  }

  if (personCardActive && panel) {
    renderPersonCard(nextCard);
    if (getCognitionModule()?.dataset.personPhase === 'person') {
      $('cognition-surface')?.setAttribute('aria-hidden', 'true');
    }
    reportPersonCardState(true, source, currentCard);
    return;
  }

  currentCard = nextCard;
  destroyPersonCardPanel();
  revealTimer = setTimeout(() => {
    revealTimer = null;
    revealPersonCardSurface(nextCard, source);
  }, PERSON_CARD_REVEAL_DELAY_MS);
}

export function enrichVisiblePersonCardFromText(text, { source = 'assistant_summary' } = {}) {
  if (!personCardActive || !currentCard || !personCardAwaitingAssistantSummary) return false;
  const summary = cleanLine(text).slice(0, 260);
  if (!summary || !isUsefulAssistantPersonSummary(summary, currentCard)) return false;
  personCardAwaitingAssistantSummary = false;

  const knownFor = uniqueList([
    ...normalizeList(currentCard.knownFor),
    ...extractKnownForFromText(summary),
  ]);
  renderPersonCard({
    ...currentCard,
    summary,
    knownFor,
    source: currentCard.source === 'fallback' ? 'assistant' : currentCard.source,
    updatedAt: new Date().toISOString(),
  });
  reportPersonCardState(true, source, currentCard);
  return true;
}

export function cancelPersonCardAssistantEnrichment() {
  personCardAwaitingAssistantSummary = false;
}

export function togglePersonCard(source = 'brain-ui') {
  setPersonCardMode(!personCardActive, { source });
}

export async function showPersonCardByName(name, { source = 'brain-ui' } = {}) {
  const query = String(name || '').trim();
  if (!query) return;
  try {
    const res = await fetch(apiUrl(`/person-card?name=${encodeURIComponent(query)}`));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    setPersonCardMode(true, { source, card: data.card || { name: query } });
  } catch (err) {
    console.warn('[PersonCard] 人物卡片加载失败:', err.message);
    setPersonCardMode(true, {
      source,
      card: {
        name: query,
        title: t('person.card'),
        summary: t('person.noData'),
        knownFor: [],
        tags: [t('person.needsDetails')],
        source: 'fallback',
        updatedAt: new Date().toISOString(),
      },
    });
  }
}


export function initPersonCard() {
  clearPersonCardTimers();
  personCardActive = false;
  currentCard = null;
  personCardAwaitingAssistantSummary = false;
  destroyPersonCardPanel();
}
