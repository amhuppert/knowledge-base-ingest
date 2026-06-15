#!/usr/bin/env node
// Build a self-contained, interactive HTML docs page from the Markdown sources.
// The Markdown files remain the source of truth; this only generates docs/index.html.
//
//   node scripts/build-docs.mjs   (or: pnpm docs:html)

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { marked } from 'marked';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const DOCS = [
  { id: 'overview', title: 'Overview', file: 'README.md' },
  { id: 'user-guide', title: 'User Guide', file: 'docs/USER_GUIDE.md' },
  { id: 'architecture', title: 'Architecture', file: 'docs/ARCHITECTURE.md' },
  { id: 'design', title: 'Design Record', file: 'docs/DESIGN.md' },
];
const DOC_MAP = { README: 'overview', USER_GUIDE: 'user-guide', ARCHITECTURE: 'architecture', DESIGN: 'design' };

marked.setOptions({ gfm: true });

// ---------------------------------------------------------------------------
// helpers
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const slugify = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// ---------------------------------------------------------------------------
// build-time syntax highlighter (operates on raw code, emits escaped+spanned HTML)
const KW = {
  ts: 'import export from const let var function return if else for of in new class interface type extends implements async await throw try catch finally this readonly public private protected void enum as default'.split(' '),
  js: 'import export from const let var function return if else for of in new class async await throw try catch finally this default'.split(' '),
  bash: 'export cd echo for do done if then fi else function local exec set source eval read while case esac'.split(' '),
};
const SQLKW = 'create table strict primary key foreign references not null unique index on text integer real blob default check in as select from where insert into values update set delete virtual using trigger after before begin end with recursive union all order by limit and or pragma cascade autoincrement on conflict do nothing exists'.split(' ');

function lexer(lang) {
  const parts = [];
  const block = lang === 'ts' || lang === 'js' || lang === 'jsonc' || lang === 'sql';
  if (block) parts.push('(?<bc>/\\*[\\s\\S]*?\\*/)');
  if (lang === 'ts' || lang === 'js' || lang === 'jsonc') parts.push('(?<lc>//[^\\n]*)');
  else if (lang === 'bash' || lang === 'sh') parts.push('(?<lc>#[^\\n]*)');
  else if (lang === 'sql') parts.push('(?<lc>--[^\\n]*)');
  parts.push('(?<str>"(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|`(?:\\\\.|[^`\\\\])*`)');
  parts.push('(?<num>\\b\\d+(?:\\.\\d+)?\\b)');
  parts.push('(?<id>[A-Za-z_$][\\w$]*)');
  return new RegExp(parts.join('|'), 'g');
}

function highlight(raw, lang) {
  if (!raw) return '';
  const l = (lang || '').toLowerCase();
  if (!l || l === 'text' || l === 'txt' || l === 'console') return esc(raw);
  const re = lexer(l);
  const kwset = new Set(l === 'sql' ? SQLKW : KW[l] || []);
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(raw))) {
    out += esc(raw.slice(last, m.index));
    const g = m.groups;
    const text = m[0];
    let cls = null;
    if (g.bc || g.lc) cls = 'c';
    else if (g.str) cls = 's';
    else if (g.num) cls = 'n';
    else if (g.id) {
      const key = l === 'sql' ? text.toLowerCase() : text;
      if (kwset.has(key)) cls = 'k';
      else if (/^(true|false|null|undefined)$/.test(text)) cls = 'b';
    }
    out += cls ? `<span class="t-${cls}">${esc(text)}</span>` : esc(text);
    last = m.index + text.length;
  }
  out += esc(raw.slice(last));
  return out;
}

// ---------------------------------------------------------------------------
// post-process marked output
function enhance(html, docId) {
  // code blocks -> figure with header + copy + highlight
  html = html.replace(
    /<pre><code(?:\s+class="language-([\w-]+)")?>([\s\S]*?)<\/code><\/pre>/g,
    (_full, lang, body) => {
      const raw = unesc(body).replace(/\n$/, '');
      const label = lang || 'text';
      return (
        `<figure class="code"><figcaption><span class="lang">${esc(label)}</span>` +
        `<button class="copy" type="button">Copy</button></figcaption>` +
        `<pre><code>${highlight(raw, lang)}</code></pre></figure>`
      );
    },
  );

  // tables -> scroll wrapper
  html = html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>');

  // headings -> ids + anchors, collect TOC
  const toc = [];
  const seen = Object.create(null);
  html = html.replace(/<h([1-6])(?:\s[^>]*)?>([\s\S]*?)<\/h\1>/g, (_full, lvl, inner) => {
    const level = Number(lvl);
    const text = inner.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();
    let id = `${docId}-${slugify(text) || 'section'}`;
    if (seen[id] != null) id = `${id}-${++seen[id]}`;
    else seen[id] = 0;
    if (level >= 2 && level <= 3) toc.push({ level, text, id });
    const anchor = level > 1 ? ` <a class="anchor" href="#${id}" aria-label="Link to section">#</a>` : '';
    return `<h${lvl} id="${id}">${inner}${anchor}</h${lvl}>`;
  });

  // cross-doc links -> in-page tab switches
  html = html.replace(
    /href="(?:\.\/)?(?:docs\/)?(README|USER_GUIDE|ARCHITECTURE|DESIGN)\.md(?:#[\w-]*)?"/g,
    (_full, name) => `href="#${DOC_MAP[name]}" data-doc="${DOC_MAP[name]}"`,
  );

  return { html, toc };
}

// ---------------------------------------------------------------------------
const data = DOCS.map((d) => {
  const md = readFileSync(join(ROOT, d.file), 'utf8');
  const { html, toc } = enhance(marked.parse(md), d.id);
  return { id: d.id, title: d.title, html, toc };
});

const template = readFileSync(join(ROOT, 'scripts/docs-template.html'), 'utf8');
// `<` is escaped so the JSON cannot prematurely close the <script> tag.
const json = JSON.stringify(data).replace(/</g, '\\u003c');
const out = template.replace('__DOCS_DATA__', () => json);
writeFileSync(join(ROOT, 'docs/index.html'), out);

const kb = (out.length / 1024).toFixed(0);
console.log(`docs/index.html written (${kb} KB, ${data.length} docs, ${data.reduce((n, d) => n + d.toc.length, 0)} sections)`);
