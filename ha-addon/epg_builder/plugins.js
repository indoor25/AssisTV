/**
 * Плагины-источники фильмов: установка, настройки, запуск в песочнице и раздача телевизорам.
 *
 * Откуда берутся файлы (одноимённый файл из следующей папки перекрывает предыдущий):
 *   1. встроенные — shared/vod-sources/*.js в образе аддона (в ядре их сейчас нет: свои источники
 *      пользователь ставит сам);
 *   2. старая папка — /homeassistant/tizen-iptv/plugins/*.js (так ставили до раздела «Плагины»);
 *   3. установленные со страницы аддона — /config/plugins/*.js (папка аддона в addon_configs HA).
 *
 * Состояние — /data/plugins.json: {types: {<тип>: {enabled, offline, name, settings: {url, …}, pid}}, nextPid}.
 * Настройки — форма из манифеста плагина (meta.settings); адрес источника для реестра собирается из них
 * (VodSources.makeUrl), строку вида portal::[key:…]url пользователь больше не пишет. pid — постоянный id
 * «плейлиста» источника для телевизоров (с VOD_PID_BASE, чтобы не совпасть с позициями M3U в опциях).
 *
 * Код плагинов выполняется только в песочнице (sandbox.js). Телевизору его код и настройки (вместе с
 * ключом!) отдаются, лишь если у плагина включено «работать на телевизоре без аддона» (offline) — тогда
 * TV открывает фильмы сам, когда аддон недоступен. Старым плеерам (до 1.3) — все, как раньше.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_SIZE = 512 * 1024;   // плагин — это один файл клиента API, мегабайты тут означают ошибку
const VOD_PID_BASE = 100;
const TYPE_RE = /^[a-z0-9_-]{1,40}$/;
// значения настроек попадают в адрес вида тип::[k:v;k:v]url — разделители внутри ломают разбор
const BAD_VALUE_RE = /[;\]\r\n]/;

const DEFAULT_SETTINGS = [
    { key: 'url', label: 'URL', required: true },
    { key: 'key', label: 'Key', type: 'password' }
];

function createPlugins({ builtinDir, legacyDir, userDir, stateFile, sandbox, VodSources, log }) {
    let items = [];   // [{type, file, code, sha1, sha256, origin, meta, error}]
    let state = readState();

    function readState() {
        try {
            const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
            if (s && s.types) return { types: s.types, nextPid: s.nextPid || VOD_PID_BASE };
        } catch (e) { /* ещё нет */ }
        return { types: {}, nextPid: VOD_PID_BASE };
    }

    function saveState() {
        const tmp = stateFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
        fs.renameSync(tmp, stateFile);
    }

    function entry(type) {
        if (!state.types[type]) state.types[type] = { enabled: false, offline: false, name: '', settings: {}, pid: state.nextPid++ };
        return state.types[type];
    }

    function scanDir(dir, origin) {
        let names = [];
        try { names = fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort(); } catch (e) { return []; }
        return names.map(name => {
            const file = path.join(dir, name);
            const type = name.replace(/\.js$/, '').toLowerCase();
            try {
                if (fs.statSync(file).size > MAX_SIZE) throw new Error(`файл больше ${MAX_SIZE} байт`);
                const code = fs.readFileSync(file, 'utf8');
                return {
                    type, file, code, origin,
                    sha1: crypto.createHash('sha1').update(code).digest('hex').slice(0, 12),
                    sha256: crypto.createHash('sha256').update(code).digest('hex')
                };
            } catch (e) {
                return { type, file, code: null, origin, error: e.message };
            }
        });
    }

    /** Найти файлы и выполнить их в песочнице. При старте и после любой правки со страницы. */
    async function load() {
        const found = new Map();
        scanDir(builtinDir, 'builtin').forEach(p => found.set(p.type, p));
        scanDir(legacyDir, 'legacy').forEach(p => found.set(p.type, p));
        scanDir(userDir, 'user').forEach(p => found.set(p.type, p));
        items = [...found.values()];
        const good = items.filter(p => !p.error);
        let res = {};
        try { res = await sandbox.load(good.map(p => ({ type: p.type, code: p.code }))); } catch (e) {
            good.forEach(p => { p.error = 'песочница: ' + e.message; });
        }
        good.forEach(p => {
            const r = res[p.type];
            if (!r) return;
            if (r.ok) p.meta = r.meta || {}; else p.error = r.error;
        });
        items.forEach(p => { if (p.error) log(`плагин ${p.type}: ${p.error}`); });
        const ok = items.filter(p => !p.error).map(p => p.type);
        log(`источники фильмов: ${ok.length ? ok.join(', ') : 'нет'}` +
            (items.some(p => p.error) ? `; с ошибками: ${items.filter(p => p.error).map(p => p.type).join(', ')}` : ''));
        return items;
    }

    const ready = p => p && !p.error;
    const settingsOf = p => (p && p.meta && Array.isArray(p.meta.settings) && p.meta.settings.length ? p.meta.settings : DEFAULT_SETTINGS);

    /**
     * Строки источников из опций аддона (как было до раздела «Плагины»): у установленного плагина без
     * своих настроек они переносятся в его настройки — один раз. → типы, которые теперь ведёт раздел.
     */
    function importLegacy(vodPlaylists) {
        let changed = false;
        for (const pl of vodPlaylists) {
            const parsed = VodSources.parseUrl(pl.url);
            if (!parsed || !ready(items.find(p => p.type === parsed.type))) continue;
            const e = entry(parsed.type);
            if (e.settings && e.settings.url) continue;
            e.settings = Object.assign({ url: parsed.url }, parsed.params);
            e.name = e.name || pl.name;
            e.enabled = true;
            e.offline = true;   // так работало до сих пор: телевизор ходил к источнику сам
            changed = true;
            log(`плагин ${parsed.type}: настройки перенесены из опций аддона («${pl.name}»)`);
        }
        if (changed) saveState();
    }

    /** Типы, которые ведёт раздел «Плагины» (их строки в опциях аддона больше не нужны). */
    function managedTypes() {
        return Object.keys(state.types).filter(t => state.types[t].settings && state.types[t].settings.url);
    }

    /** Включённые и настроенные источники → «плейлисты» kind: 'vod' для аддона и телевизоров. */
    function sources() {
        return items.filter(ready).map(p => {
            const e = state.types[p.type];
            if (!e || !e.enabled || !e.settings || !e.settings.url) return null;
            const params = {};
            settingsOf(p).forEach(f => { if (f.key !== 'url' && e.settings[f.key] != null) params[f.key] = e.settings[f.key]; });
            Object.keys(e.settings).forEach(k => { if (k !== 'url' && params[k] == null) params[k] = e.settings[k]; });
            return {
                id: e.pid, name: e.name || (p.meta && p.meta.name) || p.type, kind: 'vod', src: p.type,
                url: VodSources.makeUrl(p.type, e.settings.url, params), offline: !!e.offline
            };
        }).filter(Boolean).sort((a, b) => a.id - b.id);
    }

    /** Новый или обновлённый файл: проверить в песочнице и положить в userDir. → {type, meta, updated}. */
    async function install(code) {
        code = String(code || '');
        if (!code.trim()) throw new Error('empty');
        if (Buffer.byteLength(code) > MAX_SIZE) throw new Error('too_large');
        const found = await sandbox.probe(code);
        if (!found.length) throw new Error('no_register');
        if (found.length > 1) throw new Error('many_types');
        const { type, meta } = found[0];
        if (!TYPE_RE.test(type)) throw new Error('bad_type');
        fs.mkdirSync(userDir, { recursive: true });
        const updated = !!items.find(p => p.type === type);
        fs.writeFileSync(path.join(userDir, type + '.js'), code);
        entry(type);
        saveState();
        log(`плагин ${type}: ${updated ? 'обновлён' : 'установлен'} (${(meta && meta.version) || 'без версии'})`);
        await load();
        return { type, meta, updated };
    }

    async function installFromUrl(url) {
        if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('bad_url');
        const res = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'follow' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const len = +res.headers.get('content-length') || 0;
        if (len > MAX_SIZE) throw new Error('too_large');
        return install(await res.text());
    }

    /** Удалить файл плагина (и его настройки). Избранное и история остаются — вернутся с плагином. */
    async function remove(type) {
        const p = items.find(x => x.type === type);
        if (!p) throw new Error('not_found');
        if (p.origin === 'builtin') throw new Error('builtin');
        fs.unlinkSync(p.file);
        delete state.types[type];
        saveState();
        log(`плагин ${type}: удалён`);
        await load();
    }

    /** Правка со страницы: {enabled?, offline?, name?, settings?}. */
    async function update(type, patch) {
        const p = items.find(x => x.type === type);
        if (!p) throw new Error('not_found');
        const e = entry(type);
        if (patch.settings) {
            const next = {};
            for (const f of settingsOf(p)) {
                let v = patch.settings[f.key];
                if (v == null) continue;
                v = String(v).trim();
                // пароль не показывается на странице: пустое поле — оставить прежний
                if (f.type === 'password' && v === '' && e.settings[f.key]) v = e.settings[f.key];
                if (BAD_VALUE_RE.test(v)) throw new Error('bad_value:' + f.key);
                if (v !== '') next[f.key] = v;
            }
            const missing = settingsOf(p).find(f => f.required && !next[f.key]);
            if (missing) throw new Error('required:' + missing.key);
            e.settings = next;
        }
        if (patch.name != null) e.name = String(patch.name).trim().slice(0, 60);
        if (patch.enabled != null) e.enabled = !!patch.enabled;
        if (patch.offline != null) e.offline = !!patch.offline;
        saveState();
        log(`плагин ${type}: изменён (${e.enabled ? 'включён' : 'выключен'}${e.offline ? ', работает на TV без аддона' : ''})`);
    }

    /** Для страницы аддона: всё, что нашли, с манифестом, настройками (без паролей) и состоянием. */
    function report() {
        return items.map(p => {
            const e = state.types[p.type] || {};
            const fields = settingsOf(p).map(f => ({
                key: f.key, label: f.label || f.key, type: f.type === 'password' ? 'password' : 'text', required: !!f.required,
                value: f.type === 'password' ? '' : ((e.settings || {})[f.key] || ''), isSet: !!(e.settings || {})[f.key]
            }));
            return {
                type: p.type, origin: p.origin, sha1: p.sha1 || null, sha256: p.sha256 || null, error: p.error || null,
                meta: p.meta || {}, enabled: !!e.enabled, offline: !!e.offline, name: e.name || '', fields
            };
        });
    }

    /** Код плагинов для телевизора: все (старый плеер) или только с «работать без аддона». */
    function list({ offlineOnly } = {}) {
        const offline = new Set(sources().filter(s => s.offline).map(s => s.src));
        return items.filter(ready).filter(p => !offlineOnly || offline.has(p.type))
            .map(p => ({ type: p.type, sha1: p.sha1, size: p.code.length, builtin: p.origin === 'builtin' }));
    }

    function code(type, { offlineOnly } = {}) {
        const p = items.find(x => x.type === String(type || '').toLowerCase() && ready(x));
        if (!p) return null;
        if (offlineOnly && !sources().some(s => s.src === p.type && s.offline)) return null;
        return p.code;
    }

    return { load, importLegacy, managedTypes, sources, install, installFromUrl, remove, update, report, list, code, userDir };
}

module.exports = { createPlugins, VOD_PID_BASE };
