// The app's two kinds of menu: toolbar dropdowns (File, Alignment, Lexicon)
// and the right-click menu on the page.

const byId = (id) => document.getElementById(id);

// The gap between a toolbar button and the menu it opens. Keep in sync with
// the font list's margin in style.css.
const DROPDOWN_GAP = 4;

// Places `menu` at (x, y), nudged so the whole of it stays on screen. Its
// opening animation grows it out from (x, y), wherever the nudge puts it.
// offsetWidth and offsetHeight ignore the animation's scaling, which would
// make the menu measure smaller than it is.
export function placeOnScreen(menu, x, y) {
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const left = Math.max(4, Math.min(x, window.innerWidth - width - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - height - 4));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.transformOrigin = `${x - left}px ${y - top}px`;
}

/* ---------- Toolbar dropdowns ---------- */

const dropdowns = [];

// Makes `button` open `menu` beneath it. Each item in the menu is a button
// with a data-action; choosing one closes the menu and calls onChoose(action).
export function dropdown(button, menu, onChoose) {
  const close = () => {
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  };
  const open = () => {
    for (const other of dropdowns) other.close();
    menu.hidden = false;
    const rect = button.getBoundingClientRect();
    placeOnScreen(menu, rect.left, rect.bottom + DROPDOWN_GAP);
    button.setAttribute('aria-expanded', 'true');
  };

  button.addEventListener('click', () => (menu.hidden ? open() : close()));
  // Keep focus in the document, as the toolbar does.
  menu.addEventListener('mousedown', (event) => event.preventDefault());
  menu.addEventListener('click', (event) => {
    const action = event.target.closest('button')?.dataset.action;
    if (!action) return;
    close();
    onChoose(action);
  });

  const entry = { button, menu, close };
  dropdowns.push(entry);
  return entry;
}

/* ---------- The right-click menu ---------- */

const contextMenu = byId('context-menu');

export function closeContextMenu() {
  contextMenu.hidden = true;
}

// items: [{ label, action?, shortcut?, disabled?, className? } | 'separator']
// An item with no action is a plain label, such as a heading.
// Leading, trailing and doubled separators are dropped.
export function openContextMenu(items, x, y) {
  const tidy = items.filter((item, i) => item !== 'separator' || (i > 0 && items[i - 1] !== 'separator'));
  while (tidy[0] === 'separator') tidy.shift();
  while (tidy.at(-1) === 'separator') tidy.pop();

  contextMenu.replaceChildren(
    ...tidy.map((item) => {
      if (item === 'separator') return document.createElement('hr');

      if (!item.action) {
        const label = document.createElement('div');
        label.className = `menu-label ${item.className ?? ''}`;
        label.textContent = item.label;
        return label;
      }

      const button = document.createElement('button');
      button.type = 'button';
      button.className = item.className ?? '';
      button.disabled = Boolean(item.disabled);
      button.append(item.label);
      if (item.shortcut) {
        const shortcut = document.createElement('span');
        shortcut.className = 'shortcut';
        shortcut.textContent = item.shortcut;
        button.append(shortcut);
      }
      button.addEventListener('click', () => {
        closeContextMenu();
        item.action();
      });
      return button;
    }),
  );
  contextMenu.hidden = false;
  placeOnScreen(contextMenu, x, y);
}

// Keep focus in the document while the menu is used.
contextMenu.addEventListener('mousedown', (event) => event.preventDefault());

/* ---------- Closing menus ---------- */

// Capture phase, so it runs before the click that might open another menu.
document.addEventListener(
  'mousedown',
  (event) => {
    if (!contextMenu.hidden && !contextMenu.contains(event.target)) closeContextMenu();
    for (const { button, menu, close } of dropdowns) {
      if (!menu.hidden && !menu.contains(event.target) && !button.contains(event.target)) close();
    }
  },
  true,
);

// Returns true if Escape closed a menu.
export function closeMenusOnEscape() {
  let closed = false;
  if (!contextMenu.hidden) {
    closeContextMenu();
    closed = true;
  }
  for (const { menu, close } of dropdowns) {
    if (!menu.hidden) {
      close();
      closed = true;
    }
  }
  return closed;
}

byId('desk').addEventListener('scroll', closeContextMenu);
window.addEventListener('blur', () => {
  closeContextMenu();
  for (const { close } of dropdowns) close();
});
