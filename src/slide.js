// The slide between documents. The pages being left are copied into a
// still picture over the desk; the next document is swapped into the real
// editor; then the two slide across together, like turning a carousel. The
// copy is only a picture, so the real editor is never in two states at once.

const desk = document.getElementById('desk');
const page = document.getElementById('document');

// Quick off the mark and easing to a stop: crisp, but not abrupt. Keep the
// curve in sync with --ease-out in style.css.
const DURATION_MS = 300;
const EASING = 'cubic-bezier(0.2, 0, 0, 1)';

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let running = null; // { snapshot, animations } while a slide is under way.

// Ends a slide at once, as if it had finished.
function finish() {
  if (!running) return;
  const { snapshot, animations } = running;
  running = null;
  for (const animation of animations) animation.cancel();
  snapshot.remove();
  document.body.classList.remove('sliding');
}

// A still copy of the pages as they look now, laid over the desk at the same
// place and scroll position.
function snapshotOfDesk() {
  const rect = desk.getBoundingClientRect();
  const snapshot = document.createElement('div');
  snapshot.className = 'desk-snapshot';
  snapshot.setAttribute('aria-hidden', 'true');
  Object.assign(snapshot.style, {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  });
  const copy = page.cloneNode(true);
  copy.removeAttribute('id');
  for (const editable of copy.querySelectorAll('[contenteditable]')) editable.removeAttribute('contenteditable');
  snapshot.append(copy);
  document.body.append(snapshot);
  snapshot.scrollTop = desk.scrollTop;
  snapshot.scrollLeft = desk.scrollLeft;
  return snapshot;
}

// Calls swap() to put the next document in the editor, sliding it in from the
// right (direction 1) or the left (-1) as the old one leaves the other way.
// Direction 0 swaps without moving. done() runs once the pages are at rest.
export function slideDocuments(direction, swap, done = () => {}) {
  finish();
  if (!direction || reduceMotion.matches) {
    swap();
    done();
    return;
  }

  const snapshot = snapshotOfDesk();
  swap();

  // The full width of the desk, so the two sets of pages travel side by side.
  const distance = desk.clientWidth * direction;
  const timing = { duration: DURATION_MS, easing: EASING };
  const animations = [
    snapshot.firstChild.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${-distance}px)` }], timing),
    page.animate([{ transform: `translateX(${distance}px)` }, { transform: 'translateX(0)' }], timing),
  ];
  // The text cursor is drawn apart from the pages, so it would stay put while
  // they move: hidden until they settle.
  document.body.classList.add('sliding');
  const slide = { snapshot, animations };
  running = slide;

  animations[1].finished.then(
    () => {
      if (running !== slide) return;
      finish();
      done();
    },
    () => {}, // Cancelled by a newer slide, which takes over.
  );
}
