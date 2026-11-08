import { Extension, ResizableNodeView } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { Plugin, PluginKey } from '@tiptap/pm/state';

// The page's text area at 96 pixels per inch: 6.5in wide, and a little under
// 9in tall so an image always fits on one page.
const MAX_WIDTH = 624;
const MAX_HEIGHT = 860;
const MIN_SIZE = 16;

// Scales width x height down, keeping its shape, until it fits the page.
export function fitToPage(width, height) {
  const scale = Math.min(1, MAX_WIDTH / width, MAX_HEIGHT / height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

// Images sit in the line like a large character, as in Word. Dragging a corner
// resizes them with the shape locked; the stored width and height are in pixels.
const ResizableImage = Image.extend({
  addNodeView() {
    return ({ node, getPos, editor }) => {
      const img = document.createElement('img');
      img.draggable = false;

      const applyAttrs = (attrs) => {
        if (img.getAttribute('src') !== attrs.src) img.src = attrs.src;
        img.style.width = attrs.width ? `${attrs.width}px` : '';
        img.style.height = attrs.height ? `${attrs.height}px` : '';
      };
      applyAttrs(node.attrs);

      return new ResizableNodeView({
        element: img,
        editor,
        node,
        getPos,
        onResize: (width, height) => {
          img.style.width = `${width}px`;
          img.style.height = `${height}px`;
        },
        onCommit: (width, height) => {
          const pos = getPos();
          if (pos === undefined) return;
          editor
            .chain()
            .setNodeSelection(pos)
            .updateAttributes('image', { width: Math.round(width), height: Math.round(height) })
            // Changing the attributes replaces the node, which drops the selection.
            .setNodeSelection(pos)
            .run();
        },
        // Also runs on undo and redo, so the image always shows its stored size.
        onUpdate: (updated) => {
          if (updated.type !== node.type) return false;
          applyAttrs(updated.attrs);
          return true;
        },
        options: {
          directions: ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
          min: { width: MIN_SIZE, height: MIN_SIZE },
          max: { width: MAX_WIDTH, height: MAX_HEIGHT },
          preserveAspectRatio: true,
        },
      });
    };
  },
});

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function naturalSize(src) {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('The file is not an image this app can show.'));
    img.src = src;
  });
}

// Inserts image files at `pos` (or the cursor), each at its own size, shrunk to
// fit the page. The image is stored inside the document, so it never goes missing.
export async function insertImageFiles(editor, files, pos) {
  const content = [];
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    const src = await readAsDataURL(file);
    const size = await naturalSize(src);
    content.push({ type: 'image', attrs: { src, alt: file.name, ...fitToPage(size.width, size.height) } });
  }
  if (!content.length) return;

  const chain = editor.chain().focus();
  if (pos !== undefined) chain.insertContentAt(pos, content);
  else chain.insertContent(content);
  chain.run();
}

const imageFiles = (dataTransfer) =>
  [...(dataTransfer?.files ?? [])].filter((file) => file.type.startsWith('image/'));

// Pasting or dropping image files inserts them.
const ImageInput = Extension.create({
  name: 'imageInput',

  addOptions() {
    return { onError: (error) => console.error(error) };
  },

  addProseMirrorPlugins() {
    const { editor, options } = this;
    const insert = (files, pos) => insertImageFiles(editor, files, pos).catch(options.onError);

    return [
      new Plugin({
        key: new PluginKey('imageInput'),
        props: {
          handlePaste(_view, event) {
            const files = imageFiles(event.clipboardData);
            if (!files.length) return false;
            insert(files);
            return true;
          },
          handleDrop(view, event, _slice, moved) {
            const files = moved ? [] : imageFiles(event.dataTransfer);
            if (!files.length) return false;
            const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
            insert(files, pos);
            return true;
          },
        },
      }),
    ];
  },
});

export const imageExtensions = (onError) => [
  ResizableImage.configure({ inline: true, allowBase64: true }),
  ImageInput.configure({ onError }),
];
