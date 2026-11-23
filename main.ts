// main.ts is mend, the CLI SPEC.md specifies (MIT). It reads edits in four formats — unified diffs, SEARCH/REPLACE
// blocks, V4A patches and JSON tool calls — matches the lines they name at three tiers (exact, trailing-whitespace
// drift, indentation drift), and changes every file or none. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its own line break, and whether it ends with one (SPEC.md section 3). */
interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitText(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinText(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Move edits that succeeded, as [old path, new path], for the `R` output lines. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/* Section 5: matching lines at three tiers. */

const rtrimST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function eqAt(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimST(a) === rtrimST(b);
  return trimST(a) === trimST(b);
}

/** The first tier at which O occurs in `lines`, with every 0-based occurrence position there; null when none. */
function findOccurrences(lines: string[], o: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = 0; i + o.length <= lines.length; i += 1) {
      let ok = true;
      for (let k = 0; k < o.length; k += 1) {
        if (!eqAt(lines[i + k]!, o[k]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One line an edit writes: a context line (written as the file's own matched line), an old line (consumed, not
 * written), or a new line. */
interface OutLine {
  ctx: boolean;
  text: string;
  old?: boolean;
}

/** The lines N becomes when it replaces O matched at `pos` in `lines` (SPEC.md section 5). */
function buildLines(lines: string[], pos: number, o: string[], items: OutLine[], tier: number): string[] {
  const out: string[] = [];
  let oi = 0;
  for (const it of items) {
    if (it.ctx) {
      out.push(lines[pos + oi]!);
      oi += 1;
    } else if (it.old === true) {
      oi += 1;
    } else if (tier === 2 && it.text !== '' && trimST(it.text) !== '') {
      const f = leadWS(lines[pos]!);
      const p = leadWS(o[0]!);
      out.push(it.text.startsWith(p) ? f + it.text.slice(p.length) : it.text);
    } else {
      out.push(it.text);
    }
  }
  return out;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* Section 6: unified diffs. */

interface UBodyLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  noEol: boolean;
}
interface UHunk {
  a: number;
  body: UBodyLine[];
}
interface USection {
  gitOld: string | null;
  gitNew: string | null;
  oldPath: string | null;
  newPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UHunk[];
}

function headerPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  const newSection = (): USection => {
    const s: USection = { gitOld: null, gitNew: null, oldPath: null, newPath: null, renameFrom: null, renameTo: null, newFile: false, deletedFile: false, hunks: [] };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^a\/(.+?) b\/(.+)$/.exec(line.slice('diff --git '.length));
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.gitOld = m[1]!;
      s.gitNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (!(inHeader && cur !== null && cur.oldPath === null)) newSection();
      cur!.oldPath = headerPath(line);
      cur!.newPath = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (inHeader && cur !== null) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deletedFile = true;
        i += 1;
        continue;
      }
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const body: UBodyLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '') {
          body.push({ kind: 'ctx', text: '', noEol: false });
          j += 1;
          continue;
        }
        const c = l[0]!;
        if (c === ' ') body.push({ kind: 'ctx', text: l.slice(1), noEol: false });
        else if (c === '-') body.push({ kind: 'old', text: l.slice(1), noEol: false });
        else if (c === '+') body.push({ kind: 'new', text: l.slice(1), noEol: false });
        else if (c === '\\') {
          if (body.length > 0) body[body.length - 1]!.noEol = true;
          j += 1;
          continue;
        } else break;
        j += 1;
      }
      while (body.length > 0) {
        const last = body[body.length - 1]!;
        if (last.kind === 'ctx' && last.text === '' && !last.noEol) body.pop();
        else break;
      }
      cur.hunks.push({ a: Number(m[1]), body });
      i = j;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

function unifiedSectionEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath ?? sec.renameFrom ?? sec.gitOld;
    const newP = sec.newPath ?? sec.renameTo ?? sec.gitNew;
    const isCreate = sec.oldPath === '/dev/null' || sec.newFile;
    const isDelete = sec.newPath === '/dev/null' || sec.deletedFile;
    if (isCreate) {
      const p = newP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const out: string[] = [];
      let lastPlus: UBodyLine | null = null;
      for (const h of sec.hunks) {
        for (const b of h.body) {
          if (b.kind === 'new') {
            out.push(b.text);
            lastPlus = b;
          }
        }
      }
      const final = lastPlus === null ? false : !lastPlus.noEol;
      tree.now.set(p, out.length === 0 ? '' : out.join('\n') + (final ? '\n' : ''));
      return;
    }
    if (isDelete) {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const from = oldP!;
    const to = newP!;
    if (!safe(from)) throw new Fail('unsafe', from);
    if (to !== from && !safe(to)) throw new Fail('unsafe', to);
    const before = tree.get(from);
    if (before === null) throw new Fail('missing', from);
    if (to !== from && tree.get(to) !== null) throw new Fail('exists', to);
    const f = splitText(before);
    let d = 0;
    for (const h of sec.hunks) {
      const o: string[] = [];
      const items: OutLine[] = [];
      for (const b of h.body) {
        if (b.kind === 'ctx') {
          o.push(b.text);
          items.push({ ctx: true, text: b.text });
        } else if (b.kind === 'old') {
          o.push(b.text);
          items.push({ ctx: false, text: b.text, old: true });
        } else {
          items.push({ ctx: false, text: b.text });
        }
      }
      const nCount = h.body.filter((b) => b.kind !== 'old').length;
      if (o.length === 0) {
        const pos = Math.min(h.a + d, f.lines.length);
        const added = items.map((it) => it.text);
        const atEnd = pos === f.lines.length;
        f.lines.splice(pos, 0, ...added);
        if (atEnd && added.length > 0) {
          const lastNew = [...h.body].reverse().find((b) => b.kind === 'new');
          if (lastNew !== undefined) f.final = !lastNew.noEol;
        }
        d += added.length;
        continue;
      }
      const found = findOccurrences(f.lines, o, strict);
      if (found === null) throw new Fail('no-match', from);
      const target = h.a - 1 + d;
      let pos = found.positions[0]!;
      for (const p of found.positions) {
        if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      }
      const runsToEnd = pos + o.length === f.lines.length;
      const built = buildLines(f.lines, pos, o, items, found.tier);
      f.lines.splice(pos, o.length, ...built);
      if (runsToEnd) {
        const lastCN = [...h.body].reverse().find((b) => b.kind !== 'old');
        if (lastCN !== undefined) f.final = !lastCN.noEol;
        else f.final = f.lines.length > 0;
      }
      d += nCount - o.length;
    }
    if (to !== from) {
      tree.now.set(from, null);
      tree.now.set(to, joinText(f));
      tree.moves.push([from, to]);
    } else {
      tree.now.set(to, joinText(f));
    }
  };
}

/* Section 7: SEARCH/REPLACE blocks. */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: { path: string; oldLines: string[]; newLines: string[] }[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    let k = i + 1;
    const oldLines: string[] = [];
    while (k < lines.length && lines[k]!.trimEnd() !== '=======' && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') {
      oldLines.push(lines[k]!);
      k += 1;
    }
    if (k >= lines.length || lines[k]!.trimEnd() !== '=======') throw new Exit2(`error: parse ${searchLine + 1}`);
    k += 1;
    const newLines: string[] = [];
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') {
      newLines.push(lines[k]!);
      k += 1;
    }
    if (k >= lines.length) throw new Exit2(`error: parse ${searchLine + 1}`);
    blocks.push({ path, oldLines, newLines });
    prevPath = path;
    prevEnd = k + 1;
    i = k + 1;
  }
  return blocks.map((b) => {
    const { path, oldLines, newLines } = b;
    return (tree: Tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (oldLines.length === 0) {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      const f = splitText(before);
      const found = findOccurrences(f.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', path);
      if (found.positions.length > 1) throw new Fail('ambiguous', path);
      const pos = found.positions[0]!;
      const items: OutLine[] = newLines.map((t) => ({ ctx: false, text: t }));
      const built = buildLines(f.lines, pos, oldLines, items, found.tier);
      f.lines.splice(pos, oldLines.length, ...built);
      tree.now.set(path, joinText(f));
    };
  });
}

/* Section 8: V4A patches. */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: UBodyLine[];
}
interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  fileLines: string[];
  moveTo: string | null;
  chunks: VChunk[];
  line: number;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const fb = lines.findIndex((l) => !blank(l));
  if (fb < 0) throw new Exit2('error: parse 1');
  if (lines[fb]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${fb + 1}`);
  let lb = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      lb = k;
      break;
    }
  }
  if (lines[lb]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = fb + 1;
  while (i < lb) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File:')) {
      const path = line.slice('*** Add File:'.length).trim();
      const fileLines: string[] = [];
      let j = i + 1;
      while (j < lb && !lines[j]!.startsWith('*** ')) {
        const l = lines[j]!;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${j + 1}`);
        j += 1;
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      sections.push({ kind: 'add', path, fileLines, moveTo: null, chunks: [], line: i + 1 });
      i = j;
      continue;
    }
    if (line.startsWith('*** Delete File:')) {
      const path = line.slice('*** Delete File:'.length).trim();
      let j = i + 1;
      while (j < lb && !lines[j]!.startsWith('*** ')) {
        if (!blank(lines[j]!)) throw new Exit2(`error: parse ${j + 1}`);
        j += 1;
      }
      sections.push({ kind: 'delete', path, fileLines: [], moveTo: null, chunks: [], line: i + 1 });
      i = j;
      continue;
    }
    if (line.startsWith('*** Update File:')) {
      const path = line.slice('*** Update File:'.length).trim();
      const raw: { text: string; no: number }[] = [];
      let j = i + 1;
      let moveTo: string | null = null;
      if (j < lb && lines[j]!.startsWith('*** Move to:')) {
        moveTo = lines[j]!.slice('*** Move to:'.length).trim();
        j += 1;
      }
      while (j < lb) {
        const l = lines[j]!;
        if (l.startsWith('*** ') && l.trim() !== '*** End of File') break;
        raw.push({ text: l, no: j + 1 });
        j += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (const { text: l, no } of raw) {
        if (l.trim() === '*** End of File') {
          if (cur === null) {
            cur = { anchor: null, eof: true, body: [] };
            chunks.push(cur);
          }
          cur.eof = true;
          cur = null;
          continue;
        }
        if (l.startsWith('@@')) {
          const anchorText = l.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
          chunks.push(cur);
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
          }
          if (l === '') cur.body.push({ kind: 'ctx', text: '', noEol: false });
          else if (l[0] === ' ') cur.body.push({ kind: 'ctx', text: l.slice(1), noEol: false });
          else if (l[0] === '-') cur.body.push({ kind: 'old', text: l.slice(1), noEol: false });
          else cur.body.push({ kind: 'new', text: l.slice(1), noEol: false });
          continue;
        }
        throw new Exit2(`error: parse ${no}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      sections.push({ kind: 'update', path, fileLines: [], moveTo, chunks, line: i + 1 });
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections.map((s) => v4aSectionEdit(s, strict));
}

function v4aSectionEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, sec.fileLines.length === 0 ? '' : sec.fileLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (sec.moveTo !== null) {
      if (!safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
      if (tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    }
    const f = splitText(before);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        const tiers = strict ? [0] : [0, 1, 2];
        let at = -1;
        for (const tier of tiers) {
          for (let k = cursor; k < f.lines.length; k += 1) {
            if (eqAt(f.lines[k]!, chunk.anchor, tier)) {
              at = k;
              break;
            }
          }
          if (at >= 0) break;
        }
        if (at < 0) throw new Fail('no-match', p);
        cursor = at + 1;
      }
      const o: string[] = [];
      const items: OutLine[] = [];
      for (const b of chunk.body) {
        if (b.kind === 'ctx') {
          o.push(b.text);
          items.push({ ctx: true, text: b.text });
        } else if (b.kind === 'old') {
          o.push(b.text);
          items.push({ ctx: false, text: b.text, old: true });
        } else {
          items.push({ ctx: false, text: b.text });
        }
      }
      if (o.length === 0) {
        const pos = chunk.eof ? f.lines.length : Math.min(cursor, f.lines.length);
        const added = items.map((it) => it.text);
        f.lines.splice(pos, 0, ...added);
        cursor = pos + added.length;
        continue;
      }
      const found = findOccurrences(f.lines, o, strict);
      if (found === null) throw new Fail('no-match', p);
      const candidates = found.positions.filter((x) => x >= cursor && (!chunk.eof || x + o.length === f.lines.length));
      if (candidates.length === 0) throw new Fail('no-match', p);
      const pos = candidates[0]!;
      const built = buildLines(f.lines, pos, o, items, found.tier);
      f.lines.splice(pos, o.length, ...built);
      cursor = pos + built.length;
    }
    if (sec.moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(sec.moveTo, joinText(f));
      tree.moves.push([p, sec.moveTo]);
    } else {
      tree.now.set(p, joinText(f));
    }
  };
}

/* Section 9: JSON edits. */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p)!);
  // A move edit whose old path is gone afterwards and whose new path is new prints one R line for the pair.
  const consumed = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const [o, nw] of tree.moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(nw) === null && tree.get(nw) !== null && !consumed.has(o) && !consumed.has(nw)) {
      rows.push({ key: nw, line: `R ${o} -> ${nw}` });
      consumed.add(o);
      consumed.add(nw);
    }
  }
  for (const p of changed) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byBytes(a.key, b.key));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
