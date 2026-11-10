import { EditorState } from '@tiptap/pm/state';
import { dropdown } from './menus.js';
import { documentToOdt, odtToDocument } from './odt.js';
import { stopGlide } from './pages.js';
import { slideDocuments } from './slide.js';

const APP_NAME = 'Glyphein';

// Right Shift + 1 to 9 switches to that document.
const SWITCH_KEYS = 9;

const RECENT_KEY = 'glyphein.recentFiles';
const MAX_RECENT = 10;

const baseName = (path) => path.split(/[\\/]/).pop();
// Windows paths ignore case and either slash.
const samePath = (a, b) => a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase();

// The open documents and the File menu: New, Open, Save, Save copy, all as
// OpenDocument Text (.odt), plus the Documents menu that lists what's open.
//
// There is one editor. Each open document keeps its own editor state (its
// text, undo history and cursor) and scroll position, and switching swaps
// that state into the editor. The window title follows the current
// document, and nothing with unsaved changes is closed without asking.
// `getPresets` gives the app's presets (src/presets.js), which set the text's
// default font and the headings' when saving and opening.
// `onSwitch` runs just before another document is shown.
// `openPageSetup` opens File > Page setup.
export function setupFiles(editor, { getPresets, openPageSetup, showMessage, onSwitch = () => {} }) {
  const byId = (id) => document.getElementById(id);
  const desk = byId('desk');
  const documentsButton = byId('documents');
  const documentsCount = byId('documents-count');
  const documentsMenu = byId('documents-menu');
  const documentsList = byId('documents-list');

  // Each document is { state, filePath, savedDoc, dirty, untitled, scrollTop }.
  // The current one's state lives in the editor, so its `state` is unused
  // until another is shown. `untitled` numbers the unsaved new ones.
  const documents = [];
  let current = null;
  let windowDirty = false;
  let busy = false; // A save, open or close is under way.

  const stateOf = (doc) => (doc === current ? editor.state : doc.state);
  const nameOf = (doc) => {
    if (doc.filePath) return baseName(doc.filePath);
    return doc.untitled === 1 ? 'Untitled' : `Untitled ${doc.untitled}`;
  };

  // A state for `doc` (a ProseMirror node), with the editor's plugins and a
  // fresh undo history. Plugins that tidy the document (such as the one that
  // keeps a line after a table) get their turn now, so a document doesn't
  // count as changed the moment it's shown.
  function freshState(doc) {
    const state = EditorState.create({ doc, plugins: editor.state.plugins });
    return state.applyTransaction(state.tr.setMeta('addToHistory', false)).state;
  }

  const emptyState = () => freshState(editor.schema.topNodeType.createAndFill());
  const EMPTY = emptyState().doc;

  function newDocument(state, filePath = null) {
    let untitled = null;
    if (!filePath) {
      const taken = new Set(documents.map((doc) => doc.untitled));
      untitled = 1;
      while (taken.has(untitled)) untitled++;
    }
    return { state, filePath, savedDoc: state.doc, dirty: false, untitled, scrollTop: 0 };
  }

  // A new, unchanged document with nothing in it, which an opened file can
  // take the place of.
  const isBlank = (doc) => !doc.filePath && !doc.dirty && stateOf(doc).doc.eq(EMPTY);

  /* ---------- Keeping the window up to date ---------- */

  function update() {
    const anyDirty = documents.some((doc) => doc.dirty);
    if (anyDirty !== windowDirty) {
      windowDirty = anyDirty;
      window.files.setDirty(anyDirty);
    }
    document.title = `${current.dirty ? '*' : ''}${nameOf(current)} - ${APP_NAME}`;
    renderList();
  }

  editor.on('transaction', ({ transaction }) => {
    if (!transaction.docChanged || !current) return;
    // Undoing back to the saved text counts as unchanged.
    const dirty = !editor.state.doc.eq(current.savedDoc);
    if (dirty !== current.dirty) {
      current.dirty = dirty;
      update();
    }
  });

  // The Documents menu: each open document, its number for Right Shift, and
  // a dot if it has unsaved changes.
  function renderList() {
    documentsCount.textContent = documents.length;
    documentsButton.title = `Open documents (${documents.length})`;
    documentsList.replaceChildren(
      ...documents.map((doc, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('role', 'menuitemradio');
        button.setAttribute('aria-checked', doc === current);
        button.dataset.action = `switch-${index}`;

        const label = document.createElement('span');
        label.className = 'item-label document-name';
        const name = document.createElement('span');
        name.className = 'name-text';
        name.textContent = nameOf(doc);
        label.title = doc.filePath ?? 'Not saved yet';
        label.append(name);
        if (doc.dirty) {
          const dot = document.createElement('span');
          dot.className = 'unsaved';
          dot.title = 'Unsaved changes';
          label.append(dot);
        }
        button.append(label);

        if (index < SWITCH_KEYS) {
          const shortcut = document.createElement('span');
          shortcut.className = 'shortcut';
          shortcut.textContent = `Right Shift+${index + 1}`;
          button.append(shortcut);
        }
        return button;
      }),
    );
  }

  /* ---------- Switching ---------- */

  // Shows `doc` in the editor. It slides in from the side it sits on in the
  // list, unless `direction` says otherwise (1 from the right, -1 from the
  // left, 0 not at all).
  function show(doc, direction = Math.sign(documents.indexOf(doc) - documents.indexOf(current))) {
    if (doc === current) return;
    stopGlide();
    onSwitch();
    slideDocuments(
      direction,
      () => {
        current.state = editor.state;
        current.scrollTop = desk.scrollTop;
        current = doc;
        editor.view.updateState(doc.state);
        doc.state = null;
        desk.scrollTop = doc.scrollTop;
        // Lets the toolbar and anything else watching catch up.
        editor.view.dispatch(editor.state.tr.setMeta('addToHistory', false));
        editor.view.focus();
        update();
      },
      // Puts the text cursor back where the pages came to rest.
      () => editor.view.dispatch(editor.state.tr.setMeta('addToHistory', false)),
    );
  }

  const showNumber = (index) => documents[index] && show(documents[index]);

  // Runs one File action at a time, focusing the document afterwards.
  async function run(action) {
    if (busy) return;
    busy = true;
    try {
      await action();
    } finally {
      busy = false;
      editor.view.focus();
    }
  }

  /* ---------- Saving ---------- */

  // Saves the current document. Resolves to true if saved. `copy` writes a
  // copy to a new file and leaves the open file as it is.
  async function save({ copy = false } = {}) {
    const doc = current;
    const content = editor.state.doc;
    try {
      const bytes = await documentToOdt(content, getPresets());
      let defaultPath = doc.filePath ?? `${nameOf(doc)}.odt`;
      if (copy) defaultPath = defaultPath.replace(/(\.odt)?$/i, ' - Copy.odt');

      const savedPath = await window.files.save(bytes, {
        path: copy ? null : doc.filePath,
        ask: copy || !doc.filePath,
        title: copy ? 'Save a copy' : 'Save',
        defaultPath,
      });
      if (!savedPath) return false;
      remember(savedPath);
      if (!copy) {
        doc.filePath = savedPath;
        doc.untitled = null;
        doc.savedDoc = content;
        // Anything typed while it was being written is still unsaved.
        doc.dirty = !stateOf(doc).doc.eq(content);
        update();
      }
      return true;
    } catch (error) {
      showMessage(`The file could not be saved. It may be open in another program, or the folder may be read-only.\n\n${cleanError(error)}`);
      return false;
    }
  }

  // Resolves to true if it's fine to let `doc` go: it has no unsaved changes,
  // or they were saved, or the user chose to drop them. It's shown first, so
  // it's clear which document is being asked about.
  async function confirmDiscard(doc) {
    if (!doc.dirty) return true;
    show(doc);
    const choice = await window.files.confirmDiscard(nameOf(doc));
    if (choice === 'save') return save();
    return choice === 'discard';
  }

  /* ---------- Recent documents ---------- */

  // The files most recently opened or saved, newest first, shown at the foot
  // of the File menu. Shared by every window, and kept between sessions.
  const recentSection = byId('recent-section');
  const recentList = byId('recent-list');

  function loadRecent() {
    try {
      const paths = JSON.parse(localStorage.getItem(RECENT_KEY));
      return Array.isArray(paths) ? paths.filter((path) => typeof path === 'string').slice(0, MAX_RECENT) : [];
    } catch {
      return [];
    }
  }

  function saveRecent(paths) {
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(paths));
    } catch (error) {
      console.error(`Could not save the recent documents: ${error.message}`);
    }
    renderRecent();
  }

  function remember(path) {
    saveRecent([path, ...loadRecent().filter((other) => !samePath(other, path))].slice(0, MAX_RECENT));
  }

  const forget = (path) => saveRecent(loadRecent().filter((other) => !samePath(other, path)));

  function renderRecent() {
    const paths = loadRecent();
    recentSection.hidden = !paths.length;
    recentList.replaceChildren(
      ...paths.map((path, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('role', 'menuitem');
        button.dataset.action = `recent-${index}`;
        button.title = path;

        const label = document.createElement('span');
        label.className = 'item-label document-name';
        const name = document.createElement('span');
        name.className = 'name-text';
        name.textContent = baseName(path);
        label.append(name);

        const folder = document.createElement('span');
        folder.className = 'shortcut recent-folder';
        folder.textContent = path.slice(0, path.length - baseName(path).length).replace(/[\\/]$/, '');

        button.append(label, folder);
        return button;
      }),
    );
  }

  // Another window opened or saved something.
  window.addEventListener('storage', (event) => {
    if (event.key === RECENT_KEY) renderRecent();
  });

  // A file from the list. One that has gone (moved, renamed or deleted) is
  // taken off it.
  const openRecent = (path) =>
    run(async () => {
      let file;
      try {
        file = await window.files.read(path);
      } catch (error) {
        forget(path);
        showMessage(`"${baseName(path)}" could not be opened. It may have been moved, renamed or deleted.\n\n${cleanError(error)}`);
        return;
      }
      await openFile(file);
    });

  /* ---------- Printing ---------- */

  // File > Print, or Ctrl+P. The page's title names the print job, which is
  // also what Microsoft Print to PDF suggests as the file name, so for the
  // moment it's just the document's name.
  async function print() {
    const title = document.title;
    document.title = nameOf(current).replace(/\.odt$/i, '');
    try {
      const failure = await window.files.print();
      if (failure) showMessage(`The document could not be printed.\n\n${failure}`);
    } catch (error) {
      showMessage(`The document could not be printed.\n\n${cleanError(error)}`);
    } finally {
      document.title = title;
    }
  }

  /* ---------- Opening and closing ---------- */

  // Opens `file` ({ path, bytes }) as another document, or switches to it if
  // it's already open. A blank, untouched document is replaced rather than
  // kept beside it. Resolves to true if it was opened.
  async function openFile(file) {
    const open = documents.find((doc) => doc.filePath && samePath(doc.filePath, file.path));
    if (open) {
      remember(open.filePath);
      show(open);
      return true;
    }

    let state;
    try {
      const content = await odtToDocument(file.bytes, getPresets());
      const node = editor.schema.nodeFromJSON(content);
      node.check();
      state = freshState(node);
    } catch (error) {
      showMessage(`"${baseName(file.path)}" could not be opened. ${error.message}`);
      return false;
    }

    const doc = newDocument(state, file.path);
    remember(file.path);
    if (isBlank(current)) {
      const blank = current;
      documents.splice(documents.indexOf(blank), 1, doc);
      current = doc; // Stands in for the blank one, which is dropped.
      blank.state = null;
      editor.view.updateState(doc.state);
      doc.state = null;
      desk.scrollTop = 0;
      editor.view.dispatch(editor.state.tr.setMeta('addToHistory', false));
      update();
    } else {
      documents.push(doc);
      show(doc);
    }
    return true;
  }

  // File > Open, or Ctrl+O.
  const open = () =>
    run(async () => {
      try {
        const file = await window.files.open();
        if (file) await openFile(file);
      } catch (error) {
        showMessage(`The file could not be opened.\n\n${cleanError(error)}`);
      }
    });

  // File > New, or Ctrl+N: a blank document after the others.
  const create = () =>
    run(async () => {
      const doc = newDocument(emptyState());
      documents.push(doc);
      show(doc);
    });

  // Ctrl+W: closes the current document, asking first if it has unsaved
  // changes. The one beside it slides in; closing the last leaves a blank one.
  const close = () =>
    run(async () => {
      const doc = current;
      if (!(await confirmDiscard(doc))) return;
      const index = documents.indexOf(doc);
      if (documents.length === 1) {
        const blank = newDocument(emptyState());
        blank.untitled = 1; // The one it replaces is going.
        documents.push(blank);
        show(blank, 1);
      } else {
        show(documents[index + 1] ?? documents[index - 1]);
      }
      documents.splice(index, 1);
      update();
    });

  // Files from File Explorer: the one the window was opened with, and any
  // opened while it's running. One batch at a time, in order.
  let incoming = Promise.resolve();
  const openIncoming = () => {
    incoming = incoming.then(async () => {
      try {
        for (const file of await window.files.takeIncoming()) {
          if (file.error) showMessage(`"${baseName(file.path)}" could not be opened.\n\n${file.error}`);
          else await openFile(file);
        }
      } catch (error) {
        showMessage(`The file could not be opened.\n\n${cleanError(error)}`);
      }
    });
  };

  // The window's close button, with unsaved changes: asks about each
  // document that has them in turn. Cancelling any keeps the window open.
  window.files.onCloseRequested(() =>
    run(async () => {
      for (const doc of [...documents]) {
        if (!(await confirmDiscard(doc))) return;
      }
      window.files.close();
    }),
  );

  /* ---------- Menus and keys ---------- */

  const actions = {
    new: create,
    open,
    save: () => run(() => save()),
    'save-copy': () => run(() => save({ copy: true })),
    'page-setup': openPageSetup,
    print: () => run(print),
    close,
    'clear-recent': () => saveRecent([]),
  };

  const { close: closeFileMenu } = dropdown(byId('file'), byId('file-menu'), (action) => {
    const recent = /^recent-(\d+)$/.exec(action);
    if (recent) {
      const path = loadRecent()[Number(recent[1])];
      if (path) openRecent(path);
    } else {
      actions[action]();
    }
  });
  renderRecent();
  const { close: closeDocumentsMenu } = dropdown(documentsButton, documentsMenu, (action) => {
    const number = /^switch-(\d+)$/.exec(action);
    if (number) showNumber(Number(number[1]));
    else actions[action]();
  });

  // Ctrl+N, Ctrl+O, Ctrl+S, Ctrl+Shift+S, Ctrl+P, Ctrl+W.
  document.addEventListener('keydown', (event) => {
    if (!event.ctrlKey || event.altKey || document.querySelector('dialog[open]')) return;
    const key = event.key.toLowerCase();
    const action = event.shiftKey
      ? { s: 'save-copy' }[key]
      : { n: 'new', o: 'open', s: 'save', p: 'print', w: 'close' }[key];
    if (!action) return;
    event.preventDefault();
    closeFileMenu();
    closeDocumentsMenu();
    actions[action]();
  });

  // Right Shift + a number key switches to that document. The left Shift
  // still types !, @, # and so on, and so does the right one when there's no
  // document with that number. The key's position is used, not the character
  // it types, so it works on any keyboard layout.
  let rightShift = false;
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.code === 'ShiftRight') rightShift = true;
      const digit = /^Digit([1-9])$/.exec(event.code);
      if (!digit || !rightShift || !event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
      if (document.querySelector('dialog[open]')) return;
      const index = Number(digit[1]) - 1;
      if (!documents[index]) return;
      // Capture phase, so the editor never types the character.
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat || busy) return;
      closeFileMenu();
      closeDocumentsMenu();
      showNumber(index);
    },
    true,
  );
  document.addEventListener('keyup', (event) => {
    if (event.code === 'ShiftRight') rightShift = false;
  });
  window.addEventListener('blur', () => (rightShift = false));

  /* ---------- Starting up ---------- */

  current = newDocument(editor.state);
  documents.push(current);
  current.state = null;
  update();
  window.files.onIncoming(openIncoming);
  openIncoming();
}

// Drops Electron's "Error invoking remote method ..." wrapper.
const cleanError = (error) => String(error?.message ?? error).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
