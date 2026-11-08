import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import Bold from '@tiptap/extension-bold';
import Italic from '@tiptap/extension-italic';
import Underline from '@tiptap/extension-underline';
import { TextStyle, FontFamily, FontSize } from '@tiptap/extension-text-style';
import { Gapcursor, TrailingNode, UndoRedo } from '@tiptap/extensions';
import { Selection } from '@tiptap/pm/state';
import { isInTable } from '@tiptap/pm/tables';
import { alignmentExtension, currentAlignment, setAlignment } from './alignment.js';
import { ThickCaret } from './caret.js';
import { BULLET_SYMBOLS, bulletExtensions, setBulletSymbol } from './bullets.js';
import { setupFiles } from './files.js';
import { imageExtensions, insertImageFiles } from './images.js';
import { closeMenusOnEscape, dropdown, openContextMenu, placeOnScreen } from './menus.js';
import './pages.js'; // Ctrl+Down and Ctrl+Up flip through pages
import { setupReference } from './reference.js';
import { MAX_SPACE, currentSpacing, setSpacing, setTableSpacing, spacingExtension } from './spacing.js';
import { Speller, Spellcheck, wordAt } from './spellcheck.js';
import {
  MAX_TABLE_COLS,
  addColumn,
  addRow,
  formatSelectedCells,
  insertTable,
  isCellSelection,
  selectedCellsFormat,
  splitCells,
  tableExtensions,
  toggleStyle,
} from './tables.js';

// Keep in sync with the .ProseMirror rule in style.css.
const DEFAULT_FONT = 'Times New Roman';
const DEFAULT_SIZE = 12;

const MAX_TABLE_ROWS = 100;
const MAX_SPLIT_ROWS = 20;
const COLUMN_LIMIT_MESSAGE = `A table cannot have more than ${MAX_TABLE_COLS} columns.`;

const byId = (id) => document.getElementById(id);

const fontSelect = byId('font');
const sizeInput = byId('size');
const styleButtons = { bold: byId('bold'), italic: byId('italic'), underline: byId('underline') };
const alignmentIcon = byId('alignment-icon');
const alignmentItems = byId('alignment-menu').querySelectorAll('[data-action]');
let shownAlignment = null;

const speller = new Speller();

const editor = new Editor({
  element: byId('document'),
  extensions: [
    Document,
    Paragraph,
    Text,
    Bold, // Ctrl+B
    Italic, // Ctrl+I
    Underline, // Ctrl+U
    TextStyle,
    FontFamily,
    FontSize,
    UndoRedo,
    TrailingNode, // Always leaves a line to type on after a table
    Gapcursor, // Lets the cursor sit before a table or between two tables
    ...tableExtensions,
    ...bulletExtensions((pos, point) => openBulletMenu(pos, point)),
    ...imageExtensions((error) => showMessage(error.message)),
    Spellcheck.configure({ speller }),
    alignmentExtension, // Ctrl+L, Ctrl+E, Ctrl+R, Ctrl+J
    spacingExtension, // Ctrl+1, Ctrl+5, Ctrl+2
    ThickCaret,
  ],
  // Turns off Markdown-style auto-formatting such as **bold**.
  enableInputRules: false,
  enablePasteRules: false,
  editorProps: {
    // When the cursor is scrolled into view, keep it clear of the toolbar,
    // which floats over the top of the pages (--toolbar-bottom in style.css).
    scrollMargin: { top: 70, bottom: 24, left: 0, right: 0 },
    scrollThreshold: { top: 70, bottom: 24, left: 0, right: 0 },
  },
  autofocus: true,
});

// The formatting at the cursor, or of the selected cells.
function currentFormat() {
  if (isCellSelection(editor.state)) return selectedCellsFormat(editor.state);
  return {
    ...editor.getAttributes('textStyle'),
    bold: editor.isActive('bold'),
    italic: editor.isActive('italic'),
    underline: editor.isActive('underline'),
  };
}

// Makes the toolbar show the formatting at the cursor.
function syncToolbar() {
  const format = currentFormat();

  fontSelect.value = (format.fontFamily ?? DEFAULT_FONT).replace(/["']/g, '');

  // Don't overwrite a number while it's being typed.
  if (document.activeElement !== sizeInput) {
    sizeInput.value = format.fontSize ? parseFloat(format.fontSize) : DEFAULT_SIZE;
  }

  for (const [name, button] of Object.entries(styleButtons)) {
    button.setAttribute('aria-pressed', format[name]);
  }

  // The Alignment button shows the current alignment's icon, and its menu ticks it.
  const alignment = currentAlignment(editor);
  if (alignment !== shownAlignment) {
    shownAlignment = alignment;
    for (const item of alignmentItems) {
      const current = item.dataset.action === alignment;
      item.setAttribute('aria-checked', current);
      if (current) alignmentIcon.replaceChildren(item.querySelector('svg').cloneNode(true));
    }
  }
}

async function loadFonts() {
  let families = [];
  try {
    const fonts = await window.queryLocalFonts();
    families = fonts.map((font) => font.family);
  } catch (error) {
    console.error(`Could not read installed fonts: ${error.name}: ${error.message}`);
    // Try again the next time the mouse reaches the toolbar.
    byId('toolbar').addEventListener('mouseenter', loadFonts, { once: true });
  }

  const unique = [...new Set([DEFAULT_FONT, ...families])];
  unique.sort((a, b) => a.localeCompare(b));
  fontSelect.replaceChildren(
    ...unique.map((family) => {
      // Each name is shown in its own font, as a preview.
      const option = new Option(family, family);
      option.style.fontFamily = `"${family}", var(--ui-font)`;
      return option;
    }),
  );
  syncToolbar();
}

// `attrs` is { fontFamily } or { fontSize }.
function setTextStyle(attrs) {
  if (isCellSelection(editor.state)) formatSelectedCells(editor, attrs);
  else editor.chain().focus().setMark('textStyle', attrs).run();
}

function showMessage(text) {
  const dialog = byId('message');
  byId('message-text').textContent = text;
  dialog.showModal();
  dialog.addEventListener('close', () => editor.commands.focus(), { once: true });
}

// Asks for rows and columns. Resolves to null if cancelled.
function askDimensions(title, defaults, maxRows) {
  const dialog = byId('dimensions');
  const rowsInput = byId('dimension-rows');
  const colsInput = byId('dimension-cols');

  byId('dimensions-title').textContent = title;
  rowsInput.value = defaults.rows;
  rowsInput.max = maxRows;
  colsInput.value = defaults.cols;
  dialog.returnValue = '';
  dialog.showModal();

  return new Promise((resolve) => {
    dialog.addEventListener(
      'close',
      () => {
        const confirmed = dialog.returnValue === 'ok';
        if (!confirmed) editor.commands.focus();
        resolve(confirmed ? { rows: Number(rowsInput.value), cols: Number(colsInput.value) } : null);
      },
      { once: true },
    );
  });
}

fontSelect.addEventListener('change', () => {
  setTextStyle({ fontFamily: `"${fontSelect.value}"` });
});

sizeInput.addEventListener('change', () => {
  const size = parseFloat(sizeInput.value);
  if (size >= 1 && size <= 400) {
    setTextStyle({ fontSize: `${size}pt` });
  } else {
    sizeInput.blur();
    syncToolbar();
  }
});

// Stops clicks on buttons from taking focus away from the document.
byId('toolbar').addEventListener('mousedown', (event) => {
  if (event.target.closest('button')) event.preventDefault();
});

for (const [name, button] of Object.entries(styleButtons)) {
  button.addEventListener('click', () => toggleStyle(editor, name));
}

dropdown(byId('alignment'), byId('alignment-menu'), (name) => setAlignment(editor, name));

// Opens the spacing dialog on the current values, and applies what's changed.
function openSpacingDialog() {
  const dialog = byId('spacing-dialog');
  const fields = {
    lineSpacing: byId('line-spacing'),
    spaceBefore: byId('space-before'),
    spaceAfter: byId('space-after'),
  };
  const tableFields = { spaceBefore: byId('table-space-before'), spaceAfter: byId('table-space-after') };

  const current = currentSpacing(editor.state);
  // A custom value from elsewhere (e.g. pasted) is shown as the nearest choice.
  const choices = [...fields.lineSpacing.options].map((option) => Number(option.value));
  const nearest = choices.reduce((a, b) => (Math.abs(b - current.lineSpacing) < Math.abs(a - current.lineSpacing) ? b : a));
  fields.lineSpacing.value = String(nearest);
  fields.spaceBefore.value = current.spaceBefore;
  fields.spaceAfter.value = current.spaceAfter;

  byId('table-spacing').hidden = !current.table;
  for (const [name, input] of Object.entries(tableFields)) {
    input.value = current.table?.[name] ?? 0;
    input.disabled = !current.table; // So a hidden field can't block the form.
  }
  for (const input of [fields.spaceBefore, fields.spaceAfter, ...Object.values(tableFields)]) input.max = MAX_SPACE;

  dialog.returnValue = '';
  dialog.showModal();
  dialog.addEventListener(
    'close',
    () => {
      if (dialog.returnValue !== 'ok') {
        editor.commands.focus();
        return;
      }
      // Only what was changed is applied, so a selection with mixed spacing
      // keeps whatever wasn't touched.
      const changes = {};
      const lineSpacing = Number(fields.lineSpacing.value);
      if (lineSpacing !== nearest) changes.lineSpacing = lineSpacing;
      for (const name of ['spaceBefore', 'spaceAfter']) {
        const value = Number(fields[name].value);
        if (value !== current[name]) changes[name] = value;
      }
      if (Object.keys(changes).length) setSpacing(editor, changes);

      if (current.table) {
        const table = { spaceBefore: Number(tableFields.spaceBefore.value), spaceAfter: Number(tableFields.spaceAfter.value) };
        if (table.spaceBefore !== current.table.spaceBefore || table.spaceAfter !== current.table.spaceAfter) {
          setTableSpacing(editor, table);
        }
      }
      editor.commands.focus();
    },
    { once: true },
  );
}

const imageFileInput = byId('image-file');
imageFileInput.addEventListener('change', () => {
  const files = [...imageFileInput.files];
  imageFileInput.value = ''; // So choosing the same file again still fires 'change'.
  insertImageFiles(editor, files).catch((error) => showMessage(error.message));
});

async function createTable() {
  const size = await askDimensions('Create table', { rows: 3, cols: 3 }, MAX_TABLE_ROWS);
  if (!size) return;
  if (size.cols > MAX_TABLE_COLS) showMessage(COLUMN_LIMIT_MESSAGE);
  else insertTable(editor, size.rows, size.cols);
}

async function splitSelectedCells() {
  const size = await askDimensions('Split into', { rows: 2, cols: 2 }, MAX_SPLIT_ROWS);
  if (size && !splitCells(editor, size.rows, size.cols)) showMessage(COLUMN_LIMIT_MESSAGE);
}

/* ---------- Right-click menu ---------- */

// Moves the cursor to where the page was right-clicked, unless that's inside
// the selection (so a selection, or selected table cells, can be acted on).
// Returns the document position clicked, or null if it's off the text.
function moveCursorForMenu(event) {
  const hit = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!hit) return null;
  const { state } = editor;
  const { from, to } = state.selection;
  const inSelection = event.target.closest?.('.selectedCell') || (hit.pos >= from && hit.pos <= to);
  if (!inSelection) editor.view.dispatch(state.tr.setSelection(Selection.near(state.doc.resolve(hit.pos))));
  return hit.pos;
}

// The menu's own items, which depend on what was clicked.
function pageMenuItems({ onImage }) {
  const { state } = editor;
  const inTable = isInTable(state);
  const onText = !onImage && state.selection.$from.parent.isTextblock;
  const inBullet = editor.isActive('bulletList');

  return [
    // A table can't go inside another table.
    { label: 'Insert Table…', action: createTable, disabled: inTable },
    ...(inTable
      ? [
          { label: 'Split…', action: splitSelectedCells },
          { label: 'Add Row', action: () => addRow(editor) },
          {
            label: 'Add Column',
            action: () => {
              if (!addColumn(editor)) showMessage(COLUMN_LIMIT_MESSAGE);
            },
          },
          { label: 'Delete Table', action: () => editor.chain().focus().deleteTable().run() },
        ]
      : []),
    ...(onText ? [{ label: 'Spacing…', action: openSpacingDialog }] : []),
    { label: 'Insert Image…', action: () => imageFileInput.click() },
    {
      label: inBullet ? 'Remove Bullet' : 'Insert Bullet',
      shortcut: 'Ctrl+Shift+8',
      action: () => editor.chain().focus().toggleBulletList().run(),
    },
  ];
}

// Counts menu requests, so a slow word lookup can't open a menu that's been superseded.
let menuRequest = 0;

editor.view.dom.addEventListener('contextmenu', async (event) => {
  event.preventDefault();
  const request = ++menuRequest;

  // From the mouse, the menu opens where clicked; from the keyboard (the Menu
  // key or Shift+F10), it opens at the cursor.
  let x = event.clientX;
  let y = event.clientY;
  let pos;
  if (event.button === 2) {
    pos = moveCursorForMenu(event);
  } else {
    pos = editor.state.selection.head;
    const coords = editor.view.coordsAtPos(pos);
    x = coords.left;
    y = coords.bottom + 2;
  }

  const onImage = Boolean(event.button === 2 && event.target.closest?.('img, [data-resize-container]'));
  const range = pos === null || onImage ? null : wordAt(editor.state, pos);
  const wordItems = range ? await reference.wordMenuItems(range) : [];
  if (request !== menuRequest) return;

  openContextMenu([...wordItems, 'separator', ...pageMenuItems({ onImage })], x, y);
});
// A new right-click supersedes a lookup still under way for the last one.
document.addEventListener('mousedown', () => menuRequest++, true);

/* ---------- Bullet symbol menu ---------- */

const bulletMenu = byId('bullet-menu');
const bulletCustom = byId('bullet-custom');
// Position of the bullet list the menu is changing.
let bulletMenuPos = null;

function openBulletMenu(pos, { x, y }) {
  bulletMenuPos = pos;
  const current = editor.state.doc.nodeAt(pos).attrs.symbol;
  for (const button of byId('bullet-symbols').children) {
    button.setAttribute('aria-pressed', button.textContent === current);
  }
  bulletCustom.value = '';
  bulletMenu.hidden = false;
  placeOnScreen(bulletMenu, x, y);
}

function closeBulletMenu() {
  if (bulletMenu.hidden) return;
  bulletMenu.hidden = true;
  bulletMenuPos = null;
  editor.commands.focus();
}

function chooseBullet(symbol) {
  const pos = bulletMenuPos;
  closeBulletMenu();
  if (pos !== null) setBulletSymbol(editor, pos, symbol);
}

byId('bullet-symbols').replaceChildren(
  ...BULLET_SYMBOLS.map((symbol) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = symbol;
    button.addEventListener('click', () => chooseBullet(symbol));
    return button;
  }),
);
byId('bullet-default').addEventListener('click', () => chooseBullet(null));

// Any character typed or pasted, such as one from the Windows symbol panel (Win + .).
byId('bullet-custom-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const [first] = new Intl.Segmenter().segment(bulletCustom.value.trim());
  if (first) chooseBullet(first.segment);
});

// Capture phase, so it runs before a click on another bullet reopens the menu.
document.addEventListener(
  'mousedown',
  (event) => {
    if (!bulletMenu.hidden && !bulletMenu.contains(event.target)) closeBulletMenu();
  },
  true,
);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeBulletMenu();
});
// The saved position goes stale once the document changes.
editor.on('update', closeBulletMenu);

const reference = setupReference(editor, speller);
dropdown(byId('lexicon'), byId('lexicon-menu'), (name) => reference.toggleTab(name));

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && closeMenusOnEscape()) editor.commands.focus();
});

setupFiles(editor, { defaults: { font: DEFAULT_FONT, size: DEFAULT_SIZE }, showMessage });

editor.on('transaction', syncToolbar);
syncToolbar();
loadFonts();
