/**
 * Pulls the questions you actually asked out of your own session transcripts.
 *
 * A golden set written by whoever built the thing asks what the thing answers.
 * A golden set written by reading the documentation asks what the documentation
 * says. Neither is the set that matters, which is the one made of questions
 * somebody genuinely had -- and those are already recorded, because Claude Code
 * keeps every session as JSONL under ~/.claude/projects.
 *
 * This reads them and prints the questions. It does not score anything and it
 * does not guess the answers: which file is correct is the judgement that
 * cannot be delegated, and is the only part left for a person.
 *
 *   node eval/harvest.mjs                  # this project
 *   node eval/harvest.mjs --all            # every project
 *   node eval/harvest.mjs --min 40         # only longer questions
 *
 * Nothing leaves the machine and nothing is written; the transcripts are read
 * and the questions go to stdout.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');

const args = process.argv.slice(2);
const wantAll = args.includes('--all');
const minLength = Number(args[args.indexOf('--min') + 1]) || 12;

/**
 * Whether a line of user text reads like a question worth scoring.
 *
 * Deliberately loose on the question mark: in practice people ask without one
 * far more often than they add one, and a filter that demanded it would throw
 * away most of the corpus. Interrogatives in both languages carry more signal
 * here than punctuation does.
 */
const INTERROGATIVE = new RegExp(
  [
    '\\?',
    '\\b(why|how|what|where|which|when|does|do|is|are|can|should)\\b',
    '\\b(tai sao|vi sao|the nao|lam sao|nhu the nao|o dau|cai gi|co phai|dung khong|chua)\\b',
    'tại sao|vì sao|thế nào|làm sao|như thế nào|ở đâu|cái gì|có phải|đúng không|chưa',
  ].join('|'),
  'i',
);

/** Commands, pasted output and acknowledgements are not questions. */
function isNoise(text) {
  if (text.startsWith('/') || text.startsWith('<')) return true;
  if (/^(ok|oke|okay|yes|no|next|push|continue|thanks)\b/i.test(text.trim())) return true;
  // A pasted block, not something typed as a question.
  if (text.split('\n').length > 8) return true;
  if (text.includes('```')) return true;
  return false;
}

function textOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

async function harvest(file) {
  const found = [];
  const stream = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of stream) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    // Only what a person typed. Tool results and system reminders arrive on the
    // user role too, and none of them were ever a question.
    if (entry.type !== 'user' || entry.isMeta) continue;

    const text = textOf(entry.message).trim();
    if (!text || text.length < minLength) continue;
    if (isNoise(text)) continue;
    if (!INTERROGATIVE.test(text)) continue;
    if (text.includes('system-reminder') || text.includes('tool_use_id')) continue;

    found.push(text.replace(/\s+/g, ' ').slice(0, 200));
  }
  return found;
}

// Which transcripts to read.
//
// `--all` sweeps every project, and is almost never what you want: questions
// from unrelated work are real questions, but they are not questions about
// *this* repository, and a golden set mixing them measures nothing. `--dir`
// names one project directory under ~/.claude/projects.
const dirFilter = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : null;
const dirs = fs
  .readdirSync(PROJECTS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .filter((entry) => {
    if (dirFilter) return entry.name.toLowerCase().includes(dirFilter.toLowerCase());
    if (wantAll) return true;
    // Default: the directory Claude Code names after the working directory.
    const encoded = process.cwd().replace(/[\\/:]/g, '-').toLowerCase();
    return encoded.includes(entry.name.toLowerCase());
  })
  .map((entry) => path.join(PROJECTS, entry.name));

if (dirs.length === 0) {
  console.log(`No transcripts matched. Looked under ${PROJECTS}.`);
  console.log('Use --dir <name> to name one, or --all to read every project.');
  process.exit(0);
}

let total = 0;
const seen = new Set();
for (const dir of dirs) {
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  for (const name of files) {
    const questions = await harvest(path.join(dir, name));
    if (questions.length === 0) continue;
    console.log(`\n=== ${path.basename(dir)} / ${name.slice(0, 8)} -- ${questions.length} ===`);
    for (const question of questions) {
      // The same question gets asked across sessions; the duplicate is a signal
      // it matters, but printing it twice helps nobody.
      const key = question.toLowerCase().slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      total += 1;
      console.log(`  ${question}`);
    }
  }
}

console.log(`\n${total} distinct questions.`);
console.log('For each one worth keeping, name the file that answers it and the');
console.log('plausible file that must not come back, and add it to golden.json.');
console.log('That second file is the part no script can work out for you.');
