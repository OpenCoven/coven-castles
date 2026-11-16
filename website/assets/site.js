const one = selector => document.querySelector(selector);
const all = selector => [...document.querySelectorAll(selector)];
const announce = text => { one('#announcement').textContent = text; };
const theme = one('#theme-toggle');
function reflectTheme() {
  const dark = document.documentElement.dataset.theme !== 'light';
  theme.textContent = dark ? 'Light mode ☼' : 'Dark mode ☾';
  theme.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
}
reflectTheme();
theme.addEventListener('click', () => {
  const value = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = value;
  try { localStorage.setItem('castles-theme', value); } catch { /* Theme still works for this page. */ }
  reflectTheme();
});
const menu = one('#menu-toggle');
const narrow = matchMedia('(max-width: 767px)');
function reflectSidebar() {
  const hidden = narrow.matches && menu.getAttribute('aria-expanded') !== 'true';
  const sidebar = one('#sidebar');
  if (hidden && sidebar.contains(document.activeElement)) menu.focus();
  sidebar.inert = hidden;
  if (hidden) sidebar.setAttribute('aria-hidden', 'true');
  else sidebar.removeAttribute('aria-hidden');
}
function closeMenu() {
  document.body.classList.remove('nav-open');
  one('#nav-backdrop').hidden = true;
  menu.setAttribute('aria-expanded', 'false');
  menu.setAttribute('aria-label', 'Open navigation');
  reflectSidebar();
}
menu.addEventListener('click', () => {
  const open = menu.getAttribute('aria-expanded') !== 'true';
  document.body.classList.toggle('nav-open', open);
  one('#nav-backdrop').hidden = !open;
  menu.setAttribute('aria-expanded', String(open));
  menu.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  reflectSidebar();
});
narrow.addEventListener('change', closeMenu);
reflectSidebar();
one('#nav-backdrop').addEventListener('click', closeMenu);
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });
all('.copy').forEach(button => button.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(button.closest('figure').querySelector('code').textContent);
    button.textContent = 'Copied';
    announce('Code copied to clipboard.');
  } catch {
    button.textContent = 'Select code';
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(button.closest('figure').querySelector('code'));
    selection.removeAllRanges(); selection.addRange(range);
    announce('Clipboard unavailable. Code selected for manual copying.');
  }
  setTimeout(() => { button.textContent = 'Copy'; }, 2000);
}));
const dialog = one('#search-dialog');
const input = one('#search-input');
const results = one('#search-results');
const status = one('#search-status');
let index;
async function loadIndex() {
  if (index) return index;
  const response = await fetch('/search-index.json');
  if (!response.ok) throw Error('Search index unavailable');
  index = await response.json();
  return index;
}
function render(entries) {
  results.replaceChildren();
  for (const entry of entries) {
    const li = document.createElement('li');
    const link = document.createElement('a');
    link.href = entry.url;
    const title = document.createElement('strong'); title.textContent = entry.title;
    const page = document.createElement('span'); page.textContent = entry.page;
    link.append(title, page); li.append(link); results.append(li);
    link.addEventListener('click', () => dialog.close());
  }
}
async function search() {
  try {
    const entries = await loadIndex();
    const terms = input.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const matches = terms.length ? entries.filter(entry => terms.every(term => `${entry.title} ${entry.page} ${entry.text}`.toLowerCase().includes(term))).slice(0, 12) : entries.filter(entry => entry.title === entry.page);
    render(matches);
    status.textContent = terms.length ? `${matches.length} result${matches.length === 1 ? '' : 's'}${matches.length ? '' : '. Try another term or browse the sidebar.'}` : 'Search only Coven Castles documentation.';
  } catch { status.textContent = 'Search could not load. Browse the documentation sidebar instead.'; }
}
function openSearch() { closeMenu(); dialog.showModal(); input.focus(); search(); }
all('.search-trigger').forEach(button => button.addEventListener('click', openSearch));
one('#search-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
input.addEventListener('input', search);
input.addEventListener('keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); results.querySelector('a')?.focus(); } });
results.addEventListener('keydown', event => {
  const links = [...results.querySelectorAll('a')]; const position = links.indexOf(document.activeElement);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const next = position + (event.key === 'ArrowDown' ? 1 : -1); if (next < 0) input.focus(); else links[Math.min(next, links.length - 1)]?.focus(); }
});
document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); if (!dialog.open) openSearch(); } });
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => { for (const entry of entries) if (entry.isIntersecting) { all('.toc a').forEach(link => link.classList.toggle('active', link.hash === `#${entry.target.id}`)); } }, { rootMargin: '-10% 0px -65% 0px' });
  all('main h2[id]').forEach(heading => observer.observe(heading));
}
