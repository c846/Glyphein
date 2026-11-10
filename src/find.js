import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

// Find (Ctrl+F): a bar under the toolbar that highlights every match in the
// document, ignoring case, and steps through them with Enter and Shift+Enter
// (or F3 and Shift+F3). The current match is selected, so closing the bar
// leaves the cursor on it.

const key = new PluginKey('find');

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every match of `query` in the document, as [{ from, to }], in order. A
// match never runs from one paragraph into the next.
function findMatches(doc, query) {
  if (!query) return [];
  const pattern = new RegExp(escapeRegExp(query), 'giu');
  const matches = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // Each character of the text is one position in the document; a picture
    // stands in as one character that can't match.
    const text = node.textBetween(0, node.content.size, '', '￼');
    for (const match of text.matchAll(pattern)) {
      const from = pos + 1 + match.index;
      matches.push({ from, to: from + match[0].length });
    }
    return false;
  });
  return matches;
}

// The first match at or after `pos`, wrapping round to the first.
function matchFrom(matches, pos) {
  const index = matches.findIndex((match) => match.from >= pos);
  return index === -1 ? 0 : index;
}

const EMPTY = { query: '', matches: [], index: -1 };

export const Find = Extension.create({
  name: 'find',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        state: {
          init: () => EMPTY,
          apply(tr, value) {
            const meta = tr.getMeta(key);
            if (meta) {
              if (!meta.query) return EMPTY;
              const matches = meta.query === value.query && !tr.docChanged ? value.matches : findMatches(tr.doc, meta.query);
              const index = matches.length ? Math.min(meta.index ?? 0, matches.length - 1) : -1;
              return { query: meta.query, matches, index };
            }
            if (!tr.docChanged || !value.query) return value;
            // Typing while matches are showing: look again, staying near the current one.
            const matches = findMatches(tr.doc, value.query);
            const current = value.matches[value.index];
            const index = !matches.length ? -1 : current ? matchFrom(matches, tr.mapping.map(current.from)) : 0;
            return { ...value, matches, index };
          },
        },
        props: {
          decorations(state) {
            const { matches, index } = key.getState(state);
            if (!matches.length) return null;
            return DecorationSet.create(
              state.doc,
              matches.map((match, i) =>
                Decoration.inline(match.from, match.to, { class: i === index ? 'find-match find-current' : 'find-match' }),
              ),
            );
          },
        },
      }),
    ];
  },
});

// Shows the match at `index` (or clears the matches if there's no query),
// selecting it and scrolling it into view.
function show(editor, query, index) {
  const { state } = editor;
  const tr = state.tr.setMeta(key, { query, index }).setMeta('addToHistory', false);
  const value = key.getState(state);
  const matches = query && query === value.query ? value.matches : findMatches(state.doc, query);
  const match = matches[Math.min(index, matches.length - 1)];
  if (match) tr.setSelection(TextSelection.create(tr.doc, match.from, match.to)).scrollIntoView();
  editor.view.dispatch(tr);
}

/* ---------- The find bar ---------- */

const byId = (id) => document.getElementById(id);

export function setupFind(editor) {
  const bar = byId('find-bar');
  const input = byId('find-input');
  const count = byId('find-count');

  const findState = () => key.getState(editor.state) ?? EMPTY;

  function updateCount() {
    if (bar.hidden) return;
    const { query, matches, index } = findState();
    const none = Boolean(query) && !matches.length;
    count.textContent = !query ? '' : none ? 'No results' : `${index + 1} of ${matches.length}`;
    bar.classList.toggle('no-results', none);
  }

  // Searches from the cursor as the query is typed.
  function search() {
    const query = input.value;
    if (!query) {
      show(editor, '', 0);
      return;
    }
    const matches = findMatches(editor.state.doc, query);
    show(editor, query, matchFrom(matches, editor.state.selection.from));
  }

  // direction: 1 for the next match, -1 for the previous one.
  function step(direction) {
    const { query, matches, index } = findState();
    if (query !== input.value || !matches.length) {
      search();
      return;
    }
    show(editor, query, (index + direction + matches.length) % matches.length);
  }

  // `text` fills the box, such as the selected text or a right-clicked word.
  function open(text = null) {
    if (text == null) {
      const { from, to, empty } = editor.state.selection;
      const selected = empty ? '' : editor.state.doc.textBetween(from, to, '\n');
      if (selected && selected.length <= 200 && !selected.includes('\n')) text = selected;
    }
    if (text != null) input.value = text;
    bar.hidden = false;
    input.focus();
    input.select();
    search();
  }

  // Closes the bar and clears the highlights; the current match stays selected.
  function close({ focus = true } = {}) {
    if (bar.hidden) return;
    bar.hidden = true;
    show(editor, '', 0);
    if (focus) editor.commands.focus();
  }

  input.addEventListener('input', search);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });
  byId('find-next').addEventListener('click', () => step(1));
  byId('find-previous').addEventListener('click', () => step(-1));
  byId('find-close').addEventListener('click', () => close());
  // The buttons leave the cursor in the box.
  bar.addEventListener('mousedown', (event) => {
    if (event.target.closest('button')) event.preventDefault();
  });

  document.addEventListener('keydown', (event) => {
    if (document.querySelector('dialog[open]')) return;
    const ctrlF = event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f';
    if (ctrlF) {
      event.preventDefault();
      open();
    } else if (event.key === 'F3' && !event.ctrlKey && !event.altKey && !bar.hidden) {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    }
  });

  editor.on('transaction', updateCount);

  return { open, close };
}
