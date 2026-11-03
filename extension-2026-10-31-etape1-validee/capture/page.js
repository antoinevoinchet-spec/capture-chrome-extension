// Fonctions injectées dans la page capturée avec chrome.scripting.executeScript.
// Chrome les sérialise une par une : chacune doit rester autonome (aucune variable extérieure).
// L'état partagé entre les appels vit dans window.__captureState (monde isolé de l'extension).

export async function pagePrepare(options) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // Attend que la page se redessine ; le délai évite de rester bloqué si Chrome suspend l'onglet.
  const frame = () =>
    new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
      setTimeout(resolve, 250);
    });
  const root = document.scrollingElement || document.documentElement;

  const state = {
    startX: window.scrollX,
    startY: window.scrollY,
    target: null,
    targetStart: 0,
    styleEl: null,
    keep: new Set(),
    headerEls: [],
    bottomEls: [],
    hidden: [],
    hiddenSet: new Set(),
    settleMs: options.settleMs,
  };
  window.__captureState = state;

  // Défilement instantané et barres de défilement masquées le temps de la capture.
  const style = document.createElement('style');
  style.textContent =
    'html, body { scroll-behavior: auto !important; } * { scrollbar-width: none !important; } ::-webkit-scrollbar { display: none !important; }';
  (document.head || document.documentElement).appendChild(style);
  state.styleEl = style;
  await frame();

  const windowScrolls = () => {
    if (root.scrollHeight <= window.innerHeight + 8) return false;
    const y = window.scrollY;
    window.scrollTo({ top: y + 50, behavior: 'instant' });
    const moved = window.scrollY !== y;
    window.scrollTo({ top: y, behavior: 'instant' });
    return moved || y > 0;
  };

  // Si la fenêtre ne défile pas, le contenu défile dans un bloc (messagerie web, éditeur de notes, chat en ligne…, ou le
  // <body> lui-même) : on prend le plus grand bloc défilant visible.
  let target = null;
  if (!windowScrolls()) {
    let bestArea = 0;
    for (const el of document.querySelectorAll('body, body *')) {
      if (el.scrollHeight <= el.clientHeight + 8) continue;
      if (!/(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY)) continue;
      const r = el.getBoundingClientRect();
      const w = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
      const h = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
      if (w > 0 && h > 0 && w * h > bestArea) {
        bestArea = w * h;
        target = el;
      }
    }
    if (bestArea < window.innerWidth * window.innerHeight * 0.15) target = null;
  }
  state.target = target;

  const scrollToY = (y) =>
    target ? target.scrollTo({ top: y, behavior: 'instant' }) : window.scrollTo({ top: y, behavior: 'instant' });
  const scrollHeight = () => (target ? target.scrollHeight : root.scrollHeight);

  let clip;
  let viewportHeight;
  if (target) {
    state.targetStart = target.scrollTop;
    const r = target.getBoundingClientRect();
    const left = Math.max(0, r.left + target.clientLeft);
    const top = Math.max(0, r.top + target.clientTop);
    const right = Math.min(window.innerWidth, r.left + target.clientLeft + target.clientWidth);
    const bottom = Math.min(window.innerHeight, r.top + target.clientTop + target.clientHeight);
    clip = { x: left, y: top, w: right - left, h: bottom - top };
    viewportHeight = target.clientHeight;
  } else {
    clip = { x: 0, y: 0, w: document.documentElement.clientWidth || window.innerWidth, h: window.innerHeight };
    viewportHeight = window.innerHeight;
  }

  // Défilement préalable : déclenche le chargement des images « lazy » et des animations d'apparition.
  if (options.preload) {
    const deadline = Date.now() + options.preloadMaxMs;
    for (let y = 0; y < scrollHeight() && Date.now() < deadline; y += clip.h) {
      scrollToY(y);
      await sleep(options.preloadStepMs);
    }
    scrollToY(scrollHeight());
    await sleep(options.preloadStepMs);
  }
  scrollToY(0);
  await sleep(300);
  await frame();

  // Hauteur réellement atteignable : si le bloc dépasse de l'écran, son bas ne s'affiche jamais en entier.
  const fullHeight = scrollHeight() - viewportHeight + clip.h;
  const totalH = Math.min(fullHeight, options.maxHeight);

  // Éléments fixes ou collants : les en-têtes restent sur la première tranche puis sont masqués
  // pour ne pas se répéter ; les bandeaux fixés en bas (cookies, chat, barre d'actions) sont masqués
  // d'emblée, sinon ils cachent du texte. Le bloc défilant et ses parents sont épargnés.
  const keep = state.keep;
  for (let el = target; el; el = el.parentElement) keep.add(el);
  for (const el of document.querySelectorAll('body *')) {
    if (keep.has(el)) continue;
    const position = getComputedStyle(el).position;
    if (position === 'fixed' && el.getBoundingClientRect().top >= window.innerHeight / 2) state.bottomEls.push(el);
    else if (position === 'fixed' || position === 'sticky') state.headerEls.push(el);
  }

  return {
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    clip,
    totalH,
    sliceH: clip.h,
    truncated: fullHeight > options.maxHeight,
    scroller: target ? 'element' : 'window',
    title: document.title,
    url: location.href,
  };
}

export async function pageScrollTo(y, hideHeaders) {
  const state = window.__captureState;
  const frame = () =>
    new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
      setTimeout(resolve, 250);
    });
  const hide = (elements) => {
    let count = 0;
    for (const el of elements) {
      if (state.hiddenSet.has(el)) continue;
      state.hiddenSet.add(el);
      state.hidden.push([
        el,
        el.style.getPropertyValue('opacity'),
        el.style.getPropertyPriority('opacity'),
        el.style.getPropertyValue('transition'),
        el.style.getPropertyPriority('transition'),
      ]);
      el.style.setProperty('transition', 'none', 'important');
      el.style.setProperty('opacity', '0', 'important');
      count++;
    }
    return count;
  };

  hide(hideHeaders ? [...state.bottomEls, ...state.headerEls] : state.bottomEls);
  const target = state.target;
  if (target) target.scrollTo({ top: y, behavior: 'instant' });
  else window.scrollTo({ top: y, behavior: 'instant' });
  await frame();
  await new Promise((resolve) => setTimeout(resolve, state.settleMs));

  // Un en-tête peut devenir fixe pendant le défilement (script du site) : on le repère à chaque tranche.
  if (hideHeaders) {
    const late = [];
    for (const el of document.querySelectorAll('body *')) {
      if (state.hiddenSet.has(el) || state.keep.has(el)) continue;
      const position = getComputedStyle(el).position;
      if (position === 'fixed' || position === 'sticky') late.push(el);
    }
    if (hide(late)) await frame();
  }
  return target ? target.scrollTop : window.scrollY;
}

export function pageRestore() {
  const state = window.__captureState;
  if (!state) return;
  const restore = (el, prop, value, priority) => {
    if (value) el.style.setProperty(prop, value, priority);
    else el.style.removeProperty(prop);
  };
  for (const [el, opacity, opacityPriority, transition, transitionPriority] of state.hidden) {
    restore(el, 'opacity', opacity, opacityPriority);
    restore(el, 'transition', transition, transitionPriority);
  }
  if (state.target) state.target.scrollTo({ top: state.targetStart, behavior: 'instant' });
  window.scrollTo({ left: state.startX, top: state.startY, behavior: 'instant' });
  state.styleEl?.remove();
  delete window.__captureState;
}
