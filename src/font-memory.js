import { Extension, combineTransactionSteps, getChangedRanges } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

// A font or size lives on the text itself, so an empty line, or text pasted
// from elsewhere, has none and would fall back to the default. This remembers
// the font and size in use, so new text keeps them until another is chosen.

const key = new PluginKey('fontMemory');

// Headings and the title have their preset's font (src/presets.js), so the
// remembered font neither comes from them nor goes into them.
const hasPreset = (node) => Boolean(node.attrs.preset);

// The font and size at the cursor, or undefined if the cursor's line is empty
// and nothing has been chosen for it (so the remembered ones should stay).
function fontAtCursor(state) {
  const { selection, storedMarks } = state;
  if (!selection.empty) return undefined;
  const { $from } = selection;
  if (!$from.parent.isTextblock || hasPreset($from.parent)) return undefined;
  if (!storedMarks && $from.parent.content.size === 0) return undefined;

  const attrs = (storedMarks ?? $from.marks()).find((mark) => mark.type.name === 'textStyle')?.attrs;
  return { fontFamily: attrs?.fontFamily ?? null, fontSize: attrs?.fontSize ?? null };
}

function hasFont(font) {
  return Boolean(font?.fontFamily || font?.fontSize);
}

// Gives text in from..to the remembered font and size wherever it has none of its own.
function fillFont(tr, from, to, font) {
  const type = tr.doc.type.schema.marks.textStyle;
  tr.doc.nodesBetween(from, to, (node, pos, parent) => {
    if (!node.isText || hasPreset(parent)) return;
    const attrs = node.marks.find((mark) => mark.type === type)?.attrs ?? {};
    const filled = {
      ...attrs,
      fontFamily: attrs.fontFamily ?? font.fontFamily,
      fontSize: attrs.fontSize ?? font.fontSize,
    };
    if (filled.fontFamily === attrs.fontFamily && filled.fontSize === attrs.fontSize) return;
    tr.addMark(Math.max(pos, from), Math.min(pos + node.nodeSize, to), type.create(filled));
  });
}

export const FontMemory = Extension.create({
  name: 'fontMemory',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        state: {
          init: (_config, state) => fontAtCursor(state) ?? null,
          apply: (_tr, remembered, _oldState, state) => fontAtCursor(state) ?? remembered,
        },

        appendTransaction(transactions, oldState, state) {
          let tr = null;

          // Pasted or dropped text without a font of its own takes the one in
          // use where it was put (remembered from before the paste).
          const pastedFont = key.getState(oldState);
          const pasted = transactions.some((t) => t.getMeta('paste') || t.getMeta('uiEvent') === 'drop');
          if (pasted && hasFont(pastedFont)) {
            tr = state.tr;
            const changes = getChangedRanges(combineTransactionSteps(oldState.doc, transactions));
            for (const { newRange } of changes) fillFont(tr, newRange.from, newRange.to, pastedFont);
            if (!tr.docChanged) tr = null;
          }

          // An empty line keeps the remembered font, ready for typing.
          const font = key.getState(state);
          const { selection, storedMarks } = tr ?? state;
          const { $from } = selection;
          const { parent } = $from;
          if (hasFont(font) && selection.empty && !storedMarks && parent.isTextblock && !hasPreset(parent) && parent.content.size === 0) {
            const mark = state.schema.marks.textStyle.create(font);
            tr ??= state.tr.setMeta('addToHistory', false);
            tr.setStoredMarks([mark]);
          }
          return tr;
        },
      }),
    ];
  },
});
