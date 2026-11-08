import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export const LANGUAGES = { 'en-US': 'English (US)', 'en-GB': 'English (UK)' };

const LANGUAGE_KEY = 'glyphein.language';
const IGNORED_KEY = 'glyphein.ignoredWords';
// How long typing has to pause before the document is checked again.
const CHECK_DELAY = 300;

// Letters (including accented ones), with apostrophes allowed inside: "don't".
const WORD = /[A-Za-zÀ-ɏ]+(?:['’][A-Za-zÀ-ɏ]+)*/g;

const normalize = (word) => word.replace(/’/g, "'");

// Words a spell checker should leave alone: single letters and acronyms like "NASA".
const skipped = (word) => word.length < 2 || /^[A-Z]+(?:'[A-Za-z]+)?$/.test(word);

function load(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

// Settings saved under the app's old name, The Pillprocessor, move to the new keys.
for (const [oldKey, key] of [
  ['pillprocessor.language', LANGUAGE_KEY],
  ['pillprocessor.ignoredWords', IGNORED_KEY],
]) {
  try {
    const value = localStorage.getItem(oldKey);
    if (value !== null && localStorage.getItem(key) === null) localStorage.setItem(key, value);
    localStorage.removeItem(oldKey);
  } catch {
    // Storage unavailable: nothing to move.
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.error(`Could not save ${key}: ${error.message}`);
  }
}

// Talks to the spell-check worker and remembers its answers. Also holds the
// language and the ignored words, which are kept between sessions.
export class Speller {
  constructor() {
    this.worker = new Worker('build/spell-worker.js');
    this.pending = new Map();
    this.nextId = 0;
    this.worker.onmessage = ({ data }) => {
      this.pending.get(data.id)(data.result);
      this.pending.delete(data.id);
    };
    this.caches = {};
    this.listeners = new Set();

    const preferred = navigator.language === 'en-GB' ? 'en-GB' : 'en-US';
    const saved = load(LANGUAGE_KEY, preferred);
    this.language = saved in LANGUAGES ? saved : preferred;
    this.ignored = new Set(load(IGNORED_KEY, []));
  }

  request(message) {
    const id = this.nextId++;
    this.worker.postMessage({ id, language: this.language, ...message });
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  get cache() {
    this.caches[this.language] ??= new Map();
    return this.caches[this.language];
  }

  // true, false, or undefined if the word hasn't been checked yet.
  isCorrect(word) {
    word = normalize(word);
    if (skipped(word) || this.ignored.has(word.toLowerCase())) return true;
    return this.cache.get(word);
  }

  // Checks any of `words` not already known.
  async check(words) {
    const cache = this.cache;
    const unknown = [...new Set(words.map(normalize))].filter((word) => !cache.has(word));
    if (!unknown.length) return;
    const results = await this.request({ check: unknown });
    for (const [word, correct] of Object.entries(results)) cache.set(word, correct);
  }

  suggest(word) {
    return this.request({ suggest: normalize(word) });
  }

  // Calls `listener` whenever the language or ignored words change.
  onChange(listener) {
    this.listeners.add(listener);
  }

  changed() {
    for (const listener of this.listeners) listener();
  }

  setLanguage(language) {
    if (!(language in LANGUAGES) || language === this.language) return;
    this.language = language;
    save(LANGUAGE_KEY, language);
    this.changed();
  }

  ignore(word) {
    this.ignored.add(normalize(word).toLowerCase());
    save(IGNORED_KEY, [...this.ignored].sort());
    this.changed();
  }

  unignore(word) {
    this.ignored.delete(word);
    save(IGNORED_KEY, [...this.ignored].sort());
    this.changed();
  }
}

// Calls visit(word, from, to) for every word in the document.
function eachWord(doc, visit) {
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // Images and other inline nodes count as one character, as they do in positions.
    const text = node.textBetween(0, node.content.size, undefined, '￼');
    for (const match of text.matchAll(WORD)) {
      const from = pos + 1 + match.index;
      visit(match[0], from, from + match[0].length);
    }
    return false;
  });
}

// The word at document position `pos`, as { word, from, to }, or null.
export function wordAt(state, pos) {
  const $pos = state.doc.resolve(pos);
  if (!$pos.parent.isTextblock) return null;
  const start = $pos.start();
  const text = $pos.parent.textBetween(0, $pos.parent.content.size, undefined, '￼');
  for (const match of text.matchAll(WORD)) {
    const from = start + match.index;
    const to = from + match[0].length;
    if (from <= pos && pos <= to) return { word: match[0], from, to };
  }
  return null;
}

const spellcheckKey = new PluginKey('spellcheck');

// The underlined misspellings, in document order, as [{ word, from, to }].
export function misspellings(state) {
  return spellcheckKey
    .getState(state)
    .find()
    .map((decoration) => ({ word: decoration.spec.word, from: decoration.from, to: decoration.to }))
    .sort((a, b) => a.from - b.from);
}

export const isMisspelled = (state, range) =>
  misspellings(state).some((m) => m.from === range.from && m.to === range.to);

// Underlines misspelled words in red. The document is checked a moment after
// typing stops; the word being typed isn't marked until the cursor leaves it.
export const Spellcheck = Extension.create({
  name: 'spellcheck',

  addOptions() {
    return { speller: null };
  },

  addProseMirrorPlugins() {
    const { speller } = this.options;

    function decorate(state) {
      const { empty, head } = state.selection;
      const decorations = [];
      eachWord(state.doc, (word, from, to) => {
        if (empty && head === to) return;
        if (speller.isCorrect(word) === false) {
          decorations.push(Decoration.inline(from, to, { class: 'spelling-error' }, { word }));
        }
      });
      return DecorationSet.create(state.doc, decorations);
    }

    return [
      new Plugin({
        key: spellcheckKey,
        state: {
          init: () => DecorationSet.empty,
          apply: (tr, set) => tr.getMeta(spellcheckKey) ?? set.map(tr.mapping, tr.doc),
        },
        props: {
          decorations: (state) => spellcheckKey.getState(state),
        },
        view(view) {
          let timer = null;
          let run = 0;

          async function check() {
            const thisRun = ++run;
            const words = [];
            eachWord(view.state.doc, (word) => words.push(word));
            await speller.check(words);
            // A newer check has started, or the editor is gone.
            if (thisRun !== run || view.isDestroyed) return;
            const tr = view.state.tr.setMeta(spellcheckKey, decorate(view.state));
            view.dispatch(tr.setMeta('addToHistory', false));
          }

          const schedule = (delay) => {
            clearTimeout(timer);
            timer = setTimeout(check, delay);
          };

          const recheck = () => schedule(0);
          speller.onChange(recheck);
          recheck();

          return {
            update(view, previous) {
              if (view.state.doc !== previous.doc || !view.state.selection.eq(previous.selection)) {
                schedule(CHECK_DELAY);
              }
            },
            destroy() {
              clearTimeout(timer);
              speller.listeners.delete(recheck);
            },
          };
        },
      }),
    ];
  },
});
