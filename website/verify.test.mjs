import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sourceRevision } from './content.mjs';

const root = new URL('./dist/', import.meta.url);
async function files(directory = root) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (entry.name.endsWith('.html')) result.push(path);
  }
  return result;
}

test('every public page retains the offline boundary and exposes one page title', async () => {
  const pages = await files();
  assert.equal(pages.length, 8, 'seven documentation pages and a real 404');
  for (const path of pages) {
    const html = await readFile(path, 'utf8');
    assert.equal((html.match(/<h1[ >]/g) ?? []).length, 1, path.href);
    assert.match(html, /Offline only/);
    assert.match(html, /Live sandbox readiness is not available/);
    assert.match(html, /<html lang="en"/);
    assert.doesNotMatch(html, /coven tui|Coven Code|\/docs\/daemon|API key/i);
  }
});

test('all internal links, fragments, assets and sitemap routes resolve in the static output', async () => {
  for (const path of await files()) {
    const html = await readFile(path, 'utf8');
    for (const [, href] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      if (!href.startsWith('/') && !href.startsWith('#')) continue;
      const target = new URL(href, 'https://castles.opencoven.ai' + path.pathname.slice(root.pathname.length - 1).replace(/index\.html$/, ''));
      const route = target.pathname.endsWith('/') ? target.pathname + 'index.html' : target.pathname;
      const file = join(root.pathname, route);
      const content = await readFile(file, 'utf8').catch(error => { throw new Error(`${path.pathname}: broken ${href}: ${error.message}`); });
      if (target.hash) assert.ok(content.includes(`id="${target.hash.slice(1)}"`), `missing fragment ${href}`);
    }
  }
  const sitemap = await readFile(new URL('sitemap.xml', root), 'utf8');
  for (const route of ['/', '/getting-started/', '/how-it-works/', '/cli-reference/', '/configuration/', '/profile/', '/qualification/']) assert.ok(sitemap.includes(`https://castles.opencoven.ai${route}</loc>`));
});

test('quickstart documents the executable fixture contract rather than live readiness', async () => {
  const html = await readFile(new URL('getting-started/index.html', root), 'utf8');
  const firstExample = html.match(/<pre><code>([\s\S]*?)<\/code><\/pre>/)?.[1];
  assert.ok(firstExample, 'quickstart must provide an executable source checkout');
  const commands = firstExample.split('\n');
  assert.ok(commands.includes(`git checkout --detach ${sourceRevision}`), 'quickstart must check out the documented revision');
  assert.ok(commands.indexOf(`git checkout --detach ${sourceRevision}`) < commands.indexOf('corepack pnpm install --frozen-lockfile'), 'pin the checkout before installing');
  assert.match(html, /corepack pnpm check --fixture fixtures\/preflight\/cases\/ready\.json/);
  assert.match(html, /exit code <strong>3<\/strong>/);
  assert.match(html, /synthetic/i);
  const cli = await readFile(new URL('cli-reference/index.html', root), 'utf8');
  for (const status of ['ready', 'stopped', 'unavailable', 'incompatible', 'unauthorized', 'reconciliation-required']) assert.ok(cli.includes(status));
  assert.match(cli, /live-provider/);
  assert.match(cli, /upstream_seam_missing/);
});

test('local search covers every page and links only to generated pages and headings', async () => {
  const index = JSON.parse(await readFile(new URL('search-index.json', root), 'utf8'));
  assert.ok(Array.isArray(index) && index.length > 7, 'search needs pages and sections');
  const expected = ['/', '/getting-started/', '/how-it-works/', '/cli-reference/', '/configuration/', '/profile/', '/qualification/'];
  for (const route of expected) assert.ok(index.some(entry => entry.url === route && entry.title === entry.page), `missing page ${route}`);
  const urls = new Set();
  for (const entry of index) {
    assert.ok(typeof entry.title === 'string' && entry.title.trim());
    assert.ok(typeof entry.text === 'string' && entry.text.trim());
    assert.ok(typeof entry.page === 'string' && entry.page.trim());
    assert.ok(entry.url.startsWith('/') && !entry.url.startsWith('//'), 'search stays within Castles');
    assert.ok(!urls.has(entry.url), `duplicate search target ${entry.url}`);
    urls.add(entry.url);
    const target = new URL(entry.url, 'https://castles.opencoven.ai');
    assert.ok(expected.includes(target.pathname), `unknown search route ${entry.url}`);
    const html = await readFile(new URL(target.pathname.slice(1) + 'index.html', root), 'utf8');
    if (target.hash) assert.ok(html.includes(`id="${target.hash.slice(1)}"`), `missing search heading ${entry.url}`);
  }
  const css = await readFile(new URL('assets/style.css', root), 'utf8');
  for (const [, asset] of css.matchAll(/url\(['"]?(\/[^)'"\s]+)['"]?\)/g)) await readFile(new URL(asset.slice(1), root));
});

test('qualification distinguishes upstream delivery from Castles integration', async () => {
  const html = await readFile(new URL('qualification/index.html', root), 'utf8');
  assert.match(html, /Review and accept Castles’ integration.*issues\/2/);
  assert.match(html, /upstream capability was delivered.*issues\/296/);
  assert.doesNotMatch(html, /canonical owner, tracked in/);
});
