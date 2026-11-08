import { openContextMenu } from './menus.js';
import { LANGUAGES, isMisspelled, misspellings, wordAt } from './spellcheck.js';

const MAX_MENU_SYNONYMS = 6;

const byId = (id) => document.getElementById(id);

function element(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// Gives `replacement` the capitals of `original`: "Happy" -> "Glad", "HAPPY" -> "GLAD".
function matchCase(original, replacement) {
  if (original.length > 1 && original === original.toUpperCase()) return replacement.toUpperCase();
  if (original[0] === original[0].toUpperCase()) return replacement[0].toUpperCase() + replacement.slice(1);
  return replacement;
}

function lookUp(word) {
  return window.wordnet.lookup(word).catch((error) => {
    console.error(`Dictionary lookup failed: ${error.message}`);
    return { query: word, entries: [], failed: true };
  });
}

// The synonyms to offer for a quick replacement: true synonyms from every
// sense (most common senses first), then merely similar words.
function quickSynonyms(result) {
  const senses = result.entries.flatMap((entry) => entry.senses);
  const words = [...senses.flatMap((sense) => sense.synonyms), ...senses.flatMap((sense) => sense.similar)];
  return [...new Set(words)].slice(0, MAX_MENU_SYNONYMS);
}

export function setupReference(editor, speller) {
  const panel = byId('reference');
  const tabs = { dictionary: byId('tab-dictionary'), thesaurus: byId('tab-thesaurus'), spelling: byId('tab-spelling') };
  // The Lexicon menu's items, ticked while their tab is showing.
  const lexiconItems = byId('lexicon-menu').querySelectorAll('[data-action]');
  const searchForm = byId('reference-search');
  const searchInput = byId('reference-query');
  const results = byId('reference-results');
  const spellingPage = byId('spelling-page');
  const languageSelect = byId('language');

  let activeTab = null;
  let searchRun = 0;

  /* ---------- Replacing words in the document ---------- */

  function replaceWord(range, replacement) {
    // Gone stale if the document changed while the menu was open.
    if (editor.state.doc.textBetween(range.from, range.to, undefined, '￼') !== range.word) return;
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.insertText(matchCase(range.word, replacement), range.from, range.to);
        return true;
      })
      .run();
  }

  // The selected word, or the word at the cursor.
  function currentWord() {
    const { from, to, empty } = editor.state.selection;
    if (!empty) {
      const text = editor.state.doc.textBetween(from, to, ' ').trim();
      if (text && text.length <= 60) return text;
    }
    return wordAt(editor.state, from)?.word ?? '';
  }

  /* ---------- The side panel ---------- */

  function showTab(name) {
    activeTab = name;
    panel.hidden = !name;
    for (const [tab, button] of Object.entries(tabs)) button.setAttribute('aria-selected', tab === name);
    for (const item of lexiconItems) item.setAttribute('aria-checked', item.dataset.action === name);
    searchForm.hidden = results.hidden = name === 'spelling';
    spellingPage.hidden = name !== 'spelling';
    if (name === 'spelling') renderSpellingPage();
  }

  // Opens a tab. Opening the tab already showing closes the panel.
  function toggleTab(name) {
    if (activeTab === name) {
      showTab(null);
      editor.commands.focus();
      return;
    }
    showTab(name);
    if (name === 'spelling') return;
    const word = currentWord() || searchInput.value;
    if (word) search(word);
    else searchInput.focus();
  }

  function wordButton(word, onClick) {
    return element('button', { type: 'button', className: 'word-link', textContent: word, onclick: onClick });
  }

  // What to show when WordNet doesn't know the word: spelling suggestions.
  async function renderNotFound(result, thisRun) {
    if (result.failed) {
      results.replaceChildren(element('p', { className: 'note', textContent: 'The dictionary could not be read.' }));
      return;
    }
    const suggestions = await speller.suggest(result.query);
    if (thisRun !== searchRun) return;
    const nodes = [element('p', { className: 'note', textContent: `No entry for “${result.query}”.` })];
    if (suggestions.length) {
      nodes.push(
        element('p', { className: 'note' }, [
          'Did you mean: ',
          ...suggestions.flatMap((word, index) => [index ? ', ' : '', wordButton(word, () => search(word))]),
        ]),
      );
    }
    results.replaceChildren(...nodes);
  }

  function renderDictionary(result) {
    results.replaceChildren(
      ...result.entries.map((entry) =>
        element('section', { className: 'entry' }, [
          element('h3', {}, [entry.word, ' ', element('span', { className: 'pos', textContent: entry.partOfSpeech })]),
          element(
            'ol',
            {},
            entry.senses.map((sense) =>
              element('li', {}, [
                element('div', { textContent: sense.definition }),
                ...sense.examples.map((example) => element('div', { className: 'example', textContent: `“${example}”` })),
              ]),
            ),
          ),
          ...etymology(entry.etymologies),
        ]),
      ),
    );
  }

  // Shown under the definitions only when Wiktionary has an etymology.
  function etymology(texts = []) {
    if (!texts.length) return [];
    return [
      element('div', { className: 'etymology' }, [
        element('h4', { textContent: 'Etymology' }),
        ...texts.map((text) => element('p', { textContent: text })),
      ]),
    ];
  }

  function wordList(label, words) {
    if (!words.length) return [];
    return [
      element('div', { className: 'word-list' }, [
        element('span', { className: 'list-label', textContent: `${label}: ` }),
        ...words.flatMap((word, index) => [index ? ', ' : '', wordButton(word, () => search(word))]),
      ]),
    ];
  }

  function renderThesaurus(result) {
    const sections = [];
    for (const entry of result.entries) {
      const senses = entry.senses.filter(
        (s) => s.synonyms.length || s.similar.length || s.antonyms.length || s.broader.length,
      );
      if (!senses.length) continue;
      sections.push(
        element('section', { className: 'entry' }, [
          element('h3', {}, [entry.word, ' ', element('span', { className: 'pos', textContent: entry.partOfSpeech })]),
          ...senses.map((sense) =>
            element('div', { className: 'sense' }, [
              element('div', { className: 'sense-meaning', textContent: sense.definition }),
              ...wordList('Synonyms', sense.synonyms),
              ...wordList('Similar', sense.similar),
              ...wordList('Antonyms', sense.antonyms),
              ...wordList('Broader', sense.broader),
            ]),
          ),
        ]),
      );
    }
    if (!sections.length) {
      sections.push(element('p', { className: 'note', textContent: `No synonyms for “${result.query}”.` }));
    }
    results.replaceChildren(...sections);
  }

  async function search(word) {
    word = word.trim();
    if (!word) return;
    searchInput.value = word;
    const thisRun = ++searchRun;
    const tab = activeTab;
    // Fades in only if the lookup is slow, so a quick one doesn't flash it.
    results.replaceChildren(element('p', { className: 'note loading', textContent: 'Looking up…' }));

    const result = await lookUp(word);
    if (thisRun !== searchRun || tab !== activeTab) return;
    if (!result.entries.length) renderNotFound(result, thisRun);
    else if (tab === 'dictionary') renderDictionary(result);
    else renderThesaurus(result);
    results.scrollTop = 0;
  }

  function renderSpellingPage() {
    languageSelect.value = speller.language;
    const list = byId('ignored-words');
    const words = [...speller.ignored].sort();
    byId('ignored-empty').hidden = words.length > 0;
    list.replaceChildren(
      ...words.map((word) =>
        element('li', {}, [
          element('span', { textContent: word }),
          element('button', {
            type: 'button',
            textContent: 'Remove',
            title: `Check the spelling of “${word}” again`,
            onclick: () => speller.unignore(word),
          }),
        ]),
      ),
    );
  }

  languageSelect.replaceChildren(...Object.entries(LANGUAGES).map(([code, name]) => new Option(name, code)));
  languageSelect.addEventListener('change', () => speller.setLanguage(languageSelect.value));
  speller.onChange(() => {
    if (activeTab === 'spelling') renderSpellingPage();
  });

  for (const [name, tab] of Object.entries(tabs)) {
    tab.addEventListener('click', () => {
      showTab(name);
      if (name !== 'spelling' && searchInput.value) search(searchInput.value);
    });
  }
  byId('reference-close').addEventListener('click', () => {
    showTab(null);
    editor.commands.focus();
  });
  byId('next-error').addEventListener('click', () => goToNextMisspelling());
  searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    search(searchInput.value);
  });

  /* ---------- Right-click menu items ---------- */

  // The items the right-click menu shows for a word: spelling suggestions if
  // it's misspelled, otherwise a few synonyms; then dictionary and thesaurus.
  async function wordMenuItems(range) {
    const misspelled = isMisspelled(editor.state, range);
    const [suggestions, result] = await Promise.all([
      misspelled ? speller.suggest(range.word) : [],
      misspelled ? null : lookUp(range.word),
    ]);

    const items = [];
    if (misspelled) {
      if (suggestions.length) {
        for (const word of suggestions) {
          items.push({ label: matchCase(range.word, word), className: 'suggestion', action: () => replaceWord(range, word) });
        }
      } else {
        items.push({ label: 'No suggestions' });
      }
      items.push('separator', { label: `Ignore “${range.word}”`, action: () => speller.ignore(range.word) });
    } else {
      const synonyms = quickSynonyms(result);
      if (synonyms.length) {
        items.push({ label: 'Synonyms', className: 'heading' });
        for (const word of synonyms) {
          items.push({ label: matchCase(range.word, word), action: () => replaceWord(range, word) });
        }
      }
    }
    items.push(
      'separator',
      { label: 'Look up in dictionary', action: () => openTabWith('dictionary', range.word) },
      { label: 'Thesaurus…', action: () => openTabWith('thesaurus', range.word) },
    );
    return items;
  }

  function openTabWith(name, word) {
    showTab(name);
    search(word);
  }

  // Moves to the next misspelling after the cursor (wrapping round) and opens its menu.
  async function goToNextMisspelling() {
    const all = misspellings(editor.state);
    if (!all.length) {
      const coords = editor.view.coordsAtPos(editor.state.selection.head);
      openContextMenu([{ label: 'No spelling mistakes found.' }], coords.left, coords.bottom + 2);
      return;
    }
    const after = editor.state.selection.to;
    const next = all.find((m) => m.from >= after) ?? all[0];
    editor.chain().focus().setTextSelection({ from: next.from, to: next.to }).scrollIntoView().run();
    const coords = editor.view.coordsAtPos(next.from);
    openContextMenu(await wordMenuItems(next), coords.left, coords.bottom + 2);
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'F7' && event.shiftKey) {
      // Shift+F7: thesaurus for the word at the cursor, as in Word.
      event.preventDefault();
      showTab('thesaurus');
      const word = currentWord();
      if (word) search(word);
      else searchInput.focus();
    } else if (event.key === 'F7') {
      event.preventDefault();
      goToNextMisspelling();
    }
  });

  return { toggleTab, wordMenuItems };
}
