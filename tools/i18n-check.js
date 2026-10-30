#!/usr/bin/env node
/**
 * Проверка переводов: node tools/i18n-check.js
 *  - каждый ключ, который код передаёт в I18n.t('…'), есть в английском словаре (он запасной);
 *  - у каждого языка — каких ключей не хватает и какие лишние;
 *  - подстановки {name} в переводе те же, что в английском.
 * Код ищется в js/, карточке и аддоне. Выход с кодом 1, если что-то не так.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const langDir = path.join(root, 'lang');
const langs = {};
fs.readdirSync(langDir).filter(f => /^[a-z]{2}\.js$/.test(f)).forEach(f => {
    langs[f.slice(0, 2)] = require(path.join(langDir, f));
});

const sources = [];
function walk(dir) {
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!['node_modules', 'shared'].includes(e.name)) walk(p); }
        else if (/\.js$/.test(e.name)) sources.push(p);
    });
}
walk(path.join(root, 'js'));
walk(path.join(root, 'ha-addon', 'epg_builder'));

// ключи — строковые литералы вида 'группа.имя' в строках, где вызывается перевод (t( / I18n.t( / tr( / this._t()
const used = new Set();
sources.forEach(file => {
    fs.readFileSync(file, 'utf8').split('\n').forEach(line => {
        if (!/\b(?:I18n\.t|_t|tr)\(/.test(line)) return;
        (line.match(/'[a-z][a-zA-Z]*\.[a-zA-Z0-9.]+'/g) || []).forEach(k => { if (!k.endsWith(".'")) used.add(k.slice(1, -1)); });
    });
});

let problems = 0;
const base = langs.en;
const placeholders = s => [...new Set(String(s).match(/\{\w+/g) || [])].sort().join(',');

const missingInEn = [...used].filter(k => !(k in base) && !(k in (langs.ru || {})));
if (missingInEn.length) {
    problems += missingInEn.length;
    console.log('Ключи из кода, которых нет в en.js/ru.js:\n  ' + missingInEn.join('\n  '));
}

Object.keys(langs).sort().forEach(code => {
    const d = langs[code];
    const missing = Object.keys(base).filter(k => !(k in d));
    const extra = Object.keys(d).filter(k => !(k in base));
    const badPh = Object.keys(d).filter(k => k in base && placeholders(d[k]) !== placeholders(base[k]));
    const line = `${code}: ${Object.keys(d).length} фраз` +
        (missing.length ? `, нет ${missing.length}: ${missing.join(', ')}` : '') +
        (extra.length ? `, лишние (нет в en): ${extra.join(', ')}` : '') +
        (badPh.length ? `, другие подстановки: ${badPh.join(', ')}` : '');
    console.log(line);
    problems += missing.length + extra.length + badPh.length;
});

// ключи с динамическим концом (assist.cmd.<команда>, assist.state.<состояние>) в коде целиком не встречаются
const unused = Object.keys(base).filter(k => !used.has(k) && !/^assist.(cmd|state)./.test(k));
if (unused.length) console.log('Не используются в коде (не ошибка, проверьте): ' + unused.join(', '));

console.log(problems ? `Проблем: ${problems}` : 'OK');
process.exit(problems ? 1 : 0);
