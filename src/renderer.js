import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import Bold from '@tiptap/extension-bold';
import Italic from '@tiptap/extension-italic';
import Underline from '@tiptap/extension-underline';
import { TextStyle, FontFamily, FontSize } from '@tiptap/extension-text-style';
import { Gapcursor, TrailingNode, UndoRedo } from '@tiptap/extensions';
import { isInTable } from '@tiptap/pm/tables';
import { BULLET_SYMBOLS, bulletExtensions, setBulletSymbol } from './bullets.js';
import { imageExtensions, insertImageFiles } from './images.js';
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
const tableButton = byId('table');
const inTableButtons = [byId('split'), byId('add-row'), byId('add-column'), byId('delete-table')];

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
  ],
  // Turns off Markdown-style auto-formatting such as **bold**.
  enableInputRules: false,
  enablePasteRules: false,
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

  const inTable = isInTable(editor.state);
  tableButton.disabled = inTable;
  for (const button of inTableButtons) button.disabled = !inTable;
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
  fontSelect.replaceChildren(...unique.map((family) => new Option(family, family)));
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

const imageFileInput = byId('image-file');
byId('image').addEventListener('click', () => imageFileInput.click());
imageFileInput.addEventListener('change', () => {
  const files = [...imageFileInput.files];
  imageFileInput.value = ''; // So choosing the same file again still fires 'change'.
  insertImageFiles(editor, files).catch((error) => showMessage(error.message));
});

tableButton.addEventListener('click', async () => {
  const size = await askDimensions('Create table', { rows: 3, cols: 3 }, MAX_TABLE_ROWS);
  if (!size) return;
  if (size.cols > MAX_TABLE_COLS) showMessage(COLUMN_LIMIT_MESSAGE);
  else insertTable(editor, size.rows, size.cols);
});

byId('split').addEventListener('click', async () => {
  const size = await askDimensions('Split into', { rows: 2, cols: 2 }, MAX_SPLIT_ROWS);
  if (size && !splitCells(editor, size.rows, size.cols)) showMessage(COLUMN_LIMIT_MESSAGE);
});

byId('add-row').addEventListener('click', () => addRow(editor));
byId('add-column').addEventListener('click', () => {
  if (!addColumn(editor)) showMessage(COLUMN_LIMIT_MESSAGE);
});
byId('delete-table').addEventListener('click', () => editor.chain().focus().deleteTable().run());

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

  // Keep the whole menu on screen.
  const { width, height } = bulletMenu.getBoundingClientRect();
  bulletMenu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - width - 4))}px`;
  bulletMenu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - height - 4))}px`;
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

editor.on('transaction', syncToolbar);
syncToolbar();
loadFonts();
