import { Extension } from '@tiptap/core';
import { isInTable } from '@tiptap/pm/tables';

// Tab types a tab, which reaches the next half-inch stop (tab-size in
// style.css), as at the start of a paragraph. Shift+Tab takes back a tab
// just before the cursor. In a table, Tab still moves between cells, and in
// a bullet list it still nests the item.
export const TabKey = Extension.create({
  name: 'tabKey',

  addKeyboardShortcuts() {
    const elsewhere = () => isInTable(this.editor.state) || this.editor.isActive('listItem');

    return {
      Tab: () => {
        if (elsewhere()) return false;
        return this.editor.commands.command(({ tr }) => {
          tr.insertText('\t').scrollIntoView();
          return true;
        });
      },
      'Shift-Tab': () => {
        if (elsewhere()) return false;
        const { selection } = this.editor.state;
        const { $from, empty } = selection;
        const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 1), $from.parentOffset, '', '');
        if (empty && before === '\t') {
          this.editor.commands.command(({ tr }) => {
            tr.delete($from.pos - 1, $from.pos);
            return true;
          });
        }
        // Either way, keep the cursor in the document.
        return true;
      },
    };
  },
});
