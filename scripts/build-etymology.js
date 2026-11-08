// Builds data/etymology.json.gz from Kaikki.org's extract of English Wiktionary.
// Only words that WordNet has are kept, since those are the only ones the
// dictionary can show.
//
//   1. Download https://kaikki.org/dictionary/English/kaikki.org-dictionary-English.jsonl.gz
//   2. node scripts/build-etymology.js <path to that file>
//
// The output maps a word (as Wiktionary spells it, with its capitals) to its
// etymologies by WordNet part of speech: { "bank": { "n": ["From ...", ...] } }.
// Wiktionary's text is licensed CC BY-SA 4.0; the output file is too.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const zlib = require('zlib');
const { path: DICT } = require('wordnet-db');

// Kaikki part of speech -> WordNet part of speech.
const POS = { noun: 'n', name: 'n', verb: 'v', adj: 'a', adv: 'r' };
const WORDNET_FILES = { n: 'noun', v: 'verb', a: 'adj', r: 'adv' };

// WordNet's lemmas, by part of speech, lower case with spaces.
function wordnetLemmas() {
  const lemmas = {};
  for (const [pos, file] of Object.entries(WORDNET_FILES)) {
    lemmas[pos] = new Set();
    const text = fs.readFileSync(path.join(DICT, `index.${file}`), 'latin1');
    for (const line of text.split('\n')) {
      if (!line || line.startsWith(' ')) continue;
      lemmas[pos].add(line.slice(0, line.indexOf(' ')).replace(/_/g, ' '));
    }
  }
  return lemmas;
}

// Texts that only point elsewhere aren't worth showing.
const UNHELPFUL = /^(see (the )?etymology|see the (main|corresponding) entry)/i;

// Wiktionary's etymology-tree diagram comes through as a run of words before
// the prose: "Etymology tree Proto-Germanic *bankiz ... Middle English banke
// English bank Inherited from ...", often first, sometimes later on. A
// "PIE word *bʰeg-" box may come before everything. The tree always ends with
// the (modern) English headword, so cut through that; if that can't be found,
// drop everything from the tree on.
const TREE = 'Etymology tree ';
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function withoutTree(text, word) {
  const treeEnd = new RegExp(`(?<!(Middle|Old|Modern) )English ${escapeRegExp(word)} `);
  const withoutBoxes = (s) => s.replace(/^(PIE word \S+ )+/, '');
  text = withoutBoxes(text);
  for (let at = text.indexOf(TREE); at !== -1; at = text.indexOf(TREE)) {
    const rest = text.slice(at + TREE.length);
    const end = treeEnd.exec(rest);
    text = withoutBoxes(`${text.slice(0, at)} ${end ? rest.slice(end.index + end[0].length) : ''}`.trim());
  }
  return text;
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error('Usage: node scripts/build-etymology.js <kaikki.org-dictionary-English.jsonl[.gz]>');
    process.exit(1);
  }
  const lemmas = wordnetLemmas();
  let stream = fs.createReadStream(input);
  if (input.endsWith('.gz')) stream = stream.pipe(zlib.createGunzip());

  const out = {};
  let lines = 0;
  let kept = 0;
  for await (const line of readline.createInterface({ input: stream, crlfDelay: Infinity })) {
    if (++lines % 200000 === 0) console.log(`${lines} lines read, ${kept} etymologies kept`);
    if (!line.includes('"etymology_text"')) continue; // Skip parsing most lines.
    const record = JSON.parse(line);
    const pos = POS[record.pos];
    if (!pos || record.lang_code !== 'en' || !record.word) continue;
    if (!lemmas[pos].has(record.word.toLowerCase())) continue;
    const text = withoutTree(record.etymology_text?.replace(/\s+/g, ' ').trim() ?? '', record.word);
    if (!text || UNHELPFUL.test(text)) continue;

    const byPos = (out[record.word] ??= {});
    const texts = (byPos[pos] ??= []);
    if (!texts.includes(text)) {
      texts.push(text);
      kept++;
    }
  }

  const target = path.join(__dirname, '..', 'data', 'etymology.json.gz');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, zlib.gzipSync(JSON.stringify(out), { level: 9 }));
  const size = (fs.statSync(target).size / 1e6).toFixed(1);
  console.log(`${Object.keys(out).length} words, ${kept} etymologies -> ${target} (${size} MB)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
