import Paragraph from '@tiptap/extension-paragraph';
import { dropdown } from './menus.js';

// Presets: named paragraph styles (Standard, Title, Heading 1 to 6), each a
// font, size, and bold, italic and underline. A paragraph remembers which
// preset it uses, and is drawn in that preset's settings, so changing a
// preset changes every paragraph that uses it. Formatting put on the text
// itself (a font or size chosen from the toolbar) still wins over the preset.
//
// Presets belong to the app, not to one document, and are kept between
// sessions. Standard is the document's default text.

export const PRESETS = ['standard', 'title', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'];

export const PRESET_LABELS = {
  standard: 'Standard',
  title: 'Title',
  h1: 'Heading 1',
  h2: 'Heading 2',
  h3: 'Heading 3',
  h4: 'Heading 4',
  h5: 'Heading 5',
  h6: 'Heading 6',
};

const font = (size, styles = {}) => ({ font: 'Times New Roman', size, bold: false, italic: false, underline: false, ...styles });

const DEFAULT_PRESETS = {
  standard: font(12),
  title: font(26, { bold: true }),
  h1: font(20, { bold: true }),
  h2: font(16, { bold: true }),
  h3: font(14, { bold: true }),
  h4: font(12, { bold: true, italic: true }),
  h5: font(12, { bold: true }),
  h6: font(12, { italic: true }),
};

export const MIN_SIZE = 1;
export const MAX_SIZE = 400;

const STORAGE_KEY = 'glyphein.presets';

// A preset's settings, with anything missing or invalid taken from the default.
function clean(name, value) {
  const fallback = DEFAULT_PRESETS[name];
  if (!value || typeof value !== 'object') return { ...fallback };
  const size = Number(value.size);
  return {
    font: typeof value.font === 'string' && value.font.trim() ? value.font.trim() : fallback.font,
    size: size >= MIN_SIZE && size <= MAX_SIZE ? size : fallback.size,
    bold: typeof value.bold === 'boolean' ? value.bold : fallback.bold,
    italic: typeof value.italic === 'boolean' ? value.italic : fallback.italic,
    underline: typeof value.underline === 'boolean' ? value.underline : fallback.underline,
  };
}

function load() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
  } catch {
    // Unreadable or unavailable: the defaults.
  }
  return Object.fromEntries(PRESETS.map((name) => [name, clean(name, stored[name])]));
}

let presets = load();
const listeners = new Set();

// All the presets, as { standard: { font, size, bold, italic, underline }, ... }.
export const getPresets = () => structuredClone(presets);

// The settings of a paragraph's preset (null is Standard).
export const presetFormat = (name) => presets[name] ?? presets.standard;

export const isDefaultPreset = (name) => JSON.stringify(presets[name]) === JSON.stringify(DEFAULT_PRESETS[name]);

export function onPresetsChange(listener) {
  listeners.add(listener);
}

function changed() {
  renderStyles();
  for (const listener of listeners) listener();
}

export function setPreset(name, settings) {
  presets = { ...presets, [name]: clean(name, settings) };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  } catch (error) {
    console.error(`Could not save the presets: ${error.message}`);
  }
  changed();
}

export const resetPreset = (name) => setPreset(name, DEFAULT_PRESETS[name]);

// Another window changed them.
window.addEventListener('storage', (event) => {
  if (event.key !== STORAGE_KEY) return;
  presets = load();
  changed();
});

/* ---------- Drawing ---------- */

const cssString = (text) => `"${text.replace(/["\\]/g, '\\$&').replace(/\n/g, ' ')}"`;

// The CSS declarations that draw text in `format`.
export function presetCss(format, size = `${format.size}pt`) {
  return (
    `font-family: ${cssString(format.font)}; font-size: ${size}; ` +
    `font-weight: ${format.bold ? 'bold' : 'normal'}; font-style: ${format.italic ? 'italic' : 'normal'}; ` +
    `text-decoration: ${format.underline ? 'underline' : 'none'};`
  );
}

const styleElement = document.createElement('style');
document.head.append(styleElement);

function renderStyles() {
  const rules = PRESETS.map((name) =>
    name === 'standard'
      ? `.ProseMirror { ${presetCss(presets.standard)} }`
      : `.ProseMirror p[data-preset="${name}"] { ${presetCss(presets[name])} }`,
  );
  styleElement.textContent = rules.join('\n');
}
renderStyles();

/* ---------- The paragraph's preset ---------- */

const HEADING_TAG = /^H([1-6])$/;

// Paragraphs carry their preset (null for Standard). Headings pasted from a
// web page (<h1> to <h6>) become the matching heading. Pressing Enter at the
// end of a heading starts a Standard paragraph, as in Word.
export const PresetParagraph = Paragraph.extend({
  // Ctrl+B, Ctrl+I and Ctrl+U do nothing where the preset already sets that
  // style, matching the greyed-out toolbar buttons. (Ahead of the Bold,
  // Italic and Underline extensions, which come later in the list.)
  addKeyboardShortcuts() {
    const locked = (name) => () => lockedStyles(this.editor.state)[name];
    return { ...this.parent?.(), 'Mod-b': locked('bold'), 'Mod-i': locked('italic'), 'Mod-u': locked('underline') };
  },

  parseHTML() {
    return [{ tag: 'p' }, ...[1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}` }))];
  },

  addAttributes() {
    return {
      ...this.parent?.(),
      preset: {
        default: null,
        keepOnSplit: false,
        parseHTML: (element) => {
          const preset = element.getAttribute('data-preset');
          if (PRESETS.includes(preset) && preset !== 'standard') return preset;
          const heading = HEADING_TAG.exec(element.tagName);
          return heading ? `h${heading[1]}` : null;
        },
        renderHTML: (attrs) => (attrs.preset ? { 'data-preset': attrs.preset } : {}),
      },
    };
  },
});

// Bold, italic and underline that the preset at the cursor already gives its
// text, as { bold, italic, underline }. Text can't be made un-bold (and so
// on) against its preset, so these can't be toggled there.
export function lockedStyles(state) {
  const { bold, italic, underline } = presetFormat(currentPreset(state));
  return { bold, italic, underline };
}

// The preset of the first paragraph in the selection ('standard' if none).
export function currentPreset(state) {
  let preset = null;
  let found = false;
  const { from, to } = state.selection;
  state.doc.nodesBetween(from, Math.max(to, from + 1), (node) => {
    if (!found && node.type.name === 'paragraph') {
      found = true;
      preset = node.attrs.preset;
    }
    return !found;
  });
  return preset ?? 'standard';
}

// Gives every paragraph the selection touches (including those in selected
// table cells) the preset. Fonts and sizes set on their text are cleared, so
// the preset shows; bold, italic and underline set on words are kept.
export function applyPreset(editor, name) {
  const value = name === 'standard' ? null : name;
  return editor
    .chain()
    .focus()
    .command(({ tr }) => {
      const textStyle = tr.doc.type.schema.marks.textStyle;
      for (const { $from, $to } of tr.selection.ranges) {
        tr.doc.nodesBetween($from.pos, Math.max($to.pos, $from.pos + 1), (node, pos) => {
          if (node.type.name !== 'paragraph') return true;
          // Neither step changes the document's size, so positions hold.
          tr.setNodeMarkup(pos, null, { ...node.attrs, preset: value });
          tr.removeMark(pos + 1, pos + node.nodeSize - 1, textStyle);
          return false;
        });
      }
      tr.removeStoredMark(textStyle);
      return true;
    })
    .run();
}

/* ---------- The Preset button, its menu, and the dialog to change one ---------- */

// The largest size a preset is shown at in the menu, so Title doesn't swamp it.
const MENU_MAX_PX = 24;

const byId = (id) => document.getElementById(id);

export function setupPresets(editor, { fontSelect }) {
  const button = byId('preset');
  const buttonLabel = byId('preset-label');
  const menu = byId('preset-menu');
  const list = byId('preset-list');

  const menuEntry = dropdown(button, menu, (name) => applyPreset(editor, name));

  function renderMenu() {
    const current = currentPreset(editor.state);
    list.replaceChildren(
      ...PRESETS.map((name) => {
        const format = presets[name];
        const item = document.createElement('button');
        item.type = 'button';
        item.setAttribute('role', 'menuitemradio');
        item.setAttribute('aria-checked', name === current);
        item.dataset.action = name;
        item.title = 'Right-click to change this preset';

        const sample = document.createElement('span');
        sample.className = 'preset-sample';
        const px = (format.size * 96) / 72;
        sample.style.cssText = presetCss(format, `${Math.min(px, MENU_MAX_PX)}px`);
        sample.textContent = PRESET_LABELS[name];

        const size = document.createElement('span');
        size.className = 'shortcut';
        size.textContent = `${format.font}, ${format.size} pt`;

        item.append(sample, size);
        return item;
      }),
    );
  }

  // The button shows the preset at the cursor; the menu ticks it.
  let shown = null;
  function sync() {
    const current = currentPreset(editor.state);
    if (current === shown) return;
    shown = current;
    buttonLabel.textContent = PRESET_LABELS[current];
    for (const item of list.children) item.setAttribute('aria-checked', item.dataset.action === current);
  }

  // Right-clicking a preset in the menu opens the dialog to change it.
  menu.addEventListener('contextmenu', (event) => {
    const item = event.target.closest('button[data-action]');
    if (!item) return;
    event.preventDefault();
    menuEntry.close();
    openDialog(item.dataset.action);
  });

  /* The dialog */

  const dialog = byId('preset-dialog');
  const fields = {
    font: byId('preset-font'),
    size: byId('preset-size'),
    bold: byId('preset-bold'),
    italic: byId('preset-italic'),
    underline: byId('preset-underline'),
  };
  const preview = byId('preset-preview');
  const resetButton = byId('preset-reset');
  fields.size.min = MIN_SIZE;
  fields.size.max = MAX_SIZE;
  // Not a submit button, so Enter in the size box means OK, not this.
  resetButton.addEventListener('click', () => dialog.close('reset'));

  const toggles = [fields.bold, fields.italic, fields.underline];
  for (const toggle of toggles) {
    toggle.addEventListener('click', () => {
      toggle.setAttribute('aria-pressed', toggle.getAttribute('aria-pressed') !== 'true');
      showPreview();
    });
  }
  fields.font.addEventListener('change', showPreview);
  fields.size.addEventListener('input', showPreview);

  const pressed = (toggle) => toggle.getAttribute('aria-pressed') === 'true';

  function dialogSettings() {
    return {
      font: fields.font.value,
      size: Number(fields.size.value),
      bold: pressed(fields.bold),
      italic: pressed(fields.italic),
      underline: pressed(fields.underline),
    };
  }

  function showPreview() {
    const settings = dialogSettings();
    const size = settings.size >= MIN_SIZE && settings.size <= MAX_SIZE ? settings.size : 12;
    preview.style.cssText = presetCss({ ...settings, size }, `${Math.min((size * 96) / 72, 48)}px`);
  }

  function openDialog(name) {
    const format = presets[name];
    byId('preset-dialog-title').textContent = `${PRESET_LABELS[name]} preset`;
    preview.textContent = PRESET_LABELS[name];

    // The installed fonts, as in the toolbar, each shown in its own font.
    const families = [...fontSelect.options].map((option) => option.value);
    if (!families.includes(format.font)) families.unshift(format.font);
    fields.font.replaceChildren(
      ...families.map((family) => {
        const option = new Option(family, family);
        option.style.fontFamily = `${cssString(family)}, var(--ui-font)`;
        return option;
      }),
    );
    fields.font.value = format.font;
    fields.size.value = format.size;
    fields.bold.setAttribute('aria-pressed', format.bold);
    fields.italic.setAttribute('aria-pressed', format.italic);
    fields.underline.setAttribute('aria-pressed', format.underline);
    resetButton.disabled = isDefaultPreset(name);
    showPreview();

    dialog.returnValue = '';
    dialog.showModal();
    dialog.addEventListener(
      'close',
      () => {
        if (dialog.returnValue === 'ok') setPreset(name, dialogSettings());
        else if (dialog.returnValue === 'reset') resetPreset(name);
        editor.commands.focus();
      },
      { once: true },
    );
  }

  onPresetsChange(() => {
    renderMenu();
    shown = null;
    sync();
  });
  renderMenu();
  sync();

  return {
    sync,
    // Opens the menu at a point, for the right-click menu.
    openMenuAt: (x, y) => menuEntry.openAt(x, y),
  };
}
