import { EditorState, Selection } from '@tiptap/pm/state';
import { dropdown } from './menus.js';
import { documentToOdt, odtToDocument } from './odt.js';

const APP_NAME = 'Glyphein';

const baseName = (path) => path.split(/[\\/]/).pop();

// The File menu: Open, Save and Save copy, all as OpenDocument Text (.odt).
// Also keeps the window title up to date, and asks before unsaved changes
// would be lost by opening another file or closing the window.
// `defaults` is { font, size }: the app's default font and size in points.
export function setupFiles(editor, { defaults, showMessage }) {
  const byId = (id) => document.getElementById(id);
  const fileButton = byId('file');
  const menu = byId('file-menu');

  let filePath = null;
  let savedDoc = editor.state.doc;
  let dirty = false;
  let busy = false; // A save or open is under way.

  const fileName = () => (filePath ? baseName(filePath) : 'Untitled');

  function update() {
    // Undoing back to the saved text counts as unchanged.
    const now = !editor.state.doc.eq(savedDoc);
    if (now !== dirty) {
      dirty = now;
      window.files.setDirty(dirty);
    }
    document.title = `${dirty ? '*' : ''}${fileName()} - ${APP_NAME}`;
  }

  editor.on('transaction', ({ transaction }) => {
    if (transaction.docChanged) update();
  });

  // Resolves to true if saved. `copy` writes a copy to a new file and leaves
  // the open file as it is.
  async function save({ copy = false } = {}) {
    if (busy) return false;
    busy = true;
    try {
      const doc = editor.state.doc;
      const bytes = await documentToOdt(doc, defaults);
      let defaultPath = filePath ?? 'Untitled.odt';
      if (copy) defaultPath = defaultPath.replace(/(\.odt)?$/i, ' - Copy.odt');

      const savedPath = await window.files.save(bytes, {
        path: copy ? null : filePath,
        ask: copy || !filePath,
        title: copy ? 'Save a copy' : 'Save',
        defaultPath,
      });
      if (!savedPath) return false;
      if (!copy) {
        filePath = savedPath;
        savedDoc = doc;
        update();
      }
      return true;
    } catch (error) {
      showMessage(`The file could not be saved. It may be open in another program, or the folder may be read-only.\n\n${cleanError(error)}`);
      return false;
    } finally {
      busy = false;
    }
  }

  // Resolves to true if it's fine to replace the document: there are no
  // unsaved changes, or they were saved, or the user chose to drop them.
  async function confirmDiscard() {
    if (!dirty) return true;
    const choice = await window.files.confirmDiscard(fileName());
    if (choice === 'save') return save();
    return choice === 'discard';
  }

  async function open() {
    if (busy || !(await confirmDiscard())) return;
    busy = true;
    try {
      const file = await window.files.open();
      if (!file) return;

      let content;
      try {
        content = await odtToDocument(file.bytes, defaults);
        editor.schema.nodeFromJSON(content).check();
      } catch (error) {
        showMessage(`"${baseName(file.path)}" could not be opened. ${error.message}`);
        return;
      }

      editor.commands.setContent(content);
      // A fresh start, so undo can't bring back the previous document.
      const { state } = editor;
      editor.view.updateState(
        EditorState.create({ doc: state.doc, plugins: state.plugins, selection: Selection.atStart(state.doc) }),
      );
      filePath = file.path;
      savedDoc = editor.state.doc;
      // Lets the toolbar and anything else watching catch up.
      editor.view.dispatch(editor.state.tr.setMeta('addToHistory', false).scrollIntoView());
      update();
      byId('desk').scrollTop = 0;
    } catch (error) {
      showMessage(`The file could not be opened.\n\n${cleanError(error)}`);
    } finally {
      busy = false;
      editor.commands.focus();
    }
  }

  const actions = {
    open,
    save: () => save().then(() => editor.commands.focus()),
    'save-copy': () => save({ copy: true }).then(() => editor.commands.focus()),
  };

  /* ---------- The menu ---------- */

  const { close: closeMenu } = dropdown(fileButton, menu, (action) => actions[action]());

  // Ctrl+O, Ctrl+S, Ctrl+Shift+S.
  document.addEventListener('keydown', (event) => {
    if (!event.ctrlKey || event.altKey || document.querySelector('dialog[open]')) return;
    const key = event.key.toLowerCase();
    const action = key === 'o' && !event.shiftKey ? 'open' : key === 's' ? (event.shiftKey ? 'save-copy' : 'save') : null;
    if (!action) return;
    event.preventDefault();
    closeMenu();
    actions[action]();
  });

  // The window's close button, with unsaved changes.
  window.files.onCloseRequested(async () => {
    if (busy) return;
    if (await confirmDiscard()) window.files.close();
  });

  update();
}

// Drops Electron's "Error invoking remote method ..." wrapper.
const cleanError = (error) => String(error?.message ?? error).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
