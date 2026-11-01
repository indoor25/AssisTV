// Готовит папку для сайта документации (MkDocs): копия docs/ + главные страницы из README.
// Ссылки на файлы вне docs/ (скрипты HA, плагины, LICENSE…) становятся ссылками на GitHub,
// README.md / README.en.md — главными страницами сайта.
//   node tools/site/prepare.js        → .site-src/  (потом: mkdocs build)
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const DOCS = path.join(ROOT, 'docs');
const OUT = path.join(ROOT, '.site-src');
const REPO = 'https://github.com/indoor25/AssisTV/blob/main/';

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(DOCS, OUT, { recursive: true });

const HOME = { 'README.md': 'index.md', 'README.en.md': 'en/index.md' };

/** text — markdown файла, который на сайте лежит в OUT/<page>, а в репозитории — в ROOT/<from>. */
function fixLinks(text, from, page) {
    const pageDir = path.posix.dirname(page);
    return text.replace(/(\]\(|src="|href=")([^)"\s]+)/g, (m, open, link) => {
        if (/^(https?:|mailto:|#)/.test(link)) return m;
        const [file, hash] = link.split('#');
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(from), file));   // от корня репозитория
        let site = null;
        if (HOME[target]) site = HOME[target];
        else if (target === 'docs' || target.startsWith('docs/')) {
            site = target.slice(5);
            // ссылка на папку — её главная страница
            if (!/\.\w+$/.test(site)) site = (site ? site + '/' : '') + 'index.md';
        }
        if (site === null) return open + REPO + target + (hash ? '#' + hash : '');
        let rel = path.posix.relative(pageDir, site) || path.posix.basename(site);
        return open + rel + (hash ? '#' + hash : '');
    });
}

function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) { walk(full); continue; }
        if (!name.endsWith('.md')) continue;
        const page = path.relative(OUT, full).split(path.sep).join('/');
        const text = fs.readFileSync(full, 'utf8').split('\r\n').join('\n');
        fs.writeFileSync(full, fixLinks(text, 'docs/' + page, page));
    }
}
walk(OUT);
for (const [readme, page] of Object.entries(HOME)) {
    const text = fs.readFileSync(path.join(ROOT, readme), 'utf8').split('\r\n').join('\n');
    fs.writeFileSync(path.join(OUT, page), fixLinks(text, readme, page));
}
console.log('site source: ' + OUT);
