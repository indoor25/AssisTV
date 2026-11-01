// Переделывает папку сборки под старые TV (Tizen 3–5, Chromium 47+). Вызывается из build-wgt.ps1 -Legacy:
//   node tools/legacy/build-legacy.js <stageDir>
// 1) все .js → ES5 (Babel) с проверкой парсером ES5; 2) полифилы core-js и regenerator + legacy-shim.js первыми
// скриптами; 3) css/legacy.css перед style.css: замена gap у flex и сетки (только под html.no-flex-gap / .no-grid,
// классы ставит legacy-shim.js); 4) required_version в config.xml → 3.0.
const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');
const acorn = require('acorn');

const stage = path.resolve(process.argv[2] || '');
if (!fs.existsSync(path.join(stage, 'config.xml'))) { console.error('нет config.xml в', stage); process.exit(1); }

// ---- 1. JS → ES5
function walk(dir, out) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) walk(f, out); else if (f.endsWith('.js')) out.push(f);
    }
    return out;
}
const babelOpts = {
    babelrc: false, configFile: false, sourceType: 'script', comments: false,
    presets: [[require.resolve('@babel/preset-env'), { targets: 'chrome 47', forceAllTransforms: true, modules: false }]],
};
let bad = 0;
for (const f of walk(stage, [])) {
    const code = babel.transformSync(fs.readFileSync(f, 'utf8'), { ...babelOpts, filename: f }).code;
    try { acorn.parse(code, { ecmaVersion: 5 }); } catch (e) { console.error('не ES5:', path.relative(stage, f), e.message); bad++; }
    fs.writeFileSync(f, code);
}
if (bad) process.exit(1);

// ---- 2. полифилы и шим (кладутся после Babel — они уже ES5)
const legacyDir = path.join(stage, 'legacy');
fs.mkdirSync(legacyDir, { recursive: true });
const style = fs.readFileSync(path.join(stage, 'css', 'style.css'), 'utf8');
const rules = [];
style.replace(/\/\*[\s\S]*?\*\//g, '').replace(/([^{}]+)\{([^{}]*)\}/g, (m, sel, body) => {
    rules.push({ sel: sel.trim(), body, text: sel.trim() + ' {' + body + '}' });
    return '';
});
const varRules = rules.filter(r => /var\(--/.test(r.body)).map(r => r.text).join('\n');
fs.copyFileSync(require.resolve('core-js-bundle/minified.js'), path.join(legacyDir, 'core-js.min.js'));
fs.copyFileSync(require.resolve('regenerator-runtime/runtime.js'), path.join(legacyDir, 'regenerator.js'));
fs.writeFileSync(path.join(legacyDir, 'legacy-shim.js'),
    'window.LEGACY_VAR_RULES = ' + JSON.stringify(varRules) + ';\n' + fs.readFileSync(path.join(__dirname, 'legacy-shim.js'), 'utf8'));

// ---- 3. css/legacy.css
const decl = (body, name) => { const m = new RegExp('(?:^|;)\\s*' + name + '\\s*:\\s*([^;]+)').exec(body); return m ? m[1].trim() : ''; };
const each = (sel, fn) => sel.split(',').map(s => fn(s.trim())).join(', ');
const out = ['/* Сгенерировано tools/legacy/build-legacy.js — только для сборки -Legacy */'];
for (const r of rules) {
    const gap = decl(r.body, 'gap');
    const display = decl(r.body, 'display');
    if (!gap || !/flex/.test(display)) continue;
    const [rowGap, colGap = rowGap] = gap.split(/\s+/);
    const column = /column/.test(decl(r.body, 'flex-direction'));
    if (/wrap/.test(decl(r.body, 'flex-wrap'))) {
        out.push(each(r.sel, s => 'html.no-flex-gap ' + s + ' > *') + ' { margin-right: ' + colGap + '; margin-bottom: ' + rowGap + '; }');
    } else {
        out.push(each(r.sel, s => 'html.no-flex-gap ' + s + ' > * + *') + ' { ' + (column ? 'margin-top: ' + rowGap : 'margin-left: ' + colGap) + '; }');
    }
}
// у кого в style.css отступ auto (прижать к краю) — вернуть его поверх отступов gap
for (const r of rules) {
    const autos = ['margin-left', 'margin-top'].filter(n => decl(r.body, n) === 'auto');
    if (autos.length) out.push(each(r.sel, s => 'html.no-flex-gap ' + s) + ' { ' + autos.map(n => n + ': auto').join('; ') + '; }');
}
// сетки → flex с переносом (размер плиток главного экрана ставит legacy-shim.js)
out.push(
    'html.no-grid .home-grid { display: flex; flex-wrap: wrap; justify-content: center; align-content: center; margin: 0 -6px; }',
    'html.no-grid .home-grid > * { margin: 6px; }',
    'html.no-grid .vod-grid { display: flex; flex-wrap: wrap; align-content: flex-start; margin-right: -24px; }',
    'html.no-grid .vod-grid > * { width: 270px; height: 530px; margin: 0 24px 24px 0; }',
    'html.no-grid .vod-episodes { display: flex; flex-wrap: wrap; }',
    'html.no-grid .vod-episodes > * { box-sizing: border-box; width: calc((100% - 70px) / 6); margin: 0 14px 14px 0; }',
    'html.no-grid .vod-episodes > :nth-child(6n) { margin-right: 0; }',
    'html.no-grid .vod-episodes-more, html.no-grid .home-locked { width: 100% !important; margin-right: 0; }'
);
fs.writeFileSync(path.join(stage, 'css', 'legacy.css'), out.join('\n') + '\n');

// ---- index.html: legacy.css перед style.css, полифилы и шим — перед первым скриптом
const indexPath = path.join(stage, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');
html = html.replace('<link rel="stylesheet" href="css/style.css">',
    '<link rel="stylesheet" href="css/legacy.css">\n<link rel="stylesheet" href="css/style.css">');
html = html.replace(/(\s*)<script /, '$1<script src="legacy/core-js.min.js"></script>$1<script src="legacy/regenerator.js"></script>' +
    '$1<script src="legacy/legacy-shim.js"></script>$1<script ');
if (!html.includes('legacy/legacy-shim.js') || !html.includes('css/legacy.css')) { console.error('index.html: не нашёл, куда вставить'); process.exit(1); }
fs.writeFileSync(indexPath, html);

// ---- 4. config.xml
const cfgPath = path.join(stage, 'config.xml');
fs.writeFileSync(cfgPath, fs.readFileSync(cfgPath, 'utf8').replace(/required_version="[^"]*"/, 'required_version="3.0"'));
console.log('legacy: JS → ES5, полифилы, css/legacy.css (' + (out.length - 1) + ' правил), required_version 3.0');
