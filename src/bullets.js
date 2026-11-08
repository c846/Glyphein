import { Extension } from '@tiptap/core';
import { BulletList, ListItem } from '@tiptap/extension-list';
import { Plugin, PluginKey } from '@tiptap/pm/state';

// Common bullets, including the Unicode forms of Word's Symbol and Wingdings
// bullets, which Windows renders with Segoe UI Symbol.
export const BULLET_SYMBOLS = [
  '•', '◦', '▪', '▫', '■', '□', '●', '○',
  '◆', '◇', '❖', '♦', '➢', '➤', '►', '▸',
  '→', '⇒', '–', '✓', '✔', '✗', '☐', '☑',
  '★', '☆', '♥', '♣', '♠', '❑', '◘', '⁃',
];

const cssString = (text) => `"${text.replace(/[\\"]/g, '\\$&')}"`;

// A list's bullet symbol, or null for the default (•, then ◦ and ▪ when nested).
// It belongs to the whole list, so every bullet in it, including new ones, matches.
const BulletListWithSymbol = BulletList.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      symbol: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-symbol'),
        renderHTML: ({ symbol }) =>
          symbol ? { 'data-symbol': symbol, style: `list-style-type: ${cssString(`${symbol}  `)}` } : {},
      },
    };
  },
});

// The bullet list whose bullet (the marker drawn left of the item) is under the
// mouse, as { pos, node, li }, or null.
function bulletAt(view, event) {
  const li = event.target instanceof Element ? event.target.closest('li') : null;
  if (!li || !view.dom.contains(li) || li.parentElement.tagName !== 'UL') return null;
  // The marker sits outside the item's box, so a hit there lands on the li itself.
  if (event.target !== li || event.clientX >= li.getBoundingClientRect().left) return null;

  const pos = view.posAtDOM(li.parentElement, 0) - 1;
  const node = view.state.doc.nodeAt(pos);
  return node?.type.name === 'bulletList' ? { pos, node, li } : null;
}

const BulletBehaviour = Extension.create({
  name: 'bulletBehaviour',
  priority: 1000,

  addOptions() {
    // Called with (bulletListPos, { x, y }) when a bullet is clicked.
    return { onBulletClick: null };
  },

  addKeyboardShortcuts() {
    return {
      // Enter in an empty bullet ends the list (or, when nested, moves it out a level).
      Enter: () => {
        const { $from, empty } = this.editor.state.selection;
        const inEmptyItem =
          empty && $from.parent.content.size === 0 && $from.node(-1)?.type.name === 'listItem';
        return inEmptyItem && this.editor.commands.liftListItem('listItem');
      },
    };
  },

  addProseMirrorPlugins() {
    const { editor, options } = this;
    return [
      new Plugin({
        key: new PluginKey('bulletBehaviour'),
        props: {
          // "-" then space at the start of a line starts a bullet list.
          handleTextInput(view, from, to, text) {
            if (text !== ' ' || from !== to) return false;
            const $from = view.state.doc.resolve(from);
            if ($from.parent.type.name !== 'paragraph' || $from.parentOffset !== 1) return false;
            if ($from.parent.textBetween(0, 1) !== '-') return false;

            const makeList = (chain) => chain.deleteRange({ from: from - 1, to: from }).wrapIn('bulletList');
            if (!makeList(editor.can().chain()).run()) return false;
            return makeList(editor.chain()).run();
          },
          handleDOMEvents: {
            mousemove(view, event) {
              document.body.classList.toggle('bullet-hover', Boolean(bulletAt(view, event)));
              return false;
            },
            mouseleave() {
              document.body.classList.remove('bullet-hover');
              return false;
            },
            mousedown(view, event) {
              if (event.button !== 0) return false;
              const bullet = bulletAt(view, event);
              if (!bullet || !options.onBulletClick) return false;
              event.preventDefault();
              const rect = bullet.li.getBoundingClientRect();
              options.onBulletClick(bullet.pos, { x: rect.left - 24, y: rect.top });
              return true;
            },
          },
        },
      }),
    ];
  },
});

// Sets the bullet symbol of the list at `pos`. null restores the default.
export function setBulletSymbol(editor, pos, symbol) {
  const node = editor.state.doc.nodeAt(pos);
  if (node?.type.name !== 'bulletList') return;
  editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.setNodeMarkup(pos, null, { ...node.attrs, symbol });
      return true;
    })
    .run();
}

export const bulletExtensions = (onBulletClick) => [
  BulletListWithSymbol, // Ctrl+Shift+8 toggles a list
  ListItem, // Tab / Shift+Tab nest and un-nest
  BulletBehaviour.configure({ onBulletClick }),
];
