import { Extension, findParentNode } from '@tiptap/core';
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import {
  CellSelection,
  TableMap,
  cellAround,
  columnResizingPluginKey,
  inSameTable,
  isInTable,
  selectedRect,
  selectionCell,
} from '@tiptap/pm/tables';

// Width of the text area on a page: 6.5in at 96 pixels per inch.
const TEXT_WIDTH = 624;
const MIN_ROW_HEIGHT = 20;
// A little under the page's 9in text height, so a row always fits on one page.
const MAX_ROW_HEIGHT = 860;
const MIN_COLUMN_WIDTH = 25;
// The most columns that fit on the page at the minimum width.
export const MAX_TABLE_COLS = 24;
// How close to a cell border, in pixels, counts as grabbing it.
const EDGE = 5;
const MARK_STYLES = ['bold', 'italic', 'underline'];

export const isCellSelection = (state) => state.selection instanceof CellSelection;

/* ---------- Cell formatting ---------- */

// Text formatting lives on the text, so an empty cell has nothing to hold it.
// Each cell therefore also remembers its format, which is applied when typing
// starts in an empty paragraph of that cell.
const cellFormatAttribute = {
  format: {
    default: null,
    parseHTML: (element) => JSON.parse(element.getAttribute('data-format')),
    renderHTML: ({ format }) => (format ? { 'data-format': JSON.stringify(format) } : {}),
  },
};

const withCellFormat = (node) =>
  node.extend({
    addAttributes() {
      return { ...this.parent?.(), ...cellFormatAttribute };
    },
  });

function formatToMarks(schema, format) {
  const marks = MARK_STYLES.filter((name) => format[name]).map((name) => schema.marks[name].create());
  const { fontFamily, fontSize } = format;
  if (fontFamily || fontSize) marks.push(schema.marks.textStyle.create({ fontFamily, fontSize }));
  return marks;
}

// The format a new cell should copy from `cell`: that of its text if it has
// any, otherwise the format the cell remembers.
function formatOfCell(cell) {
  let firstText = null;
  cell.descendants((node) => {
    if (node.isText) firstText ??= node;
  });
  if (!firstText) return cell.attrs.format;

  const format = {};
  for (const mark of firstText.marks) {
    if (MARK_STYLES.includes(mark.type.name)) format[mark.type.name] = true;
    if (mark.type.name === 'textStyle') {
      if (mark.attrs.fontFamily) format.fontFamily = mark.attrs.fontFamily;
      if (mark.attrs.fontSize) format.fontSize = mark.attrs.fontSize;
    }
  }
  return Object.keys(format).length ? format : null;
}

function cellHasStyle(cell, name) {
  let hasText = false;
  let allMarked = true;
  cell.descendants((node) => {
    if (!node.isText) return;
    hasText = true;
    allMarked &&= node.marks.some((mark) => mark.type.name === name);
  });
  return hasText ? allMarked : Boolean(cell.attrs.format?.[name]);
}

function firstTextStyle(cell) {
  let attrs = null;
  cell.descendants((node) => {
    attrs ??= node.marks.find((mark) => mark.type.name === 'textStyle')?.attrs ?? null;
  });
  return attrs;
}

// The format the toolbar should show for the selected cells.
export function selectedCellsFormat(state) {
  const cells = [];
  state.selection.forEachCell((cell) => cells.push(cell));

  const textStyle = firstTextStyle(cells[0]);
  const format = {
    fontFamily: textStyle?.fontFamily ?? cells[0].attrs.format?.fontFamily,
    fontSize: textStyle?.fontSize ?? cells[0].attrs.format?.fontSize,
  };
  for (const name of MARK_STYLES) {
    format[name] = cells.every((cell) => cellHasStyle(cell, name));
  }
  return format;
}

// `format` holds any of: fontFamily, fontSize, bold, italic, underline.
export function formatSelectedCells(editor, format) {
  const chain = editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.selection.forEachCell((cell, pos) => {
        tr.setNodeMarkup(pos, null, { ...cell.attrs, format: { ...cell.attrs.format, ...format } });
      });
      return true;
    });

  for (const [name, value] of Object.entries(format)) {
    if (!MARK_STYLES.includes(name)) chain.setMark('textStyle', { [name]: value });
    else if (value) chain.setMark(name);
    else chain.unsetMark(name);
  }
  chain.run();
}

export function toggleStyle(editor, name) {
  if (isCellSelection(editor.state)) {
    formatSelectedCells(editor, { [name]: !selectedCellsFormat(editor.state)[name] });
    return true;
  }
  return editor.chain().focus().toggleMark(name).run();
}

const CellFormatting = Extension.create({
  name: 'cellFormatting',
  priority: 1000,

  // Whole cells need these shortcuts to update the cell as well as its text.
  addKeyboardShortcuts() {
    const shortcut = (name) => () => isCellSelection(this.editor.state) && toggleStyle(this.editor, name);
    return { 'Mod-b': shortcut('bold'), 'Mod-i': shortcut('italic'), 'Mod-u': shortcut('underline') };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('cellFormatting'),
        appendTransaction(_transactions, _oldState, state) {
          const { selection, storedMarks, schema } = state;
          const { $from } = selection;
          if (!selection.empty || storedMarks || $from.parent.content.size > 0) return null;

          for (let depth = $from.depth; depth > 0; depth--) {
            const format = $from.node(depth).attrs.format;
            if (!format) continue;
            const marks = formatToMarks(schema, format);
            return marks.length ? state.tr.setStoredMarks(marks).setMeta('addToHistory', false) : null;
          }
          return null;
        },
      }),
    ];
  },
});

/* ---------- Creating tables ---------- */

function evenWidths(count) {
  const width = Math.floor(TEXT_WIDTH / count);
  return Array.from({ length: count }, (_, index) => (index < TEXT_WIDTH % count ? width + 1 : width));
}

export function insertTable(editor, rows, cols) {
  const widths = evenWidths(cols);
  editor
    .chain()
    .focus()
    .insertTable({ rows, cols, withHeaderRow: false })
    .command(({ tr }) => {
      const table = findParentNode((node) => node.type.name === 'table')(tr.selection);
      table.node.descendants((node, pos, _parent, column) => {
        if (node.type.name === 'tableRow') return true;
        tr.setNodeMarkup(table.start + pos, null, { ...node.attrs, colwidth: [widths[column]] });
        return false;
      });
      return true;
    })
    .run();
}

/* ---------- Column widths ---------- */

const sum = (values) => values.reduce((total, value) => total + value, 0);

function columnWidths(table, map) {
  const widths = new Array(map.width).fill(null);
  for (const offset of new Set(map.map)) {
    const { left } = map.findCell(offset);
    table.nodeAt(offset).attrs.colwidth?.forEach((width, index) => {
      if (width) widths[left + index] = width;
    });
  }
  return widths.map((width) => width ?? TEXT_WIDTH / map.width);
}

// Sets every column's width. `tableStart` is the position just inside the table.
function applyColumnWidths(tr, tableStart, widths) {
  const table = tr.doc.nodeAt(tableStart - 1);
  const map = TableMap.get(table);
  for (const offset of new Set(map.map)) {
    const { left, right } = map.findCell(offset);
    const cell = table.nodeAt(offset);
    tr.setNodeMarkup(tableStart + offset, null, { ...cell.attrs, colwidth: widths.slice(left, right) });
  }
}

// Adjusts widths so every column is at least the minimum and the table fits the
// page. Columns below the minimum are raised, taking the space from the widest.
function fitColumnWidths(widths) {
  const total = sum(widths);
  const target = Math.min(TEXT_WIDTH, Math.max(total, widths.length * MIN_COLUMN_WIDTH));
  const scale = Math.min(1, TEXT_WIDTH / total);
  const next = widths.map((width) => Math.max(MIN_COLUMN_WIDTH, Math.round(width * scale)));

  for (let excess = sum(next) - target; excess > 0; excess--) {
    const widest = Math.max(...next);
    if (widest <= MIN_COLUMN_WIDTH) break;
    next[next.indexOf(widest)] -= 1;
  }
  return next;
}

/* ---------- Adding and deleting rows and columns ---------- */

function copyFormatToRow(tr, tableStart, row) {
  const table = tr.doc.nodeAt(tableStart - 1);
  const map = TableMap.get(table);

  for (let col = 0; col < map.width; col++) {
    const offset = map.map[row * map.width + col];
    const above = map.map[(row - 1) * map.width + col];
    if (offset === above) continue; // A taller cell reaching through this row.
    const cell = table.nodeAt(offset);
    tr.setNodeMarkup(tableStart + offset, null, { ...cell.attrs, format: formatOfCell(table.nodeAt(above)) });
  }

  const { height } = table.child(row - 1).attrs;
  if (height) {
    let pos = tableStart;
    for (let index = 0; index < row; index++) pos += table.child(index).nodeSize;
    tr.setNodeMarkup(pos, null, { ...table.child(row).attrs, height });
  }
}

function copyFormatToColumn(tr, tableStart, col) {
  const table = tr.doc.nodeAt(tableStart - 1);
  const map = TableMap.get(table);

  for (let row = 0; row < map.height; row++) {
    const offset = map.map[row * map.width + col];
    const left = map.map[row * map.width + col - 1];
    if (offset === left) continue; // A wider cell reaching through this column.
    const cell = table.nodeAt(offset);
    tr.setNodeMarkup(tableStart + offset, null, { ...cell.attrs, format: formatOfCell(table.nodeAt(left)) });
  }
}

// Starts a command that adds a row below the selection, formatted like the row above it.
function addRowCommand(editor) {
  const { tableStart, bottom } = selectedRect(editor.state);
  return editor
    .chain()
    .focus()
    .addRowAfter()
    .command(({ tr }) => {
      copyFormatToRow(tr, tableStart, bottom);
      return true;
    });
}

export const addRow = (editor) => addRowCommand(editor).run();

// Adds a column to the right of the selection, formatted like the column before
// it. The table keeps its width: the new column gets an equal share and the
// others shrink in proportion. Returns false if the table is already at the limit.
export function addColumn(editor) {
  const { map, table, tableStart, right } = selectedRect(editor.state);
  if (map.width >= MAX_TABLE_COLS) return false;

  const widths = columnWidths(table, map);
  const total = sum(widths);
  const newWidth = Math.round(total / (map.width + 1));
  const next = widths.map((width) => Math.max(1, Math.round((width * (total - newWidth)) / total)));
  next.splice(right, 0, newWidth);
  next[next.length - 1] += total - sum(next);

  return editor
    .chain()
    .focus()
    .addColumnAfter()
    .command(({ tr }) => {
      copyFormatToColumn(tr, tableStart, right);
      applyColumnWidths(tr, tableStart, next);
      return true;
    })
    .run();
}

// Pressing Tab in the table's last cell adds a row and moves to its first cell.
// In any other cell this returns false, and Tab moves to the next cell as usual.
function addRowFromLastCell(editor) {
  const { state } = editor;
  if (!isInTable(state)) return false;

  const { map, tableStart } = selectedRect(state);
  const lastCell = map.map[map.map.length - 1];
  if (selectionCell(state).pos - tableStart !== lastCell) return false;

  return addRowCommand(editor)
    .command(({ tr }) => {
      const newMap = TableMap.get(tr.doc.nodeAt(tableStart - 1));
      const firstCell = newMap.map[(newMap.height - 1) * newMap.width];
      tr.setSelection(TextSelection.near(tr.doc.resolve(tableStart + firstCell + 1)));
      return true;
    })
    .scrollIntoView()
    .run();
}

// Delete removes cells only when whole rows at the bottom or whole columns at
// the right are selected. Returning false falls through to the default, which
// clears the selected cells, or removes the table if every cell is selected.
function deleteTableEnd(editor) {
  if (!isCellSelection(editor.state)) return false;

  const { map, table, tableStart, left, right, top, bottom } = selectedRect(editor.state);
  const wholeRows = left === 0 && right === map.width;
  const wholeColumns = top === 0 && bottom === map.height;
  if (wholeRows && wholeColumns) return false;

  if (wholeRows && bottom === map.height) return editor.chain().focus().deleteRow().run();

  if (wholeColumns && right === map.width) {
    // The column to the left takes the freed width, so the table keeps its width.
    const widths = columnWidths(table, map);
    const next = widths.slice(0, left);
    next[next.length - 1] += sum(widths.slice(left));

    return editor
      .chain()
      .focus()
      .deleteColumn()
      .command(({ tr }) => {
        applyColumnWidths(tr, tableStart, next);
        return true;
      })
      .run();
  }
  return false;
}

const TableKeys = Extension.create({
  name: 'tableKeys',
  priority: 1000,

  addKeyboardShortcuts() {
    const deleteEnd = () => deleteTableEnd(this.editor);
    return {
      Tab: () => addRowFromLastCell(this.editor),
      // Always handled in a table, or Shift+Tab in the first cell would leave the page.
      'Shift-Tab': () => {
        if (!isInTable(this.editor.state)) return false;
        this.editor.commands.goToPreviousCell();
        return true;
      },
      Delete: deleteEnd,
      Backspace: deleteEnd,
    };
  },
});

// Runs after every change, so no table can leave the page's text width however
// it was changed, including by pasting.
const TableFit = Extension.create({
  name: 'tableFit',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('tableFit'),
        appendTransaction(transactions, _oldState, state) {
          if (!transactions.some((transaction) => transaction.docChanged)) return null;

          const { tr } = state;
          state.doc.forEach((node, pos) => {
            if (node.type.name !== 'table') return;

            const map = TableMap.get(node);
            const widths = columnWidths(node, map);
            const fitted = fitColumnWidths(widths);
            const allSet = map.map.every((offset) => node.nodeAt(offset).attrs.colwidth);
            const alreadyFits = widths.every((width, index) => width === fitted[index]);
            if (!allSet || !alreadyFits) applyColumnWidths(tr, pos + 1, fitted);
          });
          return tr.docChanged ? tr : null;
        },
      }),
    ];
  },
});

/* ---------- Splitting cells ---------- */

const sortedUnique = (values) => [...new Set(values)].sort((a, b) => a - b);
const indexOf = (values) => new Map(values.map((value, index) => [value, index]));

// Splits each selected cell into a rows x cols block of cells.
//
// A table is a shared grid, so the new lines also pass through neighbouring
// cells. To handle that, every cell is placed on a finer grid, where each old
// column is `cols` units wide and each old row is `rows` units tall. The chosen
// cells are divided on that grid, and the table is rebuilt from the lines that
// are in use. Neighbours simply end up spanning more of the new columns/rows.
// Returns false, changing nothing, if the table would pass the column limit.
export function splitCells(editor, rows, cols) {
  return editor
    .chain()
    .focus()
    .command(({ state, tr }) => {
      const rect = selectedRect(state);
      const { map, table, tableStart } = rect;
      const chosen = new Set(map.cellsInRect(rect));

      const pieces = [];
      for (const offset of new Set(map.map)) {
        const box = map.findCell(offset);
        const split = chosen.has(offset);
        const across = split ? cols : 1;
        const down = split ? rows : 1;
        const width = ((box.right - box.left) * cols) / across;
        const height = ((box.bottom - box.top) * rows) / down;

        for (let row = 0; row < down; row++) {
          for (let col = 0; col < across; col++) {
            const x0 = box.left * cols + col * width;
            const y0 = box.top * rows + row * height;
            pieces.push({
              cell: table.nodeAt(offset),
              keepsContent: row === 0 && col === 0,
              split,
              x0,
              y0,
              x1: x0 + width,
              y1: y0 + height,
            });
          }
        }
      }

      const xs = sortedUnique(pieces.flatMap((piece) => [piece.x0, piece.x1]));
      const ys = sortedUnique(pieces.flatMap((piece) => [piece.y0, piece.y1]));
      if (xs.length - 1 > MAX_TABLE_COLS) return false;

      const xIndex = indexOf(xs);
      const yIndex = indexOf(ys);

      const oldWidths = columnWidths(table, map);
      const newWidths = xs.slice(0, -1).map((x, index) => {
        let width = 0;
        for (let unit = x; unit < xs[index + 1]; unit++) width += oldWidths[Math.floor(unit / cols)] / cols;
        return Math.max(1, Math.round(width));
      });

      const oldHeights = [];
      table.forEach((row) => oldHeights.push(row.attrs.height));
      const newHeight = (y0, y1) => {
        let height = 0;
        for (let unit = y0; unit < y1; unit++) {
          const old = oldHeights[Math.floor(unit / rows)];
          if (old == null) return null;
          height += old / rows;
        }
        return Math.round(height);
      };

      const newRows = ys.slice(0, -1).map((y, index) => {
        const cells = pieces
          .filter((piece) => piece.y0 === y)
          .sort((a, b) => a.x0 - b.x0)
          .map((piece) => {
            const start = xIndex.get(piece.x0);
            const end = xIndex.get(piece.x1);
            const attrs = {
              ...piece.cell.attrs,
              colspan: end - start,
              rowspan: yIndex.get(piece.y1) - yIndex.get(piece.y0),
              colwidth: newWidths.slice(start, end),
              format: piece.keepsContent ? piece.cell.attrs.format : formatOfCell(piece.cell),
            };
            return piece.keepsContent
              ? piece.cell.type.create(attrs, piece.cell.content)
              : piece.cell.type.createAndFill(attrs);
          });
        return state.schema.nodes.tableRow.create({ height: newHeight(y, ys[index + 1]) }, cells);
      });

      const newTable = table.type.create(table.attrs, newRows);
      tr.replaceWith(tableStart - 1, tableStart - 1 + table.nodeSize, newTable);

      // Leave the cursor in the first new cell.
      const first = pieces.find((piece) => piece.split && piece.keepsContent);
      const newMap = TableMap.get(newTable);
      const offset = newMap.map[yIndex.get(first.y0) * newMap.width + xIndex.get(first.x0)];
      tr.setSelection(TextSelection.near(tr.doc.resolve(tableStart + offset + 1)));
      return true;
    })
    .run();
}

/* ---------- Mouse: selecting whole cells, dragging columns and rows ---------- */

const rowResizeKey = new PluginKey('rowResize');

// The table row whose bottom border the mouse is on, if any.
function rowEdgeAt(event) {
  const cell = event.target.closest?.('td, th');
  if (!cell) return null;

  const rect = cell.getBoundingClientRect();
  const onColumnEdge = event.clientX - rect.left <= EDGE || rect.right - event.clientX <= EDGE;
  if (onColumnEdge) return null;

  const rows = cell.closest('table').rows;
  const index = cell.parentElement.rowIndex;
  if (rect.bottom - event.clientY <= EDGE) return rows[index + cell.rowSpan - 1];
  if (event.clientY - rect.top <= EDGE && index > 0) return rows[index - 1];
  return null;
}

function startRowDrag(view, row, startEvent) {
  const pos = view.posAtDOM(row, 0) - 1;
  const startHeight = row.getBoundingClientRect().height;
  let moved = false;

  const onMove = (event) => {
    moved = true;
    const wanted = startHeight + event.clientY - startEvent.clientY;
    const height = Math.min(MAX_ROW_HEIGHT, Math.max(MIN_ROW_HEIGHT, wanted));
    view.dispatch(view.state.tr.setMeta(rowResizeKey, { pos, height }));
  };

  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    document.body.classList.remove('row-resize');
    if (!moved) return;

    // Measure the result, since a row can't get shorter than its text.
    const height = Math.round(row.getBoundingClientRect().height);
    const node = view.state.doc.nodeAt(pos);
    view.dispatch(view.state.tr.setMeta(rowResizeKey, null).setNodeMarkup(pos, null, { ...node.attrs, height }));
  };

  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

// Dragging a column border moves width between the two columns beside it, so
// the table's total width never changes.
function startColumnDrag(view, handle, startEvent) {
  const $cell = view.state.doc.resolve(handle);
  const table = $cell.node(-1);
  const tableStart = $cell.start(-1);
  const map = TableMap.get(table);
  const column = map.colCount(handle - tableStart) + $cell.nodeAfter.attrs.colspan - 1;

  const widths = columnWidths(table, map);
  const left = widths[column];
  const right = widths[column + 1];
  const cols = view.nodeDOM(tableStart - 1).querySelectorAll('col');
  let delta = 0;

  document.body.classList.add('col-resize');

  const onMove = (event) => {
    const wanted = Math.round(event.clientX - startEvent.clientX);
    delta = Math.min(right - MIN_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH - left, wanted));
    cols[column].style.width = `${left + delta}px`;
    cols[column + 1].style.width = `${right - delta}px`;
  };

  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    document.body.classList.remove('col-resize');
    if (delta === 0) return;

    const next = [...widths];
    next[column] = left + delta;
    next[column + 1] = right - delta;
    const { tr } = view.state;
    applyColumnWidths(tr, tableStart, next);
    view.dispatch(tr);
  };

  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

// Ctrl+click selects a whole cell. Keep dragging to select a block of cells.
function startCellSelection(view, startEvent) {
  const cellAt = (target) => {
    const cell = target.closest?.('td, th');
    if (!cell || !view.dom.contains(cell)) return null;
    return cellAround(view.state.doc.resolve(view.posAtDOM(cell, 0)));
  };

  const $anchor = cellAt(startEvent.target);
  if (!$anchor) return false;

  const select = ($head) => {
    const selection = CellSelection.create(view.state.doc, $anchor.pos, $head.pos);
    if (!selection.eq(view.state.selection)) view.dispatch(view.state.tr.setSelection(selection));
  };

  const onMove = (event) => {
    const $head = cellAt(event.target);
    if ($head && inSameTable($anchor, $head)) select($head);
  };

  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };

  startEvent.preventDefault();
  select($anchor);
  view.focus();
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  return true;
}

const TableMouse = Extension.create({
  name: 'tableMouse',
  priority: 1000,

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: rowResizeKey,
        state: {
          init: () => null,
          apply(tr, drag) {
            const meta = tr.getMeta(rowResizeKey);
            return meta === undefined ? drag : meta;
          },
        },
        props: {
          // Shows the new height live, without touching the document until the
          // drag ends, so a whole drag is one undo step.
          decorations(state) {
            const drag = rowResizeKey.getState(state);
            if (!drag) return null;
            const end = drag.pos + state.doc.nodeAt(drag.pos).nodeSize;
            return DecorationSet.create(state.doc, [
              Decoration.node(drag.pos, end, { style: `height: ${drag.height}px` }),
            ]);
          },
          handleDOMEvents: {
            mousemove(view, event) {
              if (!rowResizeKey.getState(view.state)) {
                document.body.classList.toggle('row-resize', Boolean(rowEdgeAt(event)));
              }
              return false;
            },
            mousedown(view, event) {
              if (event.button !== 0) return false;
              if (event.ctrlKey) return startCellSelection(view, event);

              const handle = columnResizingPluginKey.getState(view.state)?.activeHandle ?? -1;
              if (handle > -1) {
                event.preventDefault();
                startColumnDrag(view, handle, event);
                return true;
              }

              const row = rowEdgeAt(event);
              if (!row) return false;
              event.preventDefault();
              startRowDrag(view, row, event);
              return true;
            },
          },
        },
      }),
    ];
  },
});

/* ---------- Everything the editor needs ---------- */

const RowWithHeight = TableRow.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      height: {
        default: null,
        parseHTML: (element) => parseFloat(element.style.height) || null,
        renderHTML: ({ height }) => (height ? { style: `height: ${height}px` } : {}),
      },
    };
  },
});

export const tableExtensions = [
  // The library only finds the column borders. Dragging them is startColumnDrag.
  Table.configure({
    resizable: true,
    handleWidth: EDGE,
    cellMinWidth: MIN_COLUMN_WIDTH,
    lastColumnResizable: false,
  }),
  RowWithHeight,
  withCellFormat(TableCell),
  withCellFormat(TableHeader),
  CellFormatting,
  TableKeys,
  TableFit,
  TableMouse,
];
