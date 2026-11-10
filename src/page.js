import Document from '@tiptap/extension-document';
import { Plugin, PluginKey } from '@tiptap/pm/state';

// Page setup: each document's paper size and margins, in inches. It's kept on
// the document itself (an attribute of its top node), so it's saved with it,
// undone with Ctrl+Z, and counts as a change to save. A document without one
// is US Letter with 1in margins, as every document was before.

export const PX_PER_INCH = 96;
const MM = 1 / 25.4;

export const PAPERS = {
  letter: { label: 'Letter', size: '8.5 × 11 in', width: 8.5, height: 11 },
  legal: { label: 'Legal', size: '8.5 × 14 in', width: 8.5, height: 14 },
  a4: { label: 'A4', size: '210 × 297 mm', width: 210 * MM, height: 297 * MM },
  a5: { label: 'A5', size: '148 × 210 mm', width: 148 * MM, height: 210 * MM },
};

export const DEFAULT_PAGE = { width: 8.5, height: 11, top: 1, bottom: 1, left: 1, right: 1 };

export const MIN_PAPER = 1; // in
export const MAX_PAPER = 22; // in
// The text area must stay at least this big, so there's room to write.
export const MIN_TEXT = 1; // in

// A document's page, with the default filled in.
export const pageOf = (doc) => doc.attrs.page ?? DEFAULT_PAGE;

const same = (a, b) => Math.abs(a - b) < 0.005;

// The paper a size is ('letter', 'a4', ...) either way round, or 'custom'.
export function paperOf({ width, height }) {
  const [short, long] = width < height ? [width, height] : [height, width];
  const found = Object.entries(PAPERS).find(([, paper]) => same(paper.width, short) && same(paper.height, long));
  return found ? found[0] : 'custom';
}

// Why `page` can't be used, or null if it can.
export function pageProblem(page) {
  const values = Object.values(page);
  if (values.some((value) => !Number.isFinite(value) || value < 0)) return 'Enter a size for each box.';
  if (page.width < MIN_PAPER || page.height < MIN_PAPER || page.width > MAX_PAPER || page.height > MAX_PAPER) {
    return `The paper must be between ${MIN_PAPER} and ${MAX_PAPER} inches each way.`;
  }
  if (page.width - page.left - page.right < MIN_TEXT || page.height - page.top - page.bottom < MIN_TEXT) {
    return `The margins must leave at least ${MIN_TEXT} inch for the text each way.`;
  }
  return null;
}

// The space for text on a page, in pixels.
export function textArea(page) {
  return {
    width: Math.round((page.width - page.left - page.right) * PX_PER_INCH),
    height: Math.round((page.height - page.top - page.bottom) * PX_PER_INCH),
  };
}

// The page of the document in the editor, for code that has no document at
// hand, such as sizing a picture as it's dragged.
let shownPage = DEFAULT_PAGE;
export const currentTextArea = () => textArea(shownPage);

/* ---------- Drawing the page ---------- */

const inches = (value) => `${+value.toFixed(4)}in`;

// The paper size and margins for printing. @page can't use CSS variables, so
// it's written out each time.
const printStyle = document.createElement('style');
document.head.append(printStyle);

function showPage(page) {
  shownPage = page;
  const root = document.documentElement.style;
  root.setProperty('--page-width', inches(page.width));
  root.setProperty('--page-height', inches(page.height));
  root.setProperty('--margin-top', inches(page.top));
  root.setProperty('--margin-bottom', inches(page.bottom));
  root.setProperty('--margin-left', inches(page.left));
  root.setProperty('--margin-right', inches(page.right));
  printStyle.textContent =
    `@page { size: ${inches(page.width)} ${inches(page.height)}; ` +
    `margin: ${inches(page.top)} ${inches(page.right)} ${inches(page.bottom)} ${inches(page.left)}; }`;
}
showPage(DEFAULT_PAGE);

// The variables above, so the still copy of the pages that slides away when
// switching documents (src/slide.js) can keep the old page's shape.
export const PAGE_VARIABLES = ['--page-width', '--page-height', '--margin-top', '--margin-bottom', '--margin-left', '--margin-right'];

// The top node carries the page. Whenever the editor shows a document (after
// any change, or on switching), the pages are drawn to its size.
export const PageDocument = Document.extend({
  addAttributes() {
    return { page: { default: null, rendered: false } };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('pageSetup'),
        view(view) {
          let drawn = null;
          const update = () => {
            const page = pageOf(view.state.doc);
            if (page === drawn) return;
            drawn = page;
            showPage(page);
          };
          update();
          return { update };
        },
      }),
    ];
  },
});

// Gives the document a new page. Pictures too big for the new text area
// shrink to fit (tables refit themselves: see src/tables.js).
export function setPage(editor, page) {
  const value = Object.keys(DEFAULT_PAGE).every((key) => same(page[key], DEFAULT_PAGE[key])) ? null : { ...page };
  const area = textArea(page);
  return editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.setDocAttribute('page', value);
      tr.doc.descendants((node, pos) => {
        if (node.type.name !== 'image' || !node.attrs.width || !node.attrs.height) return true;
        const { width, height } = node.attrs;
        const scale = Math.min(1, area.width / width, (area.height - 4) / height);
        if (scale < 1) {
          tr.setNodeMarkup(pos, null, { ...node.attrs, width: Math.round(width * scale), height: Math.round(height * scale) });
        }
        return false;
      });
      return true;
    })
    .run();
}

/* ---------- The Page setup dialog (File > Page setup) ---------- */

const byId = (id) => document.getElementById(id);
const round = (value) => +value.toFixed(2);

export function setupPageDialog(editor) {
  const dialog = byId('page-dialog');
  const form = dialog.querySelector('form');
  const paperSelect = byId('page-paper');
  const fields = {
    width: byId('page-width'),
    height: byId('page-height'),
    top: byId('page-top'),
    bottom: byId('page-bottom'),
    left: byId('page-left'),
    right: byId('page-right'),
  };
  const portrait = byId('page-portrait');
  const landscape = byId('page-landscape');
  const problem = byId('page-problem');
  const sheet = byId('page-preview-sheet');
  const text = byId('page-preview-text');

  paperSelect.replaceChildren(
    ...Object.entries(PAPERS).map(([name, paper]) => new Option(`${paper.label} (${paper.size})`, name)),
    new Option('Custom', 'custom'),
  );
  for (const name of ['width', 'height']) {
    fields[name].min = MIN_PAPER;
    fields[name].max = MAX_PAPER;
  }
  for (const name of ['top', 'bottom', 'left', 'right']) fields[name].min = 0;

  // The page being set up. Sizes are kept exactly (A4 is 8.2677in wide) and
  // shown rounded; a box only replaces its value once it's typed in.
  let page = DEFAULT_PAGE;

  function show({ keep } = {}) {
    for (const [name, input] of Object.entries(fields)) {
      if (name !== keep) input.value = round(page[name]);
    }
    paperSelect.value = paperOf(page);
    const wide = page.width > page.height;
    portrait.setAttribute('aria-pressed', !wide);
    landscape.setAttribute('aria-pressed', wide);

    const message = pageProblem(page);
    // OK does nothing while there's a problem (see the submit listener).
    problem.textContent = message ?? '';

    // The preview: the sheet in proportion, with its text area marked.
    const scale = Math.min(150 / page.width, 190 / page.height);
    sheet.style.width = `${page.width * scale}px`;
    sheet.style.height = `${page.height * scale}px`;
    Object.assign(text.style, {
      top: `${Math.min(page.top, page.height) * scale}px`,
      bottom: `${Math.min(page.bottom, page.height) * scale}px`,
      left: `${Math.min(page.left, page.width) * scale}px`,
      right: `${Math.min(page.right, page.width) * scale}px`,
    });
  }

  for (const [name, input] of Object.entries(fields)) {
    input.addEventListener('input', () => {
      const value = parseFloat(input.value);
      page = { ...page, [name]: Number.isFinite(value) ? value : NaN };
      show({ keep: name });
    });
    // Tidies a box once it's left, such as "8.500" to "8.5".
    input.addEventListener('change', () => show());
  }

  paperSelect.addEventListener('change', () => {
    const paper = PAPERS[paperSelect.value];
    if (!paper) return; // Custom: the width and height are typed in.
    const wide = page.width > page.height;
    page = { ...page, width: wide ? paper.height : paper.width, height: wide ? paper.width : paper.height };
    show();
  });

  const turn = (wide) => {
    if (page.width > page.height === wide || page.width === page.height) return;
    // Turning the paper takes its margins round with it.
    page = wide
      ? { width: page.height, height: page.width, top: page.left, right: page.top, bottom: page.right, left: page.bottom }
      : { width: page.height, height: page.width, top: page.right, right: page.bottom, bottom: page.left, left: page.top };
    show();
  };
  portrait.addEventListener('click', () => turn(false));
  landscape.addEventListener('click', () => turn(true));

  // An empty or out-of-range box reports itself; this catches the rest, such
  // as margins that leave no room for text.
  form.addEventListener('submit', (event) => {
    if (event.submitter?.value === 'ok' && pageProblem(page)) event.preventDefault();
  });

  function open() {
    page = { ...pageOf(editor.state.doc) };
    show();
    dialog.returnValue = '';
    dialog.showModal();
    dialog.addEventListener(
      'close',
      () => {
        if (dialog.returnValue === 'ok' && !pageProblem(page)) {
          const before = pageOf(editor.state.doc);
          const changed = Object.keys(DEFAULT_PAGE).some((key) => !same(page[key], before[key]));
          if (changed) setPage(editor, page);
          else editor.commands.focus();
        } else {
          editor.commands.focus();
        }
      },
      { once: true },
    );
  }

  return { open };
}
