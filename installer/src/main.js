'use strict';
// AssisTV Installer — установка AssisTV (или своего .wgt) на телевизор Samsung без Tizen Studio.
// Программа поднимает страницу-мастер на 127.0.0.1 и открывает её в браузере. Наружу ничего не слушает.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');

const { Sdb } = require('./sdb.js');
const { Certs, SAMSUNG_LOGIN_URL } = require('./certs.js');
const pkg = require('./pkg.js');
const tv = require('./tv.js');

// при запуске из исходников страница читается с диска, в собранном .exe она вшита сборщиком
if (require.extensions && !require.extensions['.html']) {
    require.extensions['.html'] = (m, file) => { m.exports = fs.readFileSync(file, 'utf8'); };
}
const PAGE = require('../ui/index.html');

const VERSION = '0.1.0';
const DEFAULT_REPO = 'indoor25/AssisTV';
const REMOTE_DIR = '/home/owner/share/tmp/sdk_tools';
const SAMSUNG_PORT = 4794; // сюда Samsung возвращает вход — адрес задан у Samsung, поменять нельзя
const MAX_PACKAGE = 200 * 1024 * 1024;

const configDir = process.env.ASSISTV_INSTALLER_DIR
    || (process.env.APPDATA ? path.join(process.env.APPDATA, 'AssisTV-Installer') : path.join(os.homedir(), '.config', 'assistv-installer'));
const certs = new Certs(configDir);
const token = crypto.randomBytes(16).toString('hex');

const state = {
    tv: null,          // { ip, port, name, modelName, year, ... }
    sdb: null,
    platform: '',      // «6.5»
    duid: '',
    pkg: null,         // { buffer, info, source }
    progress: { stage: '', pct: 0 },
    samsung: { state: 'idle', error: '' }, // idle | waiting | creating | ready | error
    busy: false
};

const fail = (code, detail) => Object.assign(new Error(code), { code, detail: detail || '' });
const setProgress = (stage, pct) => { state.progress = { stage, pct: pct || 0 }; };

function splitHost(host) {
    const m = String(host || '').trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{2,5}))?$/);
    if (!m) throw fail('bad_address');
    return { ip: m[1], port: m[2] ? Number(m[2]) : 26101 };
}

// Tizen 7 и новее ставит только пакеты с сертификатом Samsung
function needsSamsung() {
    const major = parseInt(state.platform, 10);
    if (major) return major >= 7;
    const year = state.tv && state.tv.year;
    return year ? year >= 2023 : true;
}

async function selectTv(host) {
    const { ip, port } = splitHost(host);
    const info = await tv.probe(ip, 4000);
    const pcIp = await tv.pcAddressFor(ip);
    if (!info && !pcIp) throw fail('tv_unreachable');
    state.tv = Object.assign({ ip, name: 'Samsung TV', modelName: '', year: 0, developerMode: '', developerIP: '' }, info, { port });
    if (state.sdb) { state.sdb.close(); state.sdb = null; }
    const t = state.tv;
    // старые прошивки не сообщают режим разработчика — тогда узнаем при подключении
    const known = t.developerMode !== '';
    const ready = !known || (t.developerMode === '1' && (t.developerIP === pcIp || port !== 26101));
    return { tv: publicTv(), pcIp, known, ready };
}

function publicTv() {
    const t = state.tv;
    return t && { ip: t.ip, port: t.port, name: t.name, modelName: t.modelName, year: t.year, developerMode: t.developerMode, developerIP: t.developerIP };
}

async function connectTv() {
    if (!state.tv) throw fail('no_tv');
    if (state.sdb) state.sdb.close();
    const sdb = new Sdb(state.tv.ip, state.tv.port);
    try {
        await sdb.connect();
    } catch (e) {
        throw fail('sdb_' + (e.code || 'network'));
    }
    state.sdb = sdb;
    state.platform = await sdb.platformVersion();
    state.duid = await sdb.duid();
    const samsung = needsSamsung();
    return { platform: state.platform, duid: state.duid, needSamsung: samsung, hasCert: !samsung || certs.hasSamsungFor(state.duid) };
}

async function ensureSdb() {
    if (state.sdb && state.sdb.connected) return state.sdb;
    await connectTv();
    return state.sdb;
}

async function loadFromGitHub(repo) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw fail('bad_repo');
    setProgress('download', 0);
    const res = await fetch('https://api.github.com/repos/' + repo + '/releases/latest', {
        headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'assistv-installer' },
        signal: AbortSignal.timeout(30000)
    });
    if (res.status === 404) throw fail('no_release', repo);
    if (!res.ok) throw fail('github_error', 'HTTP ' + res.status);
    const release = await res.json();
    const asset = (release.assets || []).find((a) => /\.wgt$/i.test(a.name));
    if (!asset) throw fail('no_release', repo);
    if (asset.size > MAX_PACKAGE) throw fail('too_big');
    const file = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'assistv-installer' }, signal: AbortSignal.timeout(180000) });
    if (!file.ok) throw fail('github_error', 'HTTP ' + file.status);
    return setPackage(Buffer.from(await file.arrayBuffer()), repo + ' · ' + asset.name);
}

async function setPackage(buffer, source) {
    const info = await pkg.inspect(buffer);
    state.pkg = { buffer, info, source };
    setProgress('', 0);
    return Object.assign({ source, size: buffer.length }, info);
}

function parseInstall(output) {
    const failed = output.match(/install failed\[([^\]]*)\][^\n]*/i);
    if (failed) return { ok: false, code: failed[1], line: failed[0].trim() };
    if (/install completed/i.test(output)) return { ok: true };
    // служебную строку времени не показываем — от неё человеку толку нет
    const lines = output.trim().split('\n').map((l) => l.trim()).filter((l) => l && !/^spend time/i.test(l));
    return { ok: false, code: '', line: lines.pop() || '' };
}

async function pushAndInstall(sdb, buffer) {
    const remote = REMOTE_DIR + '/package.wgt';
    setProgress('upload', 0);
    await sdb.push(remote, buffer, (p) => setProgress('upload', Math.round(p * 100)));
    setProgress('installing', 0);
    const out = await sdb.shell('0 vd_appinstall ' + state.pkg.info.packageId + ' ' + remote, 240000, (t) => {
        const m = t.match(/installing\[(\d+)\]/g);
        if (m) setProgress('installing', Number(m[m.length - 1].replace(/\D/g, '')));
        return /spend time/.test(t);
    });
    return Object.assign(parseInstall(out), { output: out.trim() });
}

async function install(opts) {
    if (!state.pkg) throw fail('no_package');
    const sdb = await ensureSdb();
    const info = state.pkg.info;
    const required = parseFloat(info.requiredVersion);
    if (required && parseFloat(state.platform) && required > parseFloat(state.platform)) throw fail('too_new', info.requiredVersion + ' > ' + state.platform);

    // уже стоит ли это приложение — только тогда отказ может значить «другой автор» и есть смысл предлагать удаление
    const wasInstalled = await tv.isInstalled(state.tv.ip, info.appId);

    if (opts && opts.uninstallFirst) {
        setProgress('uninstalling', 0);
        await sdb.shell('0 vd_appuninstall ' + info.packageId, 60000, (t) => /spend time|uninstall completed|failed/.test(t));
    }

    let result;
    if (needsSamsung()) {
        if (!certs.hasSamsungFor(state.duid)) throw fail('need_samsung');
        const profile = certs.samsungProfile();
        if (profile.deviceProfile) await sdb.push(REMOTE_DIR + '/device-profile.xml', Buffer.from(profile.deviceProfile, 'utf8'));
        setProgress('signing', 0);
        result = await pushAndInstall(sdb, await pkg.resign(state.pkg.buffer, profile));
    } else {
        // старый телевизор: готовую подпись пробуем как есть (так сохраняется автор), иначе подписываем сами
        if (info.signed) result = await pushAndInstall(sdb, state.pkg.buffer);
        if (!result || !result.ok) {
            const first = result;
            setProgress('signing', 0);
            const profile = await certs.tizenProfile();
            result = await pushAndInstall(sdb, await pkg.resign(state.pkg.buffer, profile));
            if (!result.ok && first) result.firstTry = first.line;
        }
    }
    setProgress('', 0);
    // «другой автор»: приложение уже стоит с чужой подписью — поможет только удаление.
    // Предлагаем удаление, только если оно правда стоит: иначе отказ значит что-то другое, и удалять нечего.
    result.authorMismatch = !result.ok && wasInstalled === true && !(opts && opts.uninstallFirst)
        && /author|signature|certificate|\b118\b/i.test(result.output);
    result.app = { name: info.name, version: info.version, appId: info.appId };
    return result;
}

// ---------- вход в Samsung (порт 4794) ----------

const samsungPage = (title, text) => '<!doctype html><meta charset="utf-8"><title>AssisTV Installer</title>'
    + '<body style="font:18px system-ui,sans-serif;background:#0f1b2a;color:#fff;display:grid;place-items:center;height:100vh;margin:0">'
    + '<div style="max-width:560px;padding:24px;text-align:center"><h2>' + title + '</h2><p>' + text + '</p></div>';

// Ответ Samsung после входа: объект с access_token, userId, inputEmailID. Приходит JSON-ом (форма на порт 4794)
// или текстом, который человек скопировал со страницы Samsung — достаём нужные поля из любого вида.
function parseAccess(text) {
    const pick = (key) => {
        const m = String(text).match(new RegExp('\\b' + key + '"?\\s*[:=]?\\s*"([^"]+)"'));
        return m ? m[1] : '';
    };
    const access = { accessToken: pick('access_token'), userId: pick('userId'), email: pick('inputEmailID') };
    return access.accessToken && access.userId ? access : null;
}

function acceptSamsung(access) {
    state.samsung = { state: 'creating', error: '' };
    ensureSdb()
        .then(() => certs.createSamsung(access, state.duid))
        .then(() => { state.samsung = { state: 'ready', error: '' }; })
        .catch((e) => { state.samsung = { state: 'error', error: String(e.code || e.message || e) }; });
}

const samsungPasteForm = '<form method="POST" style="margin-top:20px"><p style="font-size:15px;opacity:.8">'
    + 'If the sign-in page showed a block of data instead of continuing, paste it here:<br>'
    + 'Если после входа страница показала блок данных и не пошла дальше, вставьте его сюда:</p>'
    + '<textarea name="code" rows="6" style="width:100%;box-sizing:border-box"></textarea><br><br><button>OK</button></form>';

function samsungHandler(req, res) {
    const send = (code, html) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); };
    if (req.method !== 'POST') return send(200, samsungPage('AssisTV Installer', 'Waiting for Samsung sign-in… / Ожидание входа в Samsung…' + samsungPasteForm));
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
        if (state.samsung.state !== 'waiting') return send(409, samsungPage('AssisTV Installer', 'Not expected now. / Сейчас вход не ожидается.'));
        const access = parseAccess(new URLSearchParams(body).get('code') || body);
        if (!access) {
            state.samsung = { state: 'error', error: 'bad_samsung_answer' };
            return send(400, samsungPage('Error', 'Unexpected answer from Samsung. / Неожиданный ответ Samsung.'));
        }
        send(200, samsungPage('✓', 'Signed in. Return to the AssisTV Installer tab — you can close this one.<br><br>Вход выполнен. Вернитесь на вкладку AssisTV Installer, эту можно закрыть.'));
        acceptSamsung(access);
    });
}

const samsungServers = [];
function startSamsungListener() {
    return Promise.all(['127.0.0.1', '::1'].map((host) => new Promise((resolve) => {
        const s = http.createServer(samsungHandler);
        s.on('error', (e) => resolve(e.code || 'error'));
        s.listen(SAMSUNG_PORT, host, () => { samsungServers.push(s); resolve(''); });
    }))).then((r) => r[0]); // достаточно IPv4; '' — порт наш
}

// ---------- страница и её запросы ----------

function readBody(req, limit) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > limit) { reject(fail('too_big')); req.destroy(); } else chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

let samsungPortError = '';

const routes = {
    'GET /api/scan': async () => ({ tvs: await tv.scan() }),
    'POST /api/tv': async (b) => selectTv(b.host),
    'POST /api/connect': async () => connectTv(),
    'POST /api/package/default': async () => loadFromGitHub(DEFAULT_REPO),
    'POST /api/package/github': async (b) => loadFromGitHub(String(b.repo || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, '')),
    'GET /api/status': async () => ({ progress: state.progress, samsung: state.samsung }),
    'POST /api/samsung/start': async () => {
        if (samsungPortError) throw fail('samsung_port', samsungPortError);
        await ensureSdb();
        state.samsung = { state: 'waiting', error: '' };
        return { url: SAMSUNG_LOGIN_URL };
    },
    // запасной путь: человек вставил ответ Samsung в окно программы
    'POST /api/samsung/paste': async (b) => {
        const access = parseAccess(String(b.text || ''));
        if (!access) throw fail('bad_samsung_answer');
        await ensureSdb();
        acceptSamsung(access);
        return { ok: true };
    },
    'POST /api/install': async (b) => install(b),
    // кнопка «Закрыть установщик»: программа завершается — окно терминала закрывается само
    'POST /api/quit': async () => {
        if (state.busy) throw fail('busy');
        if (state.sdb) state.sdb.close();
        setTimeout(() => process.exit(0), 300);
        return { ok: true };
    },
    'POST /api/launch': async () => ({ ok: !!(state.tv && state.pkg) && await tv.launch(state.tv.ip, state.pkg.info.appId) })
};

async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
    // страницу и запросы принимаем только со своего адреса и со своим ключом
    const host = String(req.headers.host || '');
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return json(403, { error: 'forbidden' });
    if (req.method === 'GET' && url.pathname === '/') {
        if (url.searchParams.get('k') !== token) return json(403, { error: 'forbidden' });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(PAGE.replace('__TOKEN__', token).replace('__VERSION__', VERSION).replace('__DEFAULT_REPO__', DEFAULT_REPO));
    }
    if (req.headers['x-token'] !== token) return json(403, { error: 'forbidden' });
    try {
        if (req.method === 'POST' && url.pathname === '/api/package/file') {
            const buffer = await readBody(req, MAX_PACKAGE);
            return json(200, await setPackage(buffer, String(url.searchParams.get('name') || 'file.wgt').slice(0, 200)));
        }
        const route = routes[req.method + ' ' + url.pathname];
        if (!route) return json(404, { error: 'not_found' });
        let body = {};
        if (req.method === 'POST') {
            const raw = await readBody(req, 65536);
            body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
        }
        const long = url.pathname === '/api/install' || url.pathname.startsWith('/api/package/');
        if (long) {
            if (state.busy) throw fail('busy');
            state.busy = true;
        }
        try { json(200, await route(body)); } finally { if (long) state.busy = false; }
    } catch (e) {
        setProgress('', 0);
        json(200, { error: e.code && typeof e.code === 'string' ? e.code : 'internal', detail: e.detail || (e.code ? '' : String(e.message || e)) });
    }
}

function openBrowser(url) {
    const cmd = process.platform === 'win32' ? 'start "" "' + url + '"'
        : process.platform === 'darwin' ? 'open "' + url + '"' : 'xdg-open "' + url + '"';
    exec(cmd, () => {});
}

async function main() {
    samsungPortError = await startSamsungListener();
    const server = http.createServer((req, res) => { handle(req, res).catch(() => { try { res.end(); } catch (e) { /* уже закрыто */ } }); });
    server.listen(Number(process.env.ASSISTV_INSTALLER_PORT) || 0, '127.0.0.1', () => {
        const url = 'http://127.0.0.1:' + server.address().port + '/?k=' + token;
        console.log('AssisTV Installer ' + VERSION);
        console.log('');
        console.log('  ' + url);
        console.log('');
        console.log('The page opens in your browser. Keep this window open until the installation is finished.');
        console.log('Страница откроется в браузере. Не закрывайте это окно, пока идёт установка.');
        if (!process.env.ASSISTV_INSTALLER_NO_BROWSER) openBrowser(url);
    });
}

// в собранном .exe (Node SEA) require.main нет — запускаемся и там
const isSea = (() => { try { return require('node:sea').isSea(); } catch (e) { return false; } })();
if (!process.env.ASSISTV_NO_MAIN && (isSea || require.main === module)) main();

module.exports = { parseInstall, splitHost, parseAccess };
