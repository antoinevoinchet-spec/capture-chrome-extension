// Le calque de sélection d'un bloc ou d'une zone, injecté dans la page avec chrome.scripting.executeScript.
// Chrome sérialise chaque fonction : elle reste autonome (aucune variable extérieure).
// Le calque vit dans un shadow DOM fermé, dans le monde isolé de l'extension. Son état est dans window.__capturePicker.

export function pickerStart(startMode) {
  // Relancé pendant la sélection : le même calque change de mode, il ne s'empile pas.
  if (window.__capturePicker) {
    window.__capturePicker.setMode(startMode);
    return;
  }

  const HELP = {
    block: 'Survole un bloc, puis clique ou appuie sur Entrée. ↑ agrandit, ↓ revient. Z : tracer une zone. Échap : annuler.',
    zone: 'Trace un rectangle à la souris. Z : choisir un bloc. Échap : annuler.',
  };
  const MIN_ZONE = 4;
  const SWALLOWED = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'dragstart', 'selectstart'];

  const host = document.createElement('capture-picker');
  // Écrit par le style de l'objet et non par un attribut : une politique de sécurité stricte refuserait l'attribut.
  const place = {
    position: 'fixed',
    inset: '0',
    width: 'auto',
    height: 'auto',
    margin: '0',
    padding: '0',
    border: '0',
    display: 'block',
    overflow: 'visible',
    background: 'transparent',
    'pointer-events': 'auto',
    'z-index': '2147483647',
    opacity: '1',
    cursor: 'crosshair',
  };
  for (const [name, value] of Object.entries(place)) host.style.setProperty(name, value, 'important');
  const root = host.attachShadow({ mode: 'closed' });
  // Feuille construite : elle passe aussi sur une page dont la politique de sécurité refuse les styles écrits en texte.
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :host { --edge: #f4c542; --shade: #23453b; --bubble: #ffffff; --bubble-ink: #15211d; --veil: rgb(21 33 29 / 0.28); }
    @media (prefers-color-scheme: dark) {
      :host { --bubble: #1b2420; --bubble-ink: #e6ede9; --veil: rgb(0 0 0 / 0.42); }
    }
    .frame {
      position: fixed;
      box-sizing: border-box;
      border: 2px solid var(--edge);
      outline: 1px solid var(--shade);
      box-shadow: 0 0 0 200vmax var(--veil);
      pointer-events: none;
    }
    .frame[hidden] { display: none; }
    .help {
      position: fixed;
      left: 50%;
      top: 14px;
      transform: translateX(-50%);
      max-width: min(620px, calc(100vw - 28px));
      padding: 8px 14px;
      border-radius: 9px;
      font: 13px/1.4 "Avenir Next", Avenir, system-ui, sans-serif;
      text-align: center;
      color: var(--bubble-ink);
      background: var(--bubble);
      box-shadow: 0 2px 10px rgb(0 0 0 / 0.3);
      pointer-events: none;
    }
    .help.low { top: auto; bottom: 14px; }
  `);
  root.adoptedStyleSheets = [sheet];
  const frame = document.createElement('div');
  frame.className = 'frame';
  frame.hidden = true;
  const help = document.createElement('div');
  help.className = 'help';
  help.setAttribute('role', 'status');
  root.append(frame, help);
  document.documentElement.append(host);
  // Au premier plan de Chrome : même une boîte de dialogue native de la page passe dessous.
  host.setAttribute('popover', 'manual');
  try {
    host.showPopover();
  } catch {
    // Sans cela, le z-index suffit presque toujours.
  }

  const picker = { mode: startMode, root, current: null, setMode, stop, redraw };
  window.__capturePicker = picker;
  // Les flèches et les touches arrivent ici, pas dans une iframe qui aurait gardé le focus.
  if (/^(IFRAME|FRAME)$/.test(document.activeElement?.tagName ?? '')) window.focus();

  let hovered = null;
  let below = [];
  let drag = null;

  const parentOf = (el) => el.parentElement || el.getRootNode().host || null;

  // Le plus petit élément sous la souris, en entrant dans les Shadow DOM ouverts. Une iframe reste un seul bloc.
  function elementAt(x, y) {
    let el = document.elementsFromPoint(x, y).find((candidate) => candidate !== host);
    while (el?.shadowRoot) {
      const inner = el.shadowRoot.elementsFromPoint(x, y).find((candidate) => candidate.getRootNode() === el.shadowRoot);
      if (!inner) break;
      el = inner;
    }
    return !el || el === document.documentElement ? document.body : el;
  }

  // Le parent qui change vraiment le cadre : les enveloppes de même taille ne feraient que perdre un appui.
  function largerParent(el) {
    const box = el.getBoundingClientRect();
    for (let up = parentOf(el); up && up !== document.documentElement; up = parentOf(up)) {
      const outer = up.getBoundingClientRect();
      const same = Math.abs(outer.left - box.left) < 1 && Math.abs(outer.right - box.right) < 1 && Math.abs(outer.top - box.top) < 1 && Math.abs(outer.bottom - box.bottom) < 1;
      if (up === document.body || (!same && outer.width && outer.height)) return up;
    }
    return null;
  }

  function showFrame(x, y, w, h) {
    frame.hidden = false;
    const style = frame.style;
    style.setProperty('left', `${x}px`);
    style.setProperty('top', `${y}px`);
    style.setProperty('width', `${w}px`);
    style.setProperty('height', `${h}px`);
  }

  function redraw() {
    if (picker.mode === 'block' && picker.current) {
      const box = picker.current.getBoundingClientRect();
      showFrame(box.left, box.top, box.width, box.height);
    } else if (!drag) {
      frame.hidden = true;
    }
  }

  function setMode(mode) {
    picker.mode = mode;
    picker.current = null;
    hovered = null;
    below = [];
    drag = null;
    help.textContent = HELP[mode];
    redraw();
  }

  function zoneRect(event) {
    const x = Math.min(Math.max(0, event.clientX), window.innerWidth);
    const y = Math.min(Math.max(0, event.clientY), window.innerHeight);
    return { x: Math.min(drag.x, x), y: Math.min(drag.y, y), w: Math.abs(x - drag.x), h: Math.abs(y - drag.y) };
  }

  function onMove(event) {
    help.classList.toggle('low', event.clientY < 80);
    if (picker.mode === 'zone') {
      if (!drag) return;
      const { x, y, w, h } = zoneRect(event);
      showFrame(x, y, w, h);
      return;
    }
    const el = elementAt(event.clientX, event.clientY);
    // Un petit mouvement sur le même élément ne reperd pas le bloc choisi aux flèches.
    if (el === hovered) return;
    hovered = el;
    below = [];
    picker.current = el;
    redraw();
  }

  function onDown(event) {
    if (event.type === 'mousedown' && event.button === 0 && picker.mode === 'zone') {
      const x = Math.min(Math.max(0, event.clientX), window.innerWidth);
      const y = Math.min(Math.max(0, event.clientY), window.innerHeight);
      drag = { x, y };
    }
    // Annuler un `pointerdown` supprimerait le `mousedown` qui le suit.
    if (!event.type.startsWith('pointer')) event.preventDefault();
    event.stopImmediatePropagation();
  }

  function onUp(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.button !== 0) return;
    if (event.type === 'mouseup' && picker.mode === 'zone' && drag) {
      const rect = zoneRect(event);
      drag = null;
      if (rect.w >= MIN_ZONE && rect.h >= MIN_ZONE) validate(rect);
      else redraw();
    }
    if (event.type === 'click' && picker.mode === 'block') validateBlock();
  }

  function validateBlock() {
    if (!picker.current) return;
    const box = picker.current.getBoundingClientRect();
    // pagePrepare relit le rectangle de cet élément : le préparer peut le déplacer.
    window.__captureState = { pickEl: picker.current };
    validate({ x: box.left, y: box.top, w: box.width, h: box.height });
  }

  async function validate(rect) {
    const { mode } = picker;
    const stopped = stop();
    // Le second clic d'un double clic, ou le clic qui suit un tracé, n'atteint pas la page : il suivrait un lien, ou ouvrirait un menu qui finirait sur l'image.
    const swallow = (event) => {
      if (!event.type.startsWith('pointer')) event.preventDefault();
      event.stopImmediatePropagation();
    };
    for (const name of SWALLOWED) window.addEventListener(name, swallow, { capture: true });
    setTimeout(() => {
      for (const name of SWALLOWED) window.removeEventListener(name, swallow, { capture: true });
    }, 500);
    await stopped;
    chrome.runtime.sendMessage({ type: 'pick-result', mode, rect, zoom: window.devicePixelRatio, innerW: window.innerWidth }).catch(() => {});
  }

  async function cancel() {
    await stop();
    chrome.runtime.sendMessage({ type: 'pick-cancel' }).catch(() => {});
  }

  function onKey(event) {
    event.stopImmediatePropagation();
    // Les raccourcis du navigateur (⌘R, ⌘T…) gardent leur effet.
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    if (event.type !== 'keydown') return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (key === 'Escape') cancel();
    else if (key === 'z') setMode(picker.mode === 'block' ? 'zone' : 'block');
    else if (picker.mode !== 'block' || !picker.current) return;
    else if (key === 'Enter') validateBlock();
    else if (key === 'ArrowUp') {
      const up = largerParent(picker.current);
      if (up) {
        below.push(picker.current);
        picker.current = up;
        redraw();
      }
    } else if (key === 'ArrowDown' && below.length) {
      picker.current = below.pop();
      redraw();
    }
  }

  // Le calque reçoit la molette : il la rend à la zone qui défile sous la souris, sinon rien ne bougerait dans une application.
  function onWheel(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const vertical = Math.abs(event.deltaY) >= Math.abs(event.deltaX);
    for (let el = elementAt(event.clientX, event.clientY); el && el !== document.documentElement; el = parentOf(el)) {
      const { overflowX, overflowY } = getComputedStyle(el);
      const scrolls = vertical ? /auto|scroll|overlay/.test(overflowY) && el.scrollHeight > el.clientHeight : /auto|scroll|overlay/.test(overflowX) && el.scrollWidth > el.clientWidth;
      if (!scrolls || el === document.body) continue;
      el.scrollBy({ left: event.deltaX, top: event.deltaY, behavior: 'instant' });
      return;
    }
    window.scrollBy({ left: event.deltaX, top: event.deltaY, behavior: 'instant' });
  }

  const listeners = [
    ['mousemove', onMove, { capture: true, passive: true }],
    ['wheel', onWheel, { capture: true, passive: false }],
    ['keydown', onKey, { capture: true }],
    ['keyup', onKey, { capture: true }],
    ['keypress', onKey, { capture: true }],
    ['scroll', redraw, { capture: true, passive: true }],
    ['resize', redraw, { passive: true }],
    ['pagehide', stop, {}],
    ['mousedown', onDown, { capture: true }],
    ['mouseup', onUp, { capture: true }],
    ['click', onUp, { capture: true }],
    ...SWALLOWED.filter((name) => !['mousedown', 'mouseup', 'click'].includes(name)).map((name) => [name, onDown, { capture: true }]),
  ];
  for (const [name, handler, options] of listeners) window.addEventListener(name, handler, options);

  function stop() {
    for (const [name, handler, options] of listeners) window.removeEventListener(name, handler, options);
    host.remove();
    delete window.__capturePicker;
    // Attend que la page se redessine sans le calque ; le délai évite de rester bloqué sur un onglet en arrière-plan.
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
      setTimeout(resolve, 250);
    });
  }

  setMode(startMode);
}

export async function pickerStop() {
  await window.__capturePicker?.stop();
}
