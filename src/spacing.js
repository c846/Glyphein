import { Extension, findParentNode } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

// CSS line-height of "single" spacing, as in Word for Times New Roman.
// Keep in sync with the .ProseMirror rule in style.css.
const SINGLE_LINE = 1.15;

export const LINE_SPACINGS = [1, 1.15, 1.5, 2, 2.5, 3];
export const MAX_SPACE = 200; // pt

// Paragraphs: lineSpacing (a multiple of single spacing), spaceBefore and
// spaceAfter (points). Tables: spaceBefore and spaceAfter. null = the default:
// single spacing, no extra space.
//
// Space is drawn as padding rather than margin so that, as in Word, the space
// after one paragraph and before the next add up instead of overlapping.
const numberAttribute = (name, render) => ({
  default: null,
  parseHTML: (element) => {
    const value = parseFloat(element.getAttribute(`data-${name}`));
    return Number.isFinite(value) ? value : null;
  },
  renderHTML: (attrs) => {
    const value = attrs[name.replace(/-(\w)/g, (_, c) => c.toUpperCase())];
    return value == null ? {} : { [`data-${name}`]: value, style: render(value) };
  },
});

const spaceAttributes = {
  spaceBefore: numberAttribute('space-before', (pt) => `padding-top: ${pt}pt`),
  spaceAfter: numberAttribute('space-after', (pt) => `padding-bottom: ${pt}pt`),
};

const tableStyle = ({ spaceBefore, spaceAfter }) =>
  [spaceBefore && `padding-top: ${spaceBefore}pt`, spaceAfter && `padding-bottom: ${spaceAfter}pt`]
    .filter(Boolean)
    .join('; ');

const tableSpacingKey = new PluginKey('tableSpacing');

const Spacing = Extension.create({
  name: 'spacing',

  addGlobalAttributes() {
    return [
      {
        types: ['paragraph'],
        attributes: {
          lineSpacing: numberAttribute('line-spacing', (m) => `line-height: ${+(m * SINGLE_LINE).toFixed(4)}`),
          ...spaceAttributes,
        },
      },
      { types: ['table'], attributes: spaceAttributes },
    ];
  },

  // Word's shortcuts.
  addKeyboardShortcuts() {
    const lines = (lineSpacing) => () => setSpacing(this.editor, { lineSpacing });
    return { 'Mod-1': lines(1), 'Mod-5': lines(1.5), 'Mod-2': lines(2) };
  },

  // A table is drawn inside a wrapper by its node view, which ignores the
  // table's own attributes, so its spacing is put on the wrapper here.
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: tableSpacingKey,
        props: {
          decorations(state) {
            const decorations = [];
            state.doc.descendants((node, pos) => {
              if (node.type.name !== 'table') return true;
              const style = tableStyle(node.attrs);
              if (style) decorations.push(Decoration.node(pos, pos + node.nodeSize, { style }));
              return false;
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});

const tableOf = (selection) => findParentNode((node) => node.type.name === 'table')(selection);

const orNull = (value, fallback) => (value === fallback ? null : value);

// Sets any of lineSpacing, spaceBefore and spaceAfter on every paragraph the
// selection touches (including those in selected table cells).
export function setSpacing(editor, spacing) {
  const attrs = {};
  if ('lineSpacing' in spacing) attrs.lineSpacing = orNull(spacing.lineSpacing, 1);
  if ('spaceBefore' in spacing) attrs.spaceBefore = orNull(spacing.spaceBefore, 0);
  if ('spaceAfter' in spacing) attrs.spaceAfter = orNull(spacing.spaceAfter, 0);
  return editor.chain().focus().updateAttributes('paragraph', attrs).run();
}

// Sets the space above and below the table the cursor is in.
export function setTableSpacing(editor, { spaceBefore, spaceAfter }) {
  const table = tableOf(editor.state.selection);
  if (!table) return false;
  return editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.setNodeMarkup(table.pos, null, {
        ...table.node.attrs,
        spaceBefore: orNull(spaceBefore, 0),
        spaceAfter: orNull(spaceAfter, 0),
      });
      return true;
    })
    .run();
}

// The spacing of the first paragraph in the selection, and of the table the
// cursor is in (or null), with defaults filled in.
export function currentSpacing(state) {
  let paragraph = null;
  const { from, to } = state.selection;
  state.doc.nodesBetween(from, Math.max(to, from + 1), (node) => {
    if (!paragraph && node.type.name === 'paragraph') paragraph = node;
    return !paragraph;
  });
  const attrs = paragraph?.attrs ?? {};
  const table = tableOf(state.selection)?.node.attrs;
  return {
    lineSpacing: attrs.lineSpacing ?? 1,
    spaceBefore: attrs.spaceBefore ?? 0,
    spaceAfter: attrs.spaceAfter ?? 0,
    table: table ? { spaceBefore: table.spaceBefore ?? 0, spaceAfter: table.spaceAfter ?? 0 } : null,
  };
}

export const spacingExtension = Spacing;
