// Ctrl+Down and Ctrl+Up: centre the next or previous page in the window.
// Holding either flips on through the pages, like a flipbook: the view glides
// toward a target page that keeps moving ahead of it, so the motion stays
// continuous instead of stopping at each page.

const desk = document.getElementById('desk');

// How quickly the view catches up with its target: it closes most of the gap
// in about three times this. Smaller is snappier.
const GLIDE_MS = 55;
// Holding the key: wait this long, then move on a page this often. Our own
// timer, so the pace doesn't depend on the system's key-repeat settings.
const HOLD_DELAY_MS = 260;
const HOLD_EVERY_MS = 75;

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// Page height and the gap between sheets, in pixels, from the CSS variables.
function pageMetrics() {
  const style = getComputedStyle(document.documentElement);
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;height:var(--page-height);width:var(--page-gap)';
  document.body.append(probe);
  const metrics = { height: probe.offsetHeight, gap: probe.offsetWidth };
  probe.remove();
  // The toolbar floats over the top of the desk; centre pages in what's left.
  metrics.covered = parseFloat(style.getPropertyValue('--toolbar-bottom')) || 0;
  return metrics;
}

// The scroll position that centres each page, top to bottom.
function pageStops() {
  const pages = desk.querySelector('.ProseMirror');
  if (!pages) return [];
  const { height, gap, covered } = pageMetrics();
  const top = pages.getBoundingClientRect().top - desk.getBoundingClientRect().top + desk.scrollTop;
  const count = Math.max(1, Math.round((pages.offsetHeight + gap) / (height + gap)));
  const visibleMiddle = covered + (desk.clientHeight - covered) / 2;
  const maxScroll = desk.scrollHeight - desk.clientHeight;
  const stops = [];
  for (let i = 0; i < count; i++) {
    const stop = top + i * (height + gap) + height / 2 - visibleMiddle;
    stops.push(Math.round(Math.max(0, Math.min(maxScroll, stop))));
  }
  return stops;
}

/* ---------- The glide ---------- */

let target = null; // Where the view is heading, or null when it's at rest.
let position = 0; // The view's own position, kept unrounded for smoothness.
let lastFrame = 0;
let frame = 0;

function step(now) {
  const elapsed = Math.min(50, now - lastFrame);
  lastFrame = now;
  position += (target - position) * (1 - Math.exp(-elapsed / GLIDE_MS));
  if (Math.abs(target - position) < 0.5) position = target;
  desk.scrollTop = position;
  if (position === target) {
    target = null;
    frame = 0;
    return;
  }
  frame = requestAnimationFrame(step);
}

function glideTo(scrollTop) {
  if (reduceMotion.matches) {
    stopGlide();
    desk.scrollTop = scrollTop;
    return;
  }
  if (target === null) position = desk.scrollTop;
  target = scrollTop;
  if (!frame) {
    lastFrame = performance.now();
    frame = requestAnimationFrame(step);
  }
}

function stopGlide() {
  cancelAnimationFrame(frame);
  frame = 0;
  target = null;
}

// The mouse wheel or scrollbar takes over from a glide in progress.
desk.addEventListener('wheel', stopGlide, { passive: true });

/* ---------- Moving a page ---------- */

// Moves one page on from the page nearest the middle of the view. Measured
// from where the view is heading, so repeated presses add up mid-glide.
function flip(direction) {
  const stops = pageStops();
  if (!stops.length) return;
  const from = target ?? desk.scrollTop;
  let current = 0;
  stops.forEach((stop, i) => {
    if (Math.abs(stop - from) < Math.abs(stops[current] - from)) current = i;
  });
  const next = Math.max(0, Math.min(stops.length - 1, current + direction));
  glideTo(stops[next]);
}

let held = null; // { key, timer } while Ctrl+Up or Ctrl+Down is held.

function release() {
  if (!held) return;
  clearTimeout(held.timer);
  clearInterval(held.timer);
  held = null;
}

// Only while the document (or nothing in particular) has focus, so the keys
// still work as usual in the toolbar's boxes, the lexicon and dialogs.
function forTheDocument(event) {
  if (document.querySelector('dialog[open]')) return false;
  const focused = document.activeElement;
  return !focused || focused === document.body || Boolean(focused.closest('.ProseMirror'));
}

document.addEventListener(
  'keydown',
  (event) => {
    const direction = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (!direction || !event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;
    if (!forTheDocument(event)) return;
    // Capture phase, ahead of the editor's own Ctrl+arrow handling.
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat || held?.key === event.key) return; // Our own timer repeats.

    release();
    flip(direction);
    held = { key: event.key };
    held.timer = setTimeout(() => {
      if (!held) return;
      flip(direction);
      held.timer = setInterval(() => flip(direction), HOLD_EVERY_MS);
    }, HOLD_DELAY_MS);
  },
  true,
);

document.addEventListener('keyup', (event) => {
  if (held && (event.key === held.key || event.key === 'Control')) release();
});
window.addEventListener('blur', release);
