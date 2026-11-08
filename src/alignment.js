import TextAlign from '@tiptap/extension-text-align';

export const ALIGNMENTS = ['left', 'center', 'right', 'justify'];

// Aligns every paragraph the selection touches, or the cursor's paragraph:
// text, the images in it, bullet items, and paragraphs in selected table cells.
// Left is the default, so it is stored as no alignment at all.
export function setAlignment(editor, alignment) {
  const chain = editor.chain().focus();
  if (alignment === 'left') chain.unsetTextAlign();
  else chain.setTextAlign(alignment);
  return chain.run();
}

export function currentAlignment(editor) {
  return ALIGNMENTS.find((alignment) => alignment !== 'left' && editor.isActive({ textAlign: alignment })) ?? 'left';
}

// Word's shortcuts in place of the library's Ctrl+Shift ones.
const Alignment = TextAlign.extend({
  addKeyboardShortcuts() {
    return {
      'Mod-l': () => setAlignment(this.editor, 'left'),
      'Mod-e': () => setAlignment(this.editor, 'center'),
      'Mod-r': () => setAlignment(this.editor, 'right'),
      'Mod-j': () => setAlignment(this.editor, 'justify'),
    };
  },
});

export const alignmentExtension = Alignment.configure({
  types: ['paragraph'],
  alignments: ALIGNMENTS,
  defaultAlignment: null,
});
