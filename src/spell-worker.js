// Spell checking with the SCOWL Hunspell dictionaries, off the page's thread
// because loading a dictionary takes a moment.
import nspell from 'nspell';
import usAff from '../node_modules/dictionary-en/index.aff';
import usDic from '../node_modules/dictionary-en/index.dic';
import gbAff from '../node_modules/dictionary-en-gb/index.aff';
import gbDic from '../node_modules/dictionary-en-gb/index.dic';

const SOURCES = { 'en-US': [usAff, usDic], 'en-GB': [gbAff, gbDic] };
const MAX_SUGGESTIONS = 6;
const spellers = {};

function speller(language) {
  spellers[language] ??= nspell(...SOURCES[language]);
  return spellers[language];
}

// nspell often misses two swapped letters in short words ("teh", "adn"),
// the most common typo of all, so those are tried first.
function suggest(spell, word) {
  const swapped = [];
  for (let i = 0; i < word.length - 1; i++) {
    const candidate = word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2);
    if (spell.correct(candidate)) swapped.push(candidate);
  }
  return [...new Set([...swapped, ...spell.suggest(word)])].slice(0, MAX_SUGGESTIONS);
}

// Requests: { id, language, check: [words] } or { id, language, suggest: word }.
self.onmessage = ({ data }) => {
  const spell = speller(data.language);
  const result = data.check
    ? Object.fromEntries(data.check.map((word) => [word, spell.correct(word)]))
    : suggest(spell, data.suggest);
  self.postMessage({ id: data.id, result });
};
