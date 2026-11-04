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
  // Le bloc choisi au calque, gardé par celui-ci avant que l'état ne soit remplacé.
  const pick = options.region ? (window.__captureState?.pickEl ?? null) : null;

  const state = {
    startX: window.scrollX,
    startY: window.scrollY,
    target: null,
    targetStart: 0,
    styleEl: null,
    keep: new Set(),
    headerEls: [],
    bottomEls: [],
    // Style d'origine de chaque élément retouché (null s'il n'en avait pas) : pageRestore le repose tel quel.
    styles: new Map(),
    hiddenSet: new Set(),
    settleMs: options.settleMs,
  };
  window.__captureState = state;

  // Défilement instantané et barres de défilement masquées le temps de la capture.
  const style = document.createElement('style');
  style.textContent =
    'html, body { scroll-behavior: auto !important; } * { scrollbar-width: none !important; } ::-webkit-scrollbar { display: none !important; }' +
    // Pour un bloc, chaque tranche doit tomber exactement où on l'attend : pas de défilement aligné par le site.
    (options.region ? ' * { scroll-snap-type: none !important; }' : '');
  (document.head || document.documentElement).appendChild(style);
  state.styleEl = style;
  await frame();

  if (options.region && !pick?.isConnected) return { gone: true };
  if (pick && !pick.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return { empty: true };
  const parentOf = (el) => el.parentElement || el.getRootNode().host || null;
  const chainOf = (el) => {
    const chain = [];
    for (let up = el; up; up = parentOf(up)) chain.push(up);
    return chain;
  };
  // <html> ne défile jamais lui-même, c'est la fenêtre. <body> non plus quand <html> n'a pas de style de débordement : le sien passe à la fenêtre.
  const isScroller = (el) => {
    if (el === document.documentElement) return false;
    if (el === document.body) {
      const { overflowX, overflowY } = getComputedStyle(document.documentElement);
      if (overflowX === 'visible' && overflowY === 'visible') return false;
    }
    return el.scrollHeight > el.clientHeight + 8 && /(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY);
  };
  const clientBox = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left + el.clientLeft, top: r.top + el.clientTop, right: r.left + el.clientLeft + el.clientWidth, bottom: r.top + el.clientTop + el.clientHeight };
  };
  // Le bloc tient en hauteur à l'écran, sans qu'une zone qui défile en cache un morceau : aucun défilement, ni avant ni pendant.
  const fitsOnScreen = (box) =>
    box.top >= 0 &&
    box.bottom <= window.innerHeight &&
    chainOf(pick)
      .slice(1)
      .every((el) => !isScroller(el) || (box.top >= clientBox(el).top - 1 && box.bottom <= clientBox(el).bottom + 1));
  const fits = pick ? fitsOnScreen(pick.getBoundingClientRect()) : false;
  // Un bloc qui défile lui-même peut être la zone principale, à assembler : on ne le sait qu'après l'avoir cherchée.
  let still = fits && !isScroller(pick);
  let partial = null;

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
  if (!still && !windowScrolls()) {
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
  // Seule la zone principale s'assemble. Une autre zone qui défile, ou un bloc fixe hors de cette zone, donne ce qu'il montre.
  if (pick && !still) {
    const parentScroller = chainOf(pick).slice(1).find(isScroller);
    const fixed = chainOf(pick).some((el) => getComputedStyle(el).position === 'fixed');
    const inMain = target ? pick === target || parentScroller === target : !parentScroller && !fixed;
    if (pick !== target && (fits || !inMain)) {
      still = true;
      if (!fits) partial = fixed && !parentScroller ? 'fixed' : 'scroller';
      target = null;
    }
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
  if (options.preload && !still) {
    const deadline = Date.now() + options.preloadMaxMs;
    for (let y = 0; y < scrollHeight() && Date.now() < deadline; y += clip.h) {
      scrollToY(y);
      await sleep(options.preloadStepMs);
    }
    scrollToY(scrollHeight());
    await sleep(options.preloadStepMs);
  }
  if (!still) {
    scrollToY(0);
    await sleep(300);
    await frame();
  }
  if (options.region && !pick.isConnected) return { gone: true };

  // Hauteur réellement atteignable : si le bloc dépasse de l'écran, son bas ne s'affiche jamais en entier.
  const fullHeight = scrollHeight() - viewportHeight + clip.h;
  const totalH = Math.min(fullHeight, options.maxHeight);

  // Un élément collant suit le bloc défilant le plus proche. Si c'est ce que la capture fait défiler, il reprend sa place normale : il
  // apparaît une fois, entier, là où il est dans la page (masqué après la première tranche, il perdrait ce qui dépasse du premier écran).
  // S'il colle dans un autre bloc (pied d'un récapitulatif, colonne d'un tableau), le défilement ne le déplace pas : il reste tel qu'à l'écran.
  // Le style réellement appliqué, pas le texte de l'attribut : une politique stricte peut refuser ce texte, et il ne faut pas le réveiller au retour.
  state.remember = (el) => {
    if (!state.styles.has(el)) state.styles.set(el, el.hasAttribute('style') ? el.style.cssText : null);
  };
  state.movesWithCapture = (el) => {
    for (let up = el.parentElement; up; up = up.parentElement) {
      if (up === target) return true;
      if (up === document.body || up === document.documentElement) break;
      const { display, overflowX, overflowY } = getComputedStyle(up);
      // Sans boîte propre (display: contents, en ligne, ligne de tableau), un parent ne fait rien de son overflow.
      if (/^(contents|inline|table-(row|header|footer|column).*)$/.test(display)) continue;
      if (/auto|scroll|hidden|overlay/.test(`${overflowX} ${overflowY}`)) return false;
    }
    return !target;
  };
  state.unstick = (el) => {
    state.remember(el);
    el.style.setProperty('position', 'relative', 'important');
    for (const side of ['top', 'bottom', 'left', 'right']) el.style.setProperty(side, 'auto', 'important');
  };

  // Parmi les éléments fixes, les en-têtes et tout ce que montre le premier écran restent sur la première tranche, puis sont masqués pour
  // ne pas se répéter. Les éléments du bas de l'écran (cookies, chat, barre d'actions) sont masqués d'emblée, sinon ils cachent du texte.
  // Deux exceptions gardent une information : le contenu d'une vraie surface fixe la suit, et un pied aligné sur un panneau lui appartient,
  // qu'il soit posé dedans ou juste dessous. Un conteneur sans taille ou presque vide ne compte pas : la bulle de chat qu'il contient reste une
  // bulle de chat. Un panneau est visible et laisse de la place à côté : un menu fermé ou un visuel pleine largeur ne garde pas le bandeau du bas.
  // Le bloc défilant et ses parents sont épargnés.
  const keep = state.keep;
  for (let el = target; el; el = el.parentElement) keep.add(el);

  // Le rectangle du bloc, relu maintenant que la page est préparée. `top` est mesuré depuis le début de ce qui défile.
  let region = null;
  if (pick) {
    for (const el of chainOf(pick)) keep.add(el);
    for (const el of pick.querySelectorAll('*')) keep.add(el);
    // Si on défile, un enfant fixe n'est plus « le bloc » : il se juge comme les autres éléments fixes, et aucun d'eux ne se juge sur lui.
    if (!still) {
      for (const el of pick.querySelectorAll('*')) {
        if (getComputedStyle(el).position !== 'fixed') continue;
        keep.delete(el);
        for (const inner of el.querySelectorAll('*')) keep.delete(inner);
      }
    }
    // Un bloc collant suit le défilement comme le reste de la page : on ne le force que s'il faut défiler.
    if (!still) {
      for (const el of chainOf(pick)) if (getComputedStyle(el).position === 'sticky') state.unstick(el);
      await frame();
    }
    const box = pick.getBoundingClientRect();
    let view = still ? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight } : { left: clip.x, top: clip.y, right: clip.x + clip.w, bottom: clip.y + clip.h };
    if (still) {
      for (const el of chainOf(pick).slice(1)) {
        if (!isScroller(el)) continue;
        const outer = clientBox(el);
        view = { left: Math.max(view.left, outer.left), top: Math.max(view.top, outer.top), right: Math.min(view.right, outer.right), bottom: Math.min(view.bottom, outer.bottom) };
      }
    }
    const left = Math.max(box.left, view.left);
    const right = Math.min(box.right, view.right);
    let top;
    let height;
    if (still) {
      top = Math.max(box.top, view.top);
      height = Math.min(box.bottom, view.bottom) - top;
      top -= clip.y;
      top += target ? target.scrollTop : window.scrollY;
    } else if (pick === target) {
      top = 0;
      height = fullHeight;
    } else {
      const start = target ? clientBox(target).top - target.scrollTop : -window.scrollY;
      top = Math.max(0, box.top - start);
      // Comme pour une page entière : si la zone dépasse de l'écran, son bas ne s'affiche jamais en entier.
      height = Math.min(box.bottom - start, fullHeight) - top;
    }
    if (right - left < 1 || height < 1) return { empty: true };
    if (pick !== target && isScroller(pick)) partial ??= 'scroller';
    // La zone principale se mesure sans sa bordure : c'est son contenu qu'on assemble.
    const wide = (pick === target ? pick.clientWidth : box.width) > right - left + 1;
    const alsoWide = wide && Boolean(partial);
    if (wide) partial ??= 'wide';
    const reach = Math.min(height, options.maxHeight);
    region = { left, width: right - left, top, height: reach, band: Math.min(clip.h, reach), still, start: target ? target.scrollTop : window.scrollY, partial, alsoWide, truncated: height > options.maxHeight };
    // Combien le haut de l'image est plus bas que le haut du bloc (un bloc qui commence au-dessus de la partie visible, ou du début de la page).
    if (pick !== target) {
      region.skip = still ? Math.max(box.top, view.top) - box.top : top - (box.top - (target ? clientBox(target).top - target.scrollTop : -window.scrollY));
      state.pick = pick;
    }
    // Les éléments fixes se jugent à la place où le bloc sera capturé.
    if (!still) {
      scrollToY(top);
      await frame();
    }
    state.regionView = still ? { left, right, top: Math.max(box.top, view.top), bottom: Math.min(box.bottom, view.bottom) } : { left, right, top: clip.y, bottom: clip.y + clip.h };
  }
  // Pour un bloc : un élément fixe qui passe devant lui est masqué dès la première tranche, un fond fixe derrière lui reste.
  // Les autres (hors du bloc, ou pas encore affichés) sont laissés à pageScrollTo, qui masque ce qui deviendra fixe ou visible en cours de route.
  const placeOfFixed = (el) => {
    const r = el.getBoundingClientRect();
    const v = state.regionView;
    const left = Math.max(r.left, v.left);
    const right = Math.min(r.right, v.right);
    const top = Math.max(r.top, v.top);
    const bottom = Math.min(r.bottom, v.bottom);
    if (right <= left || bottom <= top) return 'apart';
    const stack = document.elementsFromPoint((left + right) / 2, (top + bottom) / 2);
    const own = stack.findIndex((hit) => el.contains(hit));
    return own < 0 || own < stack.findIndex((hit) => keep.has(hit) && !el.contains(hit)) ? 'front' : 'behind';
  };
  const behind = new Set();
  // Un enfant du bloc gardé jusqu'ici, s'il devient fixe en cours de route, se répéterait sur les tranches : seul un fond déjà jugé reste protégé.
  if (pick && !still) state.lateChild = (el) => el !== pick && pick.contains(el) && !behind.has(el);
  const hasSurface = (el) => {
    const { backgroundImage, backgroundColor } = getComputedStyle(el);
    return backgroundImage !== 'none' || !/^(transparent|rgba\(.*,\s*0\))$/.test(backgroundColor);
  };
  // Le fond peut être porté par des blocs intérieurs, s'ils couvrent presque tout l'élément.
  const isSurface = (el, box, depth = 3) => {
    if (hasSurface(el)) return true;
    const whole = box.width * box.height * 0.8;
    if (!whole || !depth) return false;
    let area = 0;
    for (const child of el.children) {
      const inner = child.getBoundingClientRect();
      if (isSurface(child, inner, depth - 1)) area += inner.width * inner.height;
      if (area >= whole) return true;
    }
    return false;
  };
  const within = (outer, box) => box.left >= outer.left - 2 && box.right <= outer.right + 2 && box.top >= outer.top - 2 && box.bottom <= outer.bottom + 2;
  const surfaces = new Map();
  const panels = [];
  const stuck = [];
  const low = [];
  for (const el of document.querySelectorAll('body *')) {
    // Si on défile, un enfant du bloc suit la même règle que le reste de la page : collant, il reprend sa place ; fixe, il est masqué s'il passe
    // devant. Sinon il se répéterait sur chaque tranche.
    const scrolledChild = pick && !still && el !== pick && pick.contains(el);
    if (keep.has(el) && !scrolledChild) continue;
    const position = getComputedStyle(el).position;
    if (position !== 'fixed' && position !== 'sticky') continue;
    if (pick && position === 'fixed') {
      const place = placeOfFixed(el);
      if (place === 'front') {
        keep.delete(el);
        state.bottomEls.push(el);
      } else if (place === 'behind') {
        keep.add(el);
        behind.add(el);
      }
      continue;
    }
    const box = el.getBoundingClientRect();
    let follows = false;
    for (let up = el.parentElement; up && !follows; up = up.parentElement) follows = surfaces.has(up) && within(surfaces.get(up), box);
    if (follows) continue;
    const tall = box.height >= window.innerHeight / 2;
    // Seulement là où la réponse sert : une page peut compter des milliers de petits collants.
    const painted = (position === 'fixed' || tall) && isSurface(el, box);
    if (painted && tall && box.width < window.innerWidth * 0.9 && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) panels.push(box);
    if (position === 'sticky') {
      if (state.movesWithCapture(el)) stuck.push(el);
      else keep.add(el);
      continue;
    }
    if (painted) surfaces.set(el, box);
    if (box.top >= window.innerHeight / 2) low.push([el, box]);
    else state.headerEls.push(el);
  }
  for (const [el, box] of low) {
    const aligned = panels.some((panel) => Math.abs(panel.left - box.left) <= 2 && Math.abs(panel.right - box.right) <= 2 && box.top >= panel.top - 2 && box.top <= panel.bottom + 2);
    (aligned ? state.headerEls : state.bottomEls).push(el);
  }
  // Après coup : chaque retouche obligerait Chrome à recalculer la page avant de lire l'élément suivant.
  stuck.forEach(state.unstick);

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
    region,
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
      state.remember(el);
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

  // Un élément peut devenir fixe ou collant pendant le défilement, ou naître à ce moment-là (script du site, liste virtuelle) : on le
  // repère à chaque tranche. Le fixe est masqué, le collant reprend sa place.
  if (hideHeaders) {
    const lateFixed = [];
    const lateStuck = [];
    for (const el of document.querySelectorAll('body *')) {
      if (state.hiddenSet.has(el) || (state.keep.has(el) && !state.lateChild?.(el))) continue;
      const position = getComputedStyle(el).position;
      if (position === 'fixed') lateFixed.push(el);
      else if (position === 'sticky' && state.movesWithCapture(el)) lateStuck.push(el);
      else if (position === 'sticky') state.keep.add(el);
    }
    lateStuck.forEach(state.unstick);
    if (hide(lateFixed) + lateStuck.length) await frame();
  }
  return target ? target.scrollTop : window.scrollY;
}

// Où est le bloc, maintenant : le haut d'une tranche se lit sur lui, pas sur un calcul fait avant que la page ne bouge.
export function pageRegionRect() {
  const { pick } = window.__captureState;
  if (!pick) return null;
  if (!pick.isConnected) return { gone: true };
  const { top, height } = pick.getBoundingClientRect();
  return { top, height };
}

export function pageRestore() {
  const state = window.__captureState;
  if (!state) return;
  // Par cssText et non setAttribute : une page à la politique de sécurité stricte refuserait l'attribut.
  for (const [el, style] of state.styles) {
    if (style === null) el.removeAttribute('style');
    else el.style.cssText = style;
  }
  if (state.target) state.target.scrollTo({ top: state.targetStart, behavior: 'instant' });
  window.scrollTo({ left: state.startX, top: state.startY, behavior: 'instant' });
  state.styleEl?.remove();
  delete window.__captureState;
}
