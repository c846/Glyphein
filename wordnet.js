// Dictionary and thesaurus lookups in Princeton WordNet 3.1 (the wordnet-db package).
// Runs in the main process, which can read the database files.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { path: DICT } = require('wordnet-db');

// Etymologies from Wiktionary, built by scripts/build-etymology.js.
const ETYMOLOGY_FILE = path.join(__dirname, 'data', 'etymology.json.gz');

const PARTS = {
  n: { file: 'noun', label: 'noun' },
  v: { file: 'verb', label: 'verb' },
  a: { file: 'adj', label: 'adjective' },
  r: { file: 'adv', label: 'adverb' },
};
// Adjective satellites ("s") live in the adjective files.
const PART_OF = { n: 'n', v: 'v', a: 'a', s: 'a', r: 'r' };

// Regular inflections, tried in order to find a word's base form ("running" -> "run").
const SUFFIX_RULES = {
  n: [['s', ''], ['ses', 's'], ['xes', 'x'], ['zes', 'z'], ['ches', 'ch'], ['shes', 'sh'], ['men', 'man'], ['ies', 'y']],
  v: [['s', ''], ['ies', 'y'], ['es', 'e'], ['es', ''], ['ed', 'e'], ['ed', ''], ['ing', 'e'], ['ing', '']],
  a: [['er', ''], ['est', ''], ['er', 'e'], ['est', 'e'], ['ier', 'y'], ['iest', 'y']],
  r: [],
};

// lemma -> [{ pos, offsets }]
let index = null;
const dataFiles = {};

function loadIndex() {
  if (index) return index;
  index = new Map();
  for (const [pos, { file }] of Object.entries(PARTS)) {
    const text = fs.readFileSync(path.join(DICT, `index.${file}`), 'latin1');
    for (const line of text.split('\n')) {
      if (!line || line.startsWith(' ')) continue; // The licence header is indented.
      const fields = line.trim().split(' ');
      const synsetCount = Number(fields[2]);
      const offsets = fields.slice(fields.length - synsetCount).map(Number);
      const entries = index.get(fields[0]) ?? [];
      entries.push({ pos, offsets });
      index.set(fields[0], entries);
    }
  }
  return index;
}

// word (with Wiktionary's capitals) -> { pos: [etymology, ...] }
let etymologies = null;

function loadEtymologies() {
  if (etymologies) return etymologies;
  try {
    etymologies = JSON.parse(zlib.gunzipSync(fs.readFileSync(ETYMOLOGY_FILE)).toString('utf8'));
  } catch (error) {
    console.error(`Etymologies could not be read: ${error.message}`);
    etymologies = {};
  }
  return etymologies;
}

function etymologiesOf(word, pos) {
  return loadEtymologies()[word]?.[pos] ?? [];
}

// Reads the line of data.<pos> that starts at byte `offset`.
function readLine(pos, offset) {
  dataFiles[pos] ??= fs.openSync(path.join(DICT, `data.${PARTS[pos].file}`), 'r');
  let size = 1024;
  for (;;) {
    const buffer = Buffer.alloc(size);
    const read = fs.readSync(dataFiles[pos], buffer, 0, size, offset);
    const end = buffer.indexOf(10, 0); // newline
    if (end !== -1 && end < read) return buffer.toString('latin1', 0, end);
    if (read < size) return buffer.toString('latin1', 0, read);
    size *= 2;
  }
}

const cleanWord = (word) => word.replace(/\(.*\)$/, '').replace(/_/g, ' ');

function readSynset(pos, offset) {
  const line = readLine(pos, offset);
  const bar = line.indexOf(' | ');
  const fields = line.slice(0, bar).split(' ');
  const wordCount = parseInt(fields[3], 16);
  const words = [];
  for (let i = 0; i < wordCount; i++) words.push(cleanWord(fields[4 + i * 2]));

  let at = 4 + wordCount * 2;
  const pointerCount = Number(fields[at++]);
  const pointers = [];
  for (let i = 0; i < pointerCount; i++, at += 4) {
    const [symbol, target, targetPos, sourceTarget] = fields.slice(at, at + 4);
    pointers.push({
      symbol,
      offset: Number(target),
      pos: PART_OF[targetPos],
      source: parseInt(sourceTarget.slice(0, 2), 16), // 0 = the whole synset
      target: parseInt(sourceTarget.slice(2), 16),
    });
  }

  // The gloss is a definition followed by "quoted examples", separated by "; ".
  const gloss = line.slice(bar + 3).trim();
  const parts = gloss.split(/;\s*(?=")/);
  const definition = parts[0].trim();
  const examples = parts.slice(1).map((part) => part.trim().replace(/^"|"[;\s]*$/g, ''));
  return { words, pointers, definition, examples };
}

// The base forms of `word` that WordNet has, by part of speech.
function baseForms(word) {
  const lemmas = loadIndex();
  const key = word.toLowerCase().trim().replace(/\s+/g, '_').replace(/[’]/g, "'");
  const found = [];
  const add = (lemma, pos) => {
    if (!found.some((f) => f.lemma === lemma && f.pos === pos)) found.push({ lemma, pos });
  };

  for (const entry of lemmas.get(key) ?? []) add(key, entry.pos);
  for (const pos of Object.keys(PARTS)) {
    for (const [suffix, ending] of SUFFIX_RULES[pos]) {
      if (!key.endsWith(suffix) || key.length <= suffix.length + 1) continue;
      const stem = key.slice(0, -suffix.length);
      const candidates = [stem + ending];
      // "stopped" -> "stopp" -> "stop"
      if (!ending && /([^aeiou])\1$/.test(stem)) candidates.push(stem.slice(0, -1));
      for (const candidate of candidates) {
        if (lemmas.get(candidate)?.some((entry) => entry.pos === pos)) add(candidate, pos);
      }
    }
  }
  return found;
}

const unique = (words, exclude) => [...new Set(words)].filter((word) => word.toLowerCase() !== exclude);

// Everything WordNet knows about `word`: one entry per base form and part of
// speech, each with its senses. Each sense has a definition, examples,
// synonyms, similar words (for adjectives), antonyms and broader terms. Each
// entry also has its etymologies from Wiktionary, if there are any.
function lookup(word) {
  const entries = [];
  for (const { lemma, pos } of baseForms(word)) {
    const offsets = loadIndex().get(lemma).find((entry) => entry.pos === pos).offsets;
    const display = lemma.replace(/_/g, ' ');

    const senses = offsets.map((offset) => {
      const synset = readSynset(pos, offset);
      const wordIndex = synset.words.findIndex((w) => w.toLowerCase() === display) + 1;
      const synonyms = [...synset.words];
      const similar = [];
      const antonyms = [];
      const broader = [];

      for (const pointer of synset.pointers) {
        if (pointer.symbol === '&') {
          // Adjectives are grouped in clusters of similar meanings.
          similar.push(...readSynset(pointer.pos, pointer.offset).words);
        } else if (pointer.symbol === '!' && (pointer.source === 0 || pointer.source === wordIndex)) {
          const target = readSynset(pointer.pos, pointer.offset).words;
          antonyms.push(...(pointer.target ? [target[pointer.target - 1]] : target));
        } else if (pointer.symbol === '@' || pointer.symbol === '@i') {
          broader.push(...readSynset(pointer.pos, pointer.offset).words);
        }
      }

      return {
        definition: synset.definition,
        examples: synset.examples,
        synonyms: unique(synonyms, display),
        similar: unique(similar, display),
        antonyms: unique(antonyms, display),
        broader: unique(broader, display),
      };
    });

    // The index is lower case; the synsets keep proper capitals ("New York").
    const proper = readSynset(pos, offsets[0]).words.find((w) => w.toLowerCase() === display);
    const shown = proper ?? display;
    entries.push({ word: shown, partOfSpeech: PARTS[pos].label, senses, etymologies: etymologiesOf(shown, pos) });
  }
  return { query: word, entries };
}

function preload() {
  loadIndex();
  loadEtymologies();
}

module.exports = { lookup, preload };
