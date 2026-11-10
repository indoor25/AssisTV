/**
 * Сервис плейлистов и EPG для плеера AssisTV (аддон Home Assistant OS).
 *
 * Плейлисты настраиваются здесь (опция playlists), телевизоры их только выбирают:
 *   GET  /playlists.json      — список [{id, name, kind: 'tv'|'vod', url?}] (url — только у видеопортала)
 *   GET  /playlists/<id>.json — M3U: каналы + сопоставленный EPG (build.js); портал: {id, name, kind, url}
 *   GET  /playlists/<id>/archive.json?name=<канал> — {name, days, epgId, programmes} передачи за дни архива
 *                               (архив проверяется запросами, archive.js; нет архива — days 0)
 *   GET  /playlists/<id>/programme.json?name=<канал>&at=<unix-сек> — передача в момент at с описанием, жанром,
 *                               возрастом и следующая: {name, epgId, programme, next} (описания — файл, build.js)
 *   POST /tvs/register        — телевизор представляется {duid, model, pairing?, token?}, получает tv_id, топики,
 *                               плейлисты и MQTT; новый плеер без токена — код привязки (pairing.js), ответ 202
 *   GET  /tvs.json            — зарегистрированные телевизоры
 *   GET  /                    — страница: привязка, телевизоры (имя, сущности Samsung TV из HA), топики, плейлисты
 *   GET  /status              — сборка по каждому плейлисту: совпавшие/несовпавшие каналы, ошибки
 *   WS   /mqtt                — MQTT для телевизоров через аддон (mqtt-proxy.js): логин tv_id, пароль — токен
 *
 * Доступ (routeAccess): страница, настройки телевизоров, сопоставление, пересборка, привязка — только через
 * панель IPTV в HA (ingress); всё, что нужно телевизору, — с его токеном (Authorization: Bearer). Плееры до 1.3
 * токена не знают: их пускаем, пока у телевизора стоит legacy и запрос пришёл с его адреса.
 *   GET  /rebuild             — пересобрать сейчас (не дожидаясь расписания); ?force=1 — принять EPG,
 *                               даже если он заметно беднее прежнего (см. epgLooksTruncated)
 *   POST /parental/check      — телевизор проверяет PIN {tv_id, pin} → {ok, error?, retry_in?} (parental.js)
 *   POST /parental/pin|off|groups — PIN и защищённые группы со страницы (только через панель HA — ingress)
 *
 * MQTT: у каждого телевизора свои топики iptv/<tv_id>/… (см. js/mqtt-bridge.js). Сервис включает TV и
 * запускает на нём плеер (iptv/<tv_id>/tv/…) и пишет данные для карточек HA в /homeassistant/www/tizen-iptv/
 * (channels-<tv_id>.json и tvs.json — список телевизоров для редактора карточки).
 *
 * Настройки: /data/options.json (так их кладёт Home Assistant из вкладки «Конфигурация» аддона),
 * путь можно переопределить через OPTIONS_FILE — для запуска на компьютере.
 *
 * Язык страницы аддона и ответов для Assist — опция language (auto — язык Home Assistant), тексты — в lang/
 * (общие с плеером и карточкой, js/i18n.js). Журнал аддона — по-русски, как было.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { buildPlaylists, assemblePlaylists, archiveProgrammes, programmeInfo, resolveChannel, isSourceUrl, normalizeChannelName, NO_EPG } = require('./build');
const card = require('./card-data');
const { createVod, parseQuality, cleanTitle } = require('./vod');
const { createTmdb } = require('./tmdb');
const { createKinopoisk } = require('./kinopoisk');
const { createArchiveChecker } = require('./archive');
const { createParental } = require('./parental');
const { createFavorites } = require('./favorites');
const { createWatchlist } = require('./watchlist');
const { createPlugins } = require('./plugins');
const { createSandbox } = require('./sandbox');
const { createGuide } = require('./guide');
const { createHistory } = require('./history');
const { createPairing, makeToken, hashToken } = require('./pairing');
const { attachMqttProxy } = require('./mqtt-proxy');
const { I18n } = requireShared('i18n.js');
const { VodSources } = requireShared('vod-sources.js');
const ChannelMatch = requireShared('channel-match.js');
['ru', 'en', 'uk', 'de'].forEach(code => I18n.add(code, requireShared('lang/' + code + '.js')));
const tr = (key, params) => I18n.t(key, params);

/** Файл из shared/ (в контейнере) или из исходников плеера (запуск на компьютере) — как в build.js. */
function requireShared(name) {
    const local = path.join(__dirname, 'shared', name);
    if (fs.existsSync(local)) return require(local);
    return require(path.join(__dirname, '..', '..', name.startsWith('lang/') ? '' : 'js', name));
}

const OPTIONS_FILE = process.env.OPTIONS_FILE || '/data/options.json';
const DATA_DIR = process.env.DATA_DIR || '/data';
const PORT = parseInt(process.env.PORT || '8765', 10);
const PLAYLISTS_DIR = path.join(DATA_DIR, 'playlists');
const STATUS_FILE = path.join(DATA_DIR, 'status.json');
const EPG_INFO_DIR = path.join(DATA_DIR, 'epg-info');   // описания передач, build.js createInfoStore
const TVS_FILE = path.join(DATA_DIR, 'tvs.json');
const TV_CHANNELS_FILE = path.join(DATA_DIR, 'tv-channels.json');
// ручные привязки каналов к EPG со страницы аддона: { "<имя в плейлисте>": "<epgId>" | "-" (без программы) }
const MAPPING_FILE = path.join(DATA_DIR, 'manual_map.json');
const DEFAULT_APP_ID = 'TzIptvPl01.IPTVTizen';
// ответы iptv/request читаются вслух: больше трёх названий превращаются в минуту озвучки
const VOICE_RESULTS = 3;
// родительский контроль (parental.js): PIN и группы меняются только через панель HA — ingress приходит с этого адреса; INGRESS_IP — для проверки на компьютере
const INGRESS_IP = process.env.INGRESS_IP || '172.30.32.2';

function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function writeAtomic(file, content) {
    fs.writeFileSync(file + '.tmp', content);
    fs.renameSync(file + '.tmp', file);
}

function readMapping() {
    return readJson(MAPPING_FILE) || {};
}

/**
 * playlists в интерфейсе HA — список {name, url}. Если на этой версии Supervisor такая схема не
 * взлетит, поддержан и запасной вид — строки "Имя = url" (как manual_map). Разделитель — первый
 * " = ": в url знак = встречается (query), а в portal:: ссылке — нет пробелов вокруг него.
 */
function parsePlaylists(list) {
    return (list || []).map((p, i) => {
        let name, url;
        if (typeof p === 'string') {
            const idx = p.indexOf(' = ');
            if (idx > 0) { name = p.slice(0, idx); url = p.slice(idx + 3); } else url = p;
        } else if (p) {
            name = p.name; url = p.url;
        }
        url = String(url || '').trim();
        return { id: i, name: String(name || '').trim() || tr('page.playlistN', { n: i + 1 }), url, kind: isSourceUrl(url) ? 'vod' : 'tv' };
    }).filter(p => p.url);
}

function readOptions() {
    const o = JSON.parse(fs.readFileSync(OPTIONS_FILE, 'utf8'));
    // manual_map в интерфейсе HA — строки "Имя в плейлисте = epgId или имя в EPG";
    // привязки со страницы аддона важнее строк из настроек
    const manualMap = Object.assign(optionsManualMap(), readMapping());
    return {
        playlists: parsePlaylists(o.playlists),
        epgUrls: o.epg_urls || [],
        pastHours: o.past_hours ?? 3,
        futureHours: o.future_hours ?? 36,
        refreshHours: o.refresh_hours ?? 6,
        mqttWsPort: o.mqtt_ws_port || 1884,
        language: o.language || 'auto',
        tmdbKey: (o.tmdb_key || '').trim(),
        kinopoiskKey: (o.kinopoisk_key || '').trim(),
        manualMap
    };
}

// ───────────────────────── Плейлисты ─────────────────────────

let playlistIndex = [];   // [{id, name, kind, url}] — из опций
const bundles = {};       // id -> { json, gzip, data, meta }
let status = { state: 'idle', playlists: [] };
let building = false;

function bundleFile(id) { return path.join(PLAYLISTS_DIR, `${id}.json`); }
function metaFile(id) { return path.join(PLAYLISTS_DIR, `${id}.meta.json`); }

function setBundle(id, json, meta) {
    const buf = Buffer.from(json);
    bundles[id] = { json: buf, gzip: zlib.gzipSync(buf, { level: 9 }), data: JSON.parse(buf.toString('utf8')), meta };
}

/** Сохранённые сборки подхватываются, только если плейлист с этим id всё ещё тот же (url не меняли). */
function loadFromDisk() {
    try { playlistIndex = withPluginSources(readOptions().playlists); } catch (e) { playlistIndex = []; }
    const saved = readJson(STATUS_FILE);
    // status.json версии 1.x (один плейлист) не переносим — поля там другие
    if (saved && Array.isArray(saved.playlists)) status = saved;
    status.state = 'idle';
    for (const pl of playlistIndex.filter(p => p.kind === 'tv')) {
        const meta = readJson(metaFile(pl.id));
        if (!meta || meta.url !== pl.url) continue;
        try {
            setBundle(pl.id, fs.readFileSync(bundleFile(pl.id)), meta);
            log(`плейлист ${pl.id} «${pl.name}»: загружена сборка от ${meta.generatedAt}`);
        } catch (e) { /* файла нет — соберём */ }
    }
    tvChannels = readJson(TV_CHANNELS_FILE) || {};
}

/**
 * Плейлисты для телевизора. Адрес источника фильмов (в нём ключ) — только старому плееру (до 1.3), который
 * сам выполняет плагины; новый ходит за фильмами через аддон (/vod/call), а без аддона — на копии плагина,
 * если у него включено «работать на телевизоре без аддона» (/vod-sources.json).
 */
function publicPlaylists({ withUrl } = {}) {
    return playlistIndex.map(p => (p.kind === 'vod'
        ? Object.assign({ id: p.id, name: p.name, kind: p.kind, src: (VodSources.parseUrl(p.url) || {}).type || 'portal' },
            withUrl ? { url: p.url } : {})
        : Object.assign({ id: p.id, name: p.name, kind: p.kind, ready: !!bundles[p.id] }, playlistFailed(p.id) ? { failed: true } : {})));
}

/** Плейлист не собрался и прежней сборки нет. Телевизору — только признак: в тексте ошибки бывает ссылка с токеном. */
function playlistFailed(id) {
    if (bundles[id]) return false;
    const st = (status.playlists || []).find(s => s.id === id);
    return !!(st && st.lastError);
}

// Последние скачанные M3U и EPG — по ним ручная привязка пересобирает плейлисты без скачивания.
let m3uCache = null;      // [{pl, channels} | {pl, error}]
let epgCache = null;      // build.js loadEpg()
let epgCacheTruncated = false;   // в памяти урезанный EPG (см. rebuild) — плейлисты из него не пересобираем
let rematchPending = false;

/** Результаты сборки → файлы, память и status.playlists. */
function applyResults(results) {
    fs.mkdirSync(PLAYLISTS_DIR, { recursive: true });
    const prev = new Map((status.playlists || []).map(s => [s.id, s]));
    status.playlists = playlistIndex.map(pl => {
            if (pl.kind === 'vod') return { id: pl.id, name: pl.name, kind: 'vod' };
            const r = results.find(x => x.id === pl.id);
            const old = prev.get(pl.id);
            if (!r || r.error) {
                // прежняя удачная сборка остаётся в работе — лучше вчерашний EPG, чем никакого
                return Object.assign({}, old && old.url === pl.url ? old : {}, {
                    id: pl.id, name: pl.name, kind: 'tv', url: pl.url,
                    lastError: { at: new Date().toISOString(), message: r ? r.error : 'не собирался' }
                });
            }
            const json = JSON.stringify(r.data);
            const meta = { url: pl.url, name: pl.name, generatedAt: r.data.generatedAt };
            writeAtomic(bundleFile(pl.id), json);   // через временный файл — не остаться с обрезанным
            writeAtomic(metaFile(pl.id), JSON.stringify(meta));
            setBundle(pl.id, json, meta);
            const b = bundles[pl.id];
            log(`плейлист ${pl.id} «${pl.name}»: совпало ${r.stats.matchedChannels}/${r.stats.playlistChannels} каналов, ` +
                `${r.stats.programmes} передач, ${(b.json.length / 1048576).toFixed(2)} МБ ` +
                `(gzip ${(b.gzip.length / 1048576).toFixed(2)} МБ)`);
            return {
                id: pl.id, name: pl.name, kind: 'tv', url: pl.url,
                lastSuccess: r.data.generatedAt, sizeBytes: b.json.length, gzipBytes: b.gzip.length,
                ...r.stats, lastError: null
            };
        });
    // плейлисты, которых больше нет в опциях, не отдаём
    Object.keys(bundles).forEach(id => {
        const pl = playlistIndex.find(p => String(p.id) === id);
        if (!pl || pl.kind !== 'tv') delete bundles[id];
    });
}

function finishBuild() {
    status.state = 'idle';
    updateCardData();
    // защищённые группы по умолчанию ищутся по названию среди групп плейлистов — после сборки их могло стать больше
    Object.values(tvs).forEach(publishTvConfig);
    publishPlaylistsChanged();
    fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
    building = false;
    if (rematchPending) { rematchPending = false; rematch(); }
}

/** Файлы описаний прежних загрузок EPG — после того как новый EPG заменил их в памяти. */
function removeOldInfoFiles() {
    let files = [];
    try { files = fs.readdirSync(EPG_INFO_DIR); } catch (e) { return; }
    for (const f of files) {
        const full = path.join(EPG_INFO_DIR, f);
        if (full !== (epgCache && epgCache.infoFile)) fs.rmSync(full, { force: true });
    }
}

// Защита от урезанного EPG: источник иногда отдаёт файл, где у большинства каналов программа кончается
// через пару часов (28.09.2026 it999 так пролежал ~полчаса, и до следующей сборки через 6 ч на TV была дыра).
const EPG_AHEAD_SEC = 6 * 3600;       // «программа есть» = у канала передачи дальше, чем на 6 ч вперёд
const EPG_SHRINK_RATIO = 0.7;         // новый EPG хуже прежнего больше чем на 30% — не берём
const EPG_RETRY_MS = 30 * 60 * 1000;  // и пробуем скачать ещё раз через 30 мин
let epgRetryTimer = null;
// С чем сравнивать: до какого времени знал программу каждый канал последнего принятого EPG. Лежит в файле —
// иначе сразу после перезапуска аддона сравнивать было не с чем, и урезанный EPG проходил.
const EPG_BASELINE_FILE = path.join(DATA_DIR, 'epg-baseline.json');
let epgBaseline = (readJson(EPG_BASELINE_FILE) || {}).stops || null;   // [конец последней передачи канала, unix-сек]

/** До какого времени каждый канал EPG знает программу (каналы без передач не считаются). */
function epgStops(epg) {
    const stops = [];
    for (const list of Object.values(epg.epgProgrammes)) if (list.length) stops.push(list[list.length - 1][1]);
    return stops;
}

/** Сколько каналов знают программу дальше, чем на EPG_AHEAD_SEC от «сейчас». */
function channelsAhead(stops) {
    const edge = Date.now() / 1000 + EPG_AHEAD_SEC;
    return stops.reduce((n, stop) => n + (stop > edge ? 1 : 0), 0);
}

/**
 * Новый EPG заметно беднее прежнего — прежний остаётся в работе. Оба считаются на один момент «сейчас»,
 * поэтому если прежний со временем устареет сильнее нового, новый пройдёт сам.
 */
function epgLooksTruncated(fresh, oldStops) {
    if (!oldStops) return null;
    const a = channelsAhead(epgStops(fresh)), b = channelsAhead(oldStops);
    return b > 0 && a < b * EPG_SHRINK_RATIO ? { fresh: a, old: b } : null;
}

function saveEpgBaseline(epg) {
    epgBaseline = epgStops(epg);
    try { writeAtomic(EPG_BASELINE_FILE, JSON.stringify({ savedAt: new Date().toISOString(), stops: epgBaseline })); }
    catch (e) { log('EPG: не сохранил показатели для сравнения: ' + e.message); }
}

async function rebuild(force) {
    if (building) return;
    building = true;
    status.state = 'building';
    status.startedAt = new Date().toISOString();
    clearTimeout(epgRetryTimer);
    epgRetryTimer = null;
    try {
        const opts = readOptions();
        playlistIndex = withPluginSources(opts.playlists);
        const tvLists = playlistIndex.filter(p => p.kind === 'tv');
        const built = tvLists.length
            ? await buildPlaylists({ ...opts, playlists: tvLists, archive: archiveChecker.snapshot(), infoDir: EPG_INFO_DIR, guideDays: GUIDE_DAYS, log })
            : { results: [] };
        const bad = built.epg && !force && epgLooksTruncated(built.epg, epgBaseline);
        if (bad) {
            status.epgRejected = { at: new Date().toISOString(), fresh: bad.fresh, old: bad.old };
            epgRetryTimer = setTimeout(rebuild, EPG_RETRY_MS);
            if (epgCache) {
                if (built.epg.infoFile) fs.rmSync(built.epg.infoFile, { force: true });
                log(`EPG урезан: программа дальше 6 ч есть у ${bad.fresh} каналов против ${bad.old} в прежнем — ` +
                    `оставляю прежний, повтор через ${EPG_RETRY_MS / 60000} мин`);
                return;
            }
            // Аддон только что запустился: прежнего EPG в памяти нет, а без него не работают поиск по программе,
            // описания и ручное сопоставление. Урезанный берём в память, но плейлисты телевизорам остаются прежние
            // (сборки с диска) и показатели для сравнения не трогаем — повторная загрузка сравнится с ними же.
            log(`EPG урезан: программа дальше 6 ч есть у ${bad.fresh} каналов против ${bad.old} до перезапуска — ` +
                `плейлисты оставляю прежние, повтор через ${EPG_RETRY_MS / 60000} мин`);
            m3uCache = built.loaded; epgCache = built.epg; epgCacheTruncated = true; removeOldInfoFiles();
            // сборки на диске нет (плейлист добавили только что) — лучше урезанная программа, чем никакой
            if (tvLists.some(pl => !bundles[pl.id])) applyResults(built.results);
            return;
        }
        status.epgRejected = null;
        if (built.epg) {
            m3uCache = built.loaded; epgCache = built.epg; epgCacheTruncated = false;
            removeOldInfoFiles();
            saveEpgBaseline(built.epg);
        }
        // M3U-плейлистов не осталось (все удалили) — EPG и его описания больше не нужны
        if (!tvLists.length) { m3uCache = null; epgCache = null; removeOldInfoFiles(); }
        applyResults(built.results);
        status.lastRun = new Date().toISOString();
        status.lastError = null;
    } catch (err) {
        status.lastError = { at: new Date().toISOString(), message: err.message };
        log('ОШИБКА сборки: ' + (err.stack || err.message));
    } finally {
        finishBuild();
    }
    checkArchive();
}

// ───────────────────────── Архив ─────────────────────────

const archiveChecker = createArchiveChecker({ file: path.join(DATA_DIR, 'archive.json'), log });

/**
 * Какие каналы с tvg-rec реально отдают архив (archive.js) — после каждой сборки, в фоне; сам запрос делается
 * не чаще раза в сутки на канал. Что-то поменялось — плейлисты пересобираются, телевизоры подхватят метки.
 */
function checkArchive() {
    if (!m3uCache) return;
    archiveChecker.check(m3uCache)
        .then(changed => { if (changed) rematch(); })
        .catch(err => log('архив: ОШИБКА проверки ' + (err.stack || err.message)));
}

/** Сколько передач канала EPG попадает в окно плейлиста (прошлые дни для архива не считаем). */
function windowCount(id) {
    const from = Math.floor(epgCache.from.getTime() / 1000);
    const to = Math.floor(epgCache.to.getTime() / 1000);
    return epgCache.epgProgrammes[id].filter(p => p[1] > from && p[0] <= to).length;
}

/**
 * Пересобрать плейлисты по уже скачанным M3U и EPG — после ручной привязки канала (секунды вместо
 * минуты со скачиванием). Идёт сборка — повторим после неё; скачанного ещё нет — полная сборка.
 */
async function rematch() {
    if (building) { rematchPending = true; return { ok: true, pending: true }; }
    const opts = readOptions();
    // плейлисты в настройках меняли, а скачано старое — только полная сборка
    const same = epgCache && m3uCache &&
        m3uCache.every(l => opts.playlists.some(p => p.id === l.pl.id && p.url === l.pl.url && p.name === l.pl.name));
    if (!same) { rebuild(); return { ok: true, pending: true }; }
    // привязка сохранена и применится, когда источник отдаст полный EPG (повтор уже назначен)
    if (epgCacheTruncated) return { ok: true, pending: true };
    building = true;
    status.state = 'building';
    try {
        const t0 = Date.now();
        applyResults(assemblePlaylists(m3uCache, epgCache, opts.manualMap, log, archiveChecker.snapshot()));
        log(`сопоставление: пересобрано по скачанному EPG за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
        return { ok: true };
    } catch (err) {
        log('ОШИБКА сопоставления: ' + (err.stack || err.message));
        return { ok: false, error: err.message };
    } finally {
        finishBuild();
    }
}

// ───────────────────────── Ручное сопоставление (страница аддона) ─────────────────────────

/** Строки manual_map из настроек аддона (без привязок со страницы). */
function optionsManualMap() {
    const map = {};
    try {
        for (const line of JSON.parse(fs.readFileSync(OPTIONS_FILE, 'utf8')).manual_map || []) {
            const idx = line.lastIndexOf('=');
            if (idx > 0) map[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
    } catch (e) { /* нет настроек */ }
    return map;
}

let catalogCache = null;  // { loadedAt, json, gzip }

/** Все каналы EPG для правого списка: сколько передач в окне и до какого числа программа есть вообще. */
function epgCatalog() {
    if (catalogCache && catalogCache.loadedAt === epgCache.loadedAt) return catalogCache;
    const channels = Object.entries(epgCache.epgChannels).map(([id, c]) => ({
        id, names: c.names, icon: c.icon || null,
        count: windowCount(id), last: epgCache.lastStop[id] || null
    }));
    const json = Buffer.from(JSON.stringify({ loadedAt: epgCache.loadedAt, channels }));
    catalogCache = { loadedAt: epgCache.loadedAt, json, gzip: zlib.gzipSync(json) };
    return catalogCache;
}

/** Каналы плейлиста для левого списка: с чем сейчас сопоставлен каждый и откуда привязка. */
function mappingPlaylist(id) {
    const loaded = m3uCache.find(l => l.pl.id === id && l.channels);
    if (!loaded) return null;
    const manual = readMapping();
    const options = optionsManualMap();
    const map = Object.assign({}, options, manual);
    const seen = new Set();
    const channels = [];
    for (const ch of loaded.channels) {
        if (seen.has(ch.name)) continue;   // привязка по имени — дубли имени в плейлисте ведут себя одинаково
        seen.add(ch.name);
        const r = resolveChannel(ch.name, epgCache, map);
        channels.push({
            name: ch.name, group: ch.group || '', id: r.id, how: r.how,
            from_options: manual[ch.name] == null && options[ch.name] != null,
            count: r.id ? windowCount(r.id) : 0,
            last: r.id ? epgCache.lastStop[r.id] || null : null
        });
    }
    return { id, name: loaded.pl.name, epgLoadedAt: epgCache.loadedAt, channels, manual, options };
}

// ───────────────────────── Телевизоры ─────────────────────────

/**
 * Реестр: tv_id -> {tv_id, duid, model, name, ip, remote_entity, media_player, registeredAt, lastSeen}.
 * tv_id — короткая модель + хвост DUID (qe55qn90d_mdes): понятно, какой это TV, два одинаковых
 * телевизора не совпадут, и id не зависит от имени и комнаты — топики и сущности HA не ломаются,
 * когда телевизор переносят или переименовывают. Имя и сущности Samsung TV правятся на странице аддона,
 * область — в самом HA (у прибора «IPTV <имя>»).
 */
let tvs = readJson(TVS_FILE) || {};
// телевизоры, зарегистрированные до привязки по коду, — со старым плеером: пускаем по адресу, пока не обновят
for (const t of Object.values(tvs)) if (t.legacy === undefined && !t.tokenHash) t.legacy = true;

function saveTvs() { writeAtomic(TVS_FILE, JSON.stringify(tvs, null, 2)); }

/** QE55QN90DAUXRU → qe55qn90d: серия без кода региона; непонятная модель — первые 10 символов. */
function shortModel(model) {
    const m = String(model || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const hit = /^([A-Z]{2}\d{2}[A-Z]+\d+[A-Z]?)/.exec(m);
    return (hit ? hit[1] : m.slice(0, 10) || 'tizen').toLowerCase();
}

function makeTvId(model, duid) {
    const base = shortModel(model);
    const tail = String(duid || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    for (let n = 4; n <= Math.max(4, tail.length); n += 2) {
        const id = `${base}_${tail.slice(-n) || '0000'}`;
        if (!tvs[id] || tvs[id].duid === duid) return id;
    }
    let k = 2;
    while (tvs[`${base}_${tail}${k}`]) k++;
    return `${base}_${tail}${k}`;
}

function topicsFor(id) {
    const p = `iptv/${id}`;
    return {
        prefix: p,
        set_channel: `${p}/set_channel`, set_channel_result: `${p}/set_channel/result`,
        current_channel: `${p}/current_channel`,
        command: `${p}/command`, command_result: `${p}/command/result`,
        set_playlist: `${p}/set_playlist`, set_playlist_result: `${p}/set_playlist/result`,
        current_playlist: `${p}/current_playlist`,
        state: `${p}/state`, availability: `${p}/availability`, channels: `${p}/channels`,
        config: `${p}/config`, power_on: `${p}/tv/power_on`, launch: `${p}/tv/launch`
    };
}

function tvPublic(t) {
    return {
        tv_id: t.tv_id, name: t.name, model: t.model, ip: t.ip,
        remote_entity: t.remote_entity || '', media_player: t.media_player || '',
        adult_mode: t.adult_mode === 'hide' ? 'hide' : 'lock',
        online: !!tvOnline[t.tv_id], paired: !!t.tokenHash, legacy: !!t.legacy,
        registeredAt: t.registeredAt, lastSeen: t.lastSeen, topics: topicsFor(t.tv_id)
    };
}

/** Модель и DUID из REST самого телевизора — если приложению webapis.productinfo недоступен. */
async function tvRestInfo(ip) {
    try {
        const res = await fetch(`http://${ip}:8001/api/v2/`, { signal: AbortSignal.timeout(4000) });
        const d = (await res.json()).device || {};
        return { duid: String(d.duid || '').replace(/^uuid:/, ''), model: d.modelName || '' };
    } catch (e) {
        return { duid: '', model: '' };
    }
}

const pairing = createPairing({ log });

function touchTv(t, model, ip, body) {
    if (model) t.model = model;
    t.ip = ip;
    t.lastSeen = new Date().toISOString();
    if (body.app_version) t.appVersion = String(body.app_version);
    saveTvs();
    publishTvConfig(t);
}

/** Запись телевизора по DUID; нет — заводим. */
function tvForDuid(duid, model, ip) {
    let t = Object.values(tvs).find(x => x.duid === duid);
    if (!t) {
        const id = makeTvId(model, duid);
        t = tvs[id] = {
            tv_id: id, duid, model, name: 'Телевизор ' + (Object.keys(tvs).length + 1),
            remote_entity: '', media_player: '', registeredAt: new Date().toISOString()
        };
        log(`TV: новый телевизор ${id} (${model}, ${ip})`);
    }
    return t;
}

/**
 * Телевизор представился. → {tv, token?} (token — только когда его выдают), {pairing: {code, expires_in}} —
 * показать код, {denied} — старый плеер на новом или переехавшем телевизоре (привязать его нельзя — обновить
 * плеер), {busy} — слишком много заявок разом.
 */
async function registerTv(body, ip) {
    let duid = String(body.duid || '').trim();
    let model = String(body.model || '').trim();
    if (!duid || !model) {
        const rest = await tvRestInfo(ip);
        duid = duid || rest.duid || String(body.installId || '').trim();
        model = model || rest.model;
    }
    if (!duid) throw new Error('нет duid');
    const newPlayer = !!body.pairing;
    let t = Object.values(tvs).find(x => x.duid === duid);
    if (t && body.token && t.tokenHash && hashToken(body.token) === t.tokenHash) {
        touchTv(t, model, ip, body);
        return { tv: t };
    }
    // телевизор, зарегистрированный до привязки по коду: старый плеер пускаем как раньше, новый сразу получает токен
    if (t && t.legacy && t.ip === ip) {
        let token;
        if (newPlayer) {
            token = makeToken();
            t.tokenHash = hashToken(token);
            t.legacy = false;
            log(`TV ${t.tv_id}: новый плеер — токен выдан без кода (телевизор был зарегистрирован раньше)`);
        }
        touchTv(t, model, ip, body);
        return { tv: t, token };
    }
    if (!newPlayer) return { denied: true };
    const p = pairing.request({ duid, model, ip });
    if (!p) return { busy: true };
    if (p.token) {
        t = tvForDuid(duid, model, ip);
        t.tokenHash = hashToken(p.token);
        t.legacy = false;
        pairing.done(duid);
        touchTv(t, model, ip, body);
        return { tv: t, token: p.token };
    }
    return { pairing: { code: p.code, expires_in: Math.round((p.expiresAt - Date.now()) / 1000) } };
}

/** Телевизор, от имени которого пришёл HTTP-запрос: по токену, у старого плеера — по адресу. */
function tvFromRequest(req) {
    const m = /^Bearer\s+(\S+)$/.exec(String(req.headers.authorization || ''));
    if (m) {
        const hash = hashToken(m[1]);
        return Object.values(tvs).find(t => t.tokenHash === hash) || null;
    }
    const ip = clientIp(req);
    return Object.values(tvs).find(t => t.legacy && t.ip === ip) || null;
}

/** MQTT-прокси: логин — tv_id, пароль — токен. → tv_id или null. */
function tvForMqtt(username, password) {
    const t = tvs[username];
    return t && t.tokenHash && password && hashToken(password) === t.tokenHash ? t.tv_id : null;
}

/**
 * Другие аддоны HA (сеть Supervisor: 172.30.32.0/23, по IPv6 — fd0c:ac1e:2100::/48; по имени
 * local-epg-builder ходят по IPv6) — например, другой аддон берёт список телевизоров.
 */
function fromHassio(req) {
    const ip = clientIp(req);
    return /^172\.30\.3[23]\./.test(ip) || /^fd0c:ac1e:2100:/i.test(ip);
}

/**
 * Кому можно: public — всем (телевизор ещё без токена, постеры в <img>, проверка «жив ли»),
 * admin — только через панель IPTV в HA, tv — телевизору с токеном (и панели).
 */
function routeAccess(url) {
    if (url === '/' || url === '/tvs/register' || url === '/status' || /^\/posters\//.test(url)) return 'public';
    if (url === '/tvs.json' || /^\/tvs\//.test(url) || /^\/mapping/.test(url) || url === '/rebuild' ||
        /^\/parental\/(pin|off|groups)$/.test(url) || /^\/pairing\//.test(url) || /^\/plugins\//.test(url)) return 'admin';
    return 'tv';
}

// ───────────────────────── Карточка HA ─────────────────────────

let tvChannels = {};      // tv_id -> { updatedAt, playlist, channels } из iptv/<tv_id>/channels

/** Собранный M3U, который сейчас открыт на телевизоре (по имени из iptv/<tv_id>/channels), иначе первый. */
function bundleForTv(id) {
    const want = tvChannels[id] && tvChannels[id].playlist;
    const pl = playlistIndex.find(p => p.kind === 'tv' && p.name === want && bundles[p.id]) ||
        playlistIndex.find(p => p.kind === 'tv' && bundles[p.id]);
    return pl ? bundles[pl.id].data : null;
}

/** channels-<tv_id>.json для карточек HA. После сборки, при новом списке с TV и раз в 30 мин
 *  (окно передач в файле короткое и должно сдвигаться). */
function updateCardData() {
    const playlists = playlistIndex.map(p => ({
        id: p.id, name: p.name, kind: p.kind,
        src: p.kind === 'vod' ? ((VodSources.parseUrl(p.url) || {}).type || 'portal') : undefined
    }));
    status.card = { writtenAt: new Date().toISOString(), tvs: {} };
    for (const id of Object.keys(tvs)) {
        try {
            const pc = parental.forCard(tvs[id].adult_mode, allGroups());
            const data = card.buildCardData(bundleForTv(id), tvChannels[id],
                {
                    playlists, tv: { tv_id: id, name: tvs[id].name, media_player: tvs[id].media_player || '' },
                    // M3U, из которого каналы в этом файле (на TV может быть открыт портал — это не он)
                    tv_playlist: (tvChannels[id] && tvChannels[id].playlist) || null,
                    parental: pc
                });
            // на этом TV защищённые группы скрыты — в карточке их тоже нет
            if (pc.enabled && pc.mode === 'hide') data.channels = data.channels.filter(c => pc.groups.indexOf(c[1]) < 0);
            const bytes = card.writeCardData(data, `channels-${id}.json`);
            status.card.tvs[id] = { channels: data.channels.length, bytes };
        } catch (err) {
            status.card.error = err.message;
            log('карточка HA: ошибка записи данных карточки: ' + err.message);
        }
    }
    // список телевизоров — для визуального редактора карточки (выбор TV из выпадающего списка)
    try {
        card.writeCardData(Object.values(tvs).map(t => ({ tv_id: t.tv_id, name: t.name, model: t.model, media_player: t.media_player || '' })), 'tvs.json');
    } catch (err) {
        log('карточка HA: tvs.json не записался: ' + err.message);
    }
}

// ───────────────────────── Питание и запуск плеера ─────────────────────────

/** Адрес телевизора и его сущности интеграции Samsung Smart TV (задаются на странице аддона). */
function tvTarget(id) {
    const t = tvs[id];
    if (!t) throw new Error('unknown tv');
    return { host: t.ip, remote: t.remote_entity || '', player: t.media_player || '' };
}

/** Сущности media_player/remote из HA — для выпадающих списков на странице аддона. */
async function haEntities() {
    try {
        const res = await fetch('http://supervisor/core/api/states', {
            headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}` },
            signal: AbortSignal.timeout(5000)
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const states = await res.json();
        const pick = domain => states.filter(s => s.entity_id.startsWith(domain + '.'))
            .map(s => ({ id: s.entity_id, name: (s.attributes && s.attributes.friendly_name) || s.entity_id }))
            .sort((a, b) => a.id.localeCompare(b.id));
        return { remote: pick('remote'), media_player: pick('media_player') };
    } catch (e) {
        return null;   // запуск на компьютере или API недоступен — будут текстовые поля
    }
}

/**
 * Запуск приложения на телевизоре — кнопка «Открыть плеер» карточки HA. Через REST-API самого TV
 * (порт 8001), а не media_player.play_media интеграции Samsung TV: та шлёт запуск типа DEEP_LINK,
 * и установленное в режиме разработчика приложение на него молча не запускается (проверено 14.09.2026).
 */
async function launchTvApp(target, appId) {
    if (!/^[\w.]+$/.test(appId)) return { ok: false, app: appId, error: 'bad_app_id' };
    const url = `http://${target.host}:8001/api/v2/applications/${appId}`;
    try {
        const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        log(`TV: запущено приложение ${appId} на ${target.host}`);
        return { ok: true, app: appId };
    } catch (err) {
        log(`TV: не удалось запустить ${appId} на ${target.host}: ${err.message}`);
        return { ok: false, app: appId, error: err.message };
    }
}

/**
 * Включение TV. media_player.turn_on интеграции Samsung TV — только Wake-on-LAN, а TV по Wi-Fi WoL не
 * слышит. Зато в дежурном режиме он в сети (REST :8001 отвечает PowerState: standby) и просыпается от
 * KEY_POWER по websocket — его шлёт интеграция HA (remote.send_command, вызываем через Supervisor API).
 * KEY_POWER — переключатель, поэтому сначала смотрим PowerState: включённый TV не трогаем, а после
 * команды ждём 'on' и при неудаче повторяем. TV не отвечает совсем (глубокий сон) — turn_on (WoL).
 */
const powerBusy = new Set();

async function tvPowerState(host) {
    try {
        const res = await fetch(`http://${host}:8001/api/v2/`, { signal: AbortSignal.timeout(4000) });
        const d = await res.json();
        return (d.device && d.device.PowerState) || 'on';   // старые прошивки PowerState не сообщают
    } catch (e) {
        return null;   // не отвечает — выключен полностью или ещё нет сети
    }
}

async function haService(domain, service, data) {
    const res = await fetch(`http://supervisor/core/api/services/${domain}/${service}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) throw new Error(`HA ${domain}.${service}: HTTP ${res.status}`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));


async function tvPowerOn(target) {
    if (powerBusy.has(target.host)) return { ok: false, error: 'busy' };
    powerBusy.add(target.host);
    try {
        // Сразу после выключения TV ещё рвёт websocket с HA, и первый KEY_POWER пропадает (замерено: нажали
        // через 10 с после выкл — сработала только вторая попытка). Поэтому повторяем часто: пробуждение
        // до 'on' занимает ~4 с, интервал 6 с не даёт второму нажатию выключить уже просыпающийся TV.
        for (let attempt = 1; attempt <= 6; attempt++) {
            const state = await tvPowerState(target.host);
            if (state === 'on') {
                log(`TV ${target.host}: включён${attempt > 1 ? ' (попытка ' + (attempt - 1) + ')' : ' уже'}`);
                return { ok: true, state: 'on', attempts: attempt - 1 };
            }
            if (state === null) {
                if (!target.player) return { ok: false, state, error: 'no_media_player' };
                log(`TV ${target.host}: не отвечает — Wake-on-LAN через media_player.turn_on`);
                await haService('media_player', 'turn_on', { entity_id: target.player }).catch(e => log(e.message));
            } else {
                if (!target.remote) return { ok: false, state, error: 'no_remote_entity' };
                log(`TV ${target.host}: ${state} — KEY_POWER (попытка ${attempt})`);
                await haService('remote', 'send_command', { entity_id: target.remote, command: 'KEY_POWER' });
            }
            for (let i = 0; i < 6; i++) {
                await sleep(1000);
                if (await tvPowerState(target.host) === 'on') {
                    log(`TV ${target.host}: включился (попытка ${attempt})`);
                    return { ok: true, state: 'on', attempts: attempt };
                }
            }
        }
        const state = await tvPowerState(target.host);
        log(`TV ${target.host}: не включился, состояние ${state}`);
        return { ok: false, state, error: 'not_turned_on' };
    } catch (err) {
        log(`TV ${target.host}: ошибка включения: ${err.message}`);
        return { ok: false, error: err.message };
    } finally {
        powerBusy.delete(target.host);
    }
}

// ───────────────────────── MQTT ─────────────────────────

/**
 * Логин к брокеру Mosquitto аддон получает от Supervisor (services: mqtt в config.yaml),
 * настраивать ничего не нужно. Для запуска на компьютере — MQTT_URL/MQTT_USER/MQTT_PASSWORD.
 */
async function mqttOptions() {
    if (process.env.MQTT_URL) {
        return { url: process.env.MQTT_URL, username: process.env.MQTT_USER, password: process.env.MQTT_PASSWORD };
    }
    const res = await fetch('http://supervisor/services/mqtt', {
        headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}` }
    });
    if (!res.ok) throw new Error('supervisor /services/mqtt: HTTP ' + res.status);
    const d = (await res.json()).data;
    return { url: `${d.ssl ? 'mqtts' : 'mqtt'}://${d.host}:${d.port}`, username: d.username, password: d.password };
}

let mqttClient = null;
let mqttLogin = null;
const tvOnline = {};      // tv_id -> true, пока iptv/<tv_id>/availability = online
const tvState = {};       // tv_id -> последний iptv/<tv_id>/state (что играет) — для «что идёт» у Assist

function mqttPublish(topic, payload, opts) {
    if (mqttClient && mqttClient.connected) mqttClient.publish(topic, typeof payload === 'string' ? payload : JSON.stringify(payload), opts || {});
}

/** Имя телевизора (retained): плеер берёт отсюда имя прибора в MQTT Discovery. */
function publishTvConfig(t) {
    mqttPublish(topicsFor(t.tv_id).config, { tv_id: t.tv_id, name: t.name, parental: parental.forTv(t.adult_mode, allGroups()) }, { retain: true });
}

// ───────────────────────── Родительский контроль ─────────────────────────

const parental = createParental({ file: path.join(DATA_DIR, 'parental.json'), log });

/** Все группы собранных M3U-плейлистов — для выбора защищённых и для выбора по названию по умолчанию. */
function allGroups() {
    const set = new Set();
    Object.values(bundles).forEach(b => (b.data.channels || []).forEach(c => { if (c.group) set.add(c.group); }));
    return [...set];
}

/** Защита поменялась — телевизоры получают её в retained config, карточки — в своих файлах. */
function parentalChanged() {
    Object.values(tvs).forEach(publishTvConfig);
    updateCardData();
}

function parentalError(r) {
    return r.error === 'too_many' ? tr('assist.pinTooMany', { s: r.retry_in })
        : r.error === 'disabled' ? tr('assist.parentalOff') : tr('pin.wrong');
}

/** Запрос пришёл через панель IPTV в HA (там уже вошли в HA), а не напрямую на порт 8765. */
function fromIngress(req) {
    return clientIp(req) === INGRESS_IP || process.env.PARENTAL_ANY_CLIENT === '1';
}

/** Список плейлистов поменялся (после сборки) — телевизоры перечитают /playlists.json. */
function publishPlaylistsChanged() {
    mqttPublish('iptv/playlists', { updatedAt: Math.floor(Date.now() / 1000), playlists: publicPlaylists() }, { retain: true });
}

/** Строки источников из опций, которые не ведёт раздел «Плагины», + включённые источники из него. */
function withPluginSources(list) {
    const managed = new Set(plugins.managedTypes());
    return list.filter(p => p.kind !== 'vod' || !managed.has((VodSources.parseUrl(p.url) || {}).type))
        .concat(plugins.sources());
}

/** Плагины поменялись (установка, настройки) — новый список источников всем: карточке и телевизорам. */
function refreshVodSources() {
    try {
        const list = readOptions().playlists;
        // только что поставили плагин, а его строка ещё в опциях — настройки берутся оттуда
        plugins.importLegacy(list.filter(p => p.kind === 'vod'));
        playlistIndex = withPluginSources(list);
    } catch (e) { /* нет опций */ }
    updateCardData();
    publishPlaylistsChanged();
}

// Сущности, которые плеер создаёт через MQTT Discovery (js/mqtt-bridge.js publishDiscovery) — чтобы удалить прибор.
const DISCOVERY_ENTITIES = [
    ['sensor', 'channel'], ['sensor', 'playback'], ['sensor', 'programme'], ['text', 'set_channel'],
    ['select', 'playlist'], ['number', 'volume'], ['switch', 'mute'], ['button', 'play_pause'], ['button', 'stop'],
    ['button', 'next'], ['button', 'prev'], ['button', 'volume_up'], ['button', 'volume_down']
];
const RETAINED_TV_TOPICS = ['state', 'current_channel', 'current_playlist', 'availability', 'channels', 'config'];

/** Пустое retained-сообщение удаляет и сущность discovery, и сохранённое в брокере состояние. */
function clearTvFromBroker(deviceId, topicPrefix) {
    DISCOVERY_ENTITIES.forEach(([c, e]) => mqttPublish(`homeassistant/${c}/${deviceId}/${e}/config`, '', { retain: true }));
    RETAINED_TV_TOPICS.forEach(s => mqttPublish(`${topicPrefix}/${s}`, '', { retain: true }));
}

/**
 * Прибор «Tizen IPTV» и топики iptv/… без tv_id от плеера до 2.0 больше не нужны (15.09.2026 решили
 * убрать): при каждом подключении чистим их в брокере — пустые retained-сообщения ничего не стоят.
 */
function clearOldPlayerTopics() {
    clearTvFromBroker('tizen_iptv', 'iptv');
}

/**
 * sensor.iptv_otvet — последний ответ на iptv/request (состояние — message, атрибуты — весь ответ).
 * Скрипты HA для Assist (ha-config/iptv-assist-scripts.yaml) публикуют запрос и ждут через wait_template,
 * пока request_id в атрибутах станет их: условие проверяется и сразу, поэтому быстрый ответ не теряется.
 */
function publishAssistSensor() {
    mqttPublish('homeassistant/sensor/iptv_addon/answer/config', {
        name: tr('assist.sensorName'), unique_id: 'iptv_addon_answer', object_id: 'iptv_otvet', default_entity_id: 'sensor.iptv_otvet',
        state_topic: 'iptv/request/result', json_attributes_topic: 'iptv/request/result',
        value_template: "{{ (value_json.message or value_json.error or '')[:250] }}",
        icon: 'mdi:message-reply-text-outline',
        device: { identifiers: ['iptv_addon'], name: tr('assist.deviceName'), manufacturer: 'AssisTV', model: 'epg_builder' }
    }, { retain: true });
}

async function startMqtt() {
    let mqtt;
    try { mqtt = require('mqtt'); } catch (e) { log('MQTT: модуль mqtt не установлен'); return; }
    try { mqttLogin = await mqttOptions(); } catch (err) { log('MQTT: нет данных для подключения: ' + err.message); return; }
    const client = mqttClient = mqtt.connect(mqttLogin.url, {
        username: mqttLogin.username, password: mqttLogin.password,
        clientId: 'epg-builder-' + Math.random().toString(16).slice(2), reconnectPeriod: 10000
    });
    let writeTimer = null;
    client.on('connect', () => {
        log(`MQTT: подключён к ${mqttLogin.url}`);
        client.subscribe(['iptv/+/channels', 'iptv/+/availability', 'iptv/+/tv/power_on', 'iptv/+/tv/launch', 'iptv/+/tv/power_off',
            'iptv/+/set_channel/result', 'iptv/+/vod/play/result', 'iptv/+/command/result', 'iptv/+/state',
            'iptv/request', 'iptv/card/request', 'iptv/vod/search', 'iptv/vod/details']);
        clearOldPlayerTopics();
        publishAssistSensor();
        Object.values(tvs).forEach(publishTvConfig);
        publishPlaylistsChanged();
    });
    client.on('error', (err) => log('MQTT: ' + err.message));
    client.on('message', (topic, payload, packet) => {
        const text = payload.toString('utf8');
        if (!packet.retain) feedWaiters(topic, text);
        // iptv/card/request — то же самое для карточки HA: ответ идёт мимо sensor.iptv_otvet (списки передач
        // архива в атрибутах сенсора не нужны, а у атрибутов есть предел размера)
        if (topic === 'iptv/request' || topic === 'iptv/card/request') {
            if (packet.retain || !text) return;
            let msg;
            try { msg = JSON.parse(text); } catch (e) { msg = null; }
            if (!msg || typeof msg !== 'object') return mqttPublish(topic + '/result', { ok: false, error: 'bad_json', message: tr('assist.badJson') });
            handleRequest(msg, topic + '/result');
            return;
        }
        if (topic === 'iptv/vod/search' || topic === 'iptv/vod/details') {
            if (!packet.retain && text) handleVodTopic(topic.split('/')[2], text);
            return;
        }
        const parts = topic.split('/');
        const id = parts[1];
        const sub = parts.slice(2).join('/');
        if (!tvs[id]) return;   // незарегистрированный телевизор или чужой топик

        if (sub === 'tv/power_off') {
            // плеер досчитал таймер сна (js/sleep-timer.js) — выключить телевизор может только HA
            if (!packet.retain) {
                log(`таймер сна: плеер ${id} просит выключить телевизор`);
                tvPowerOff(tvs[id]).then(r => mqttPublish(`${topic}/result`, Object.assign({ tv_id: id }, r)))
                    .catch(err => mqttPublish(`${topic}/result`, { tv_id: id, ok: false, error: err.message }));
            }
            return;
        }
        if (sub === 'tv/power_on' || sub === 'tv/launch') {
            if (!packet.retain) handleTvAction(id, parts[3], text, `${topic}/result`);
            return;
        }
        if (sub === 'availability') {
            tvOnline[id] = text.trim() === 'online';
            return;
        }
        if (sub === 'state') {
            try { tvState[id] = text ? JSON.parse(text) : null; } catch (e) { /* не JSON — пропускаем */ }
            trackWatched(id);
            return;
        }
        if (sub === 'channels') {
            if (!text) return;   // очистка retained при удалении телевизора
            try {
                const msg = JSON.parse(text);
                if (!Array.isArray(msg.channels) || !msg.channels.length) return;
                const prev = tvChannels[id];
                if (prev && prev.updatedAt === msg.updatedAt && prev.playlist === msg.playlist) return;
                tvChannels[id] = { updatedAt: msg.updatedAt, playlist: msg.playlist || null, channels: msg.channels };
                fs.writeFileSync(TV_CHANNELS_FILE, JSON.stringify(tvChannels));
                log(`MQTT: плейлист с TV ${id} — ${msg.channels.length} каналов${msg.playlist ? ' («' + msg.playlist + '»)' : ''}`);
                clearTimeout(writeTimer);
                writeTimer = setTimeout(updateCardData, 1000);
            } catch (err) {
                log(`MQTT: не разобрал ${topic}: ${err.message}`);
            }
        }
    });
}

function handleTvAction(id, action, text, resultTopic) {
    let target;
    try { target = tvTarget(id); } catch (e) { return; }
    const job = action === 'power_on' ? tvPowerOn(target) : launchTvApp(target, text.trim() || DEFAULT_APP_ID);
    job.then(result => mqttPublish(resultTopic, Object.assign({ tv_id: id }, result)));
}

// ───────────────────────── Фильмы и запросы «на каком телевизоре» ─────────────────────────

// рейтинги и жанры фильмов: опция tmdb_key пустая — модуль выключен, карточки как раньше
const tmdb = createTmdb({
    getKey: () => { try { return readOptions().tmdbKey; } catch (e) { return ''; } },
    getLang: () => I18n.language(),
    file: path.join(DATA_DIR, 'tmdb.json'),
    log
});

// рейтинг Кинопоиска и рецензии зрителей по-русски: опция kinopoisk_key пустая — модуль выключен
const kp = createKinopoisk({
    getKey: () => { try { return readOptions().kinopoiskKey; } catch (e) { return ''; } },
    file: path.join(DATA_DIR, 'kinopoisk.json'),
    log
});

/**
 * Источники фильмов — плагины (plugins.js): ставятся со страницы аддона, выполняются в песочнице
 * (sandbox.js — отдельный процесс без доступа к файлам и без токена Supervisor).
 */
const sandbox = createSandbox({ log });
const plugins = createPlugins({
    builtinDir: path.join(__dirname, 'shared', 'vod-sources'),
    legacyDir: process.env.LEGACY_PLUGINS_DIR || '/homeassistant/tizen-iptv/plugins',
    userDir: process.env.PLUGINS_DIR || '/config/plugins',
    stateFile: path.join(DATA_DIR, 'plugins.json'),
    sandbox, VodSources, log
});
// строки portal::[key:…] из опций переносятся в настройки плагина один раз (refreshVodSources), дальше их ведёт
// раздел «Плагины»
const pluginsReady = plugins.load().then(refreshVodSources).catch(err => log('плагины: ' + err.message));

const vod = createVod({
    getSourceUrls: () => playlistIndex.filter(x => x.kind === 'vod').map(x => x.url),
    clientFor: (url, type) => sandbox.client(url, type),
    wwwDir: card.WWW_DIR,
    tmdb,
    kp,
    log
});

// избранное общее на все телевизоры и карточку (favorites.js)
const favorites = createFavorites({ file: path.join(DATA_DIR, 'favorites.json'), log });

// «Посмотреть позже» — то, что прислали с телефона (watchlist.js); тоже общее на все телевизоры
const watchlist = createWatchlist({ file: path.join(DATA_DIR, 'watchlist.json'), log, kp, vod });

function syncFavoritePosterPins() {
    vod.setPinnedPosters(favorites.list().map(item => favorites.idOf(item)).concat(watchlist.posterIds()));
}

syncFavoritePosterPins();

const favoritePosterJobs = new Map();

/**
 * Вернуть локальную копию постера избранного после очистки кеша. Сначала используем сохранённую ссылку,
 * а для старых записей, у которых остался только /local/ путь, заново спрашиваем карточку у её источника.
 */
function ensureFavoritePoster(item) {
    const id = favorites.idOf(item);
    if (id == null) return Promise.resolve(null);
    const cached = vod.cachedPoster(id);
    if (cached) {
        favorites.setPosterLocal(id, cached);
        return Promise.resolve(cached);
    }
    if (favoritePosterJobs.has(id)) return favoritePosterJobs.get(id);
    const job = (async () => {
        let local = null;
        if (item.poster && !/^\/local\//.test(item.poster)) {
            local = await vod.poster(id, item.poster);
        }
        if (!local) {
            try {
                const details = await vod.details(id);
                local = details && details.poster && /^\/local\//.test(details.poster) ? details.poster : null;
            } catch (e) {
                log(`избранное: не удалось восстановить постер «${item.title}» (${id}): ${e.message}`);
            }
        }
        if (local) favorites.setPosterLocal(id, local);
        return local;
    })().finally(() => favoritePosterJobs.delete(id));
    favoritePosterJobs.set(id, job);
    return job;
}

/** Фоновое восстановление старых постеров; параллельность ограничена, чтобы не нагружать источники. */
async function repairFavoritePosters() {
    const items = favorites.list();
    items.forEach(item => {
        const id = favorites.idOf(item);
        const cached = vod.cachedPoster(id);
        if (cached) favorites.setPosterLocal(id, cached);
    });
    const missing = items.filter(item => !vod.cachedPoster(favorites.idOf(item)));
    for (let i = 0; i < missing.length; i += 3) {
        await Promise.all(missing.slice(i, i + 3).map(item => ensureFavoritePoster(item).catch(() => null)));
    }
}

/**
 * Добавить/убрать/переключить избранное. Постер для карточки докачивается в фоне: ждать его
 * телевизору незачем, кнопка должна отзываться сразу.
 * msg — {id | fid (+src), title, …, add?}; fid без источника означает portal (старая карточка).
 * → {ok, id, fid, favorite, items}
 */
function toggleFavorite(msg) {
    const id = favorites.idOf(msg);
    const on = favorites.set(msg, msg.add);
    syncFavoritePosterPins();
    if (on) {
        const item = favorites.list().find(x => VodSources.sameId(favorites.idOf(x), id));
        if (item) ensureFavoritePoster(item).catch(() => { /* постер не критичен */ });
    }
    return { ok: true, id, fid: msg.fid, favorite: on, items: favorites.list() };
}

/** Ответ, которого ждём от телевизора: {topic, match(msg) → bool} → promise с сообщением или null по таймауту. */
const waiters = new Set();
function waitFor(topic, match, timeoutMs) {
    return new Promise(resolve => {
        const w = { topic, match, resolve };
        waiters.add(w);
        w.timer = setTimeout(() => { waiters.delete(w); resolve(null); }, timeoutMs);
    });
}
function feedWaiters(topic, text) {
    for (const w of [...waiters]) {
        if (w.topic !== topic) continue;
        let msg = text;
        try { msg = JSON.parse(text); } catch (e) { /* строка */ }
        if (!w.match(msg)) continue;
        clearTimeout(w.timer);
        waiters.delete(w);
        w.resolve(msg);
    }
}

/** Области HA телевизоров (прибор «IPTV …» или сущность Samsung TV) — для «на телевизоре в спальне». */
let areasCache = { at: 0, map: {} };
async function tvAreas() {
    if (Date.now() - areasCache.at < 5 * 60 * 1000) return areasCache.map;
    const ids = Object.keys(tvs);
    const tpl = ids.map(id => `${id}={{ area_name('sensor.iptv_${id}_playback') or area_name('${tvs[id].media_player || 'none.none'}') or '' }}`).join('\n');
    try {
        const res = await fetch('http://supervisor/core/api/template', {
            method: 'POST',
            headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ template: tpl }),
            signal: AbortSignal.timeout(5000)
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const map = {};
        (await res.text()).split('\n').forEach(line => {
            const i = line.indexOf('=');
            if (i > 0) map[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^None$/, '');
        });
        areasCache = { at: Date.now(), map };
    } catch (e) {
        areasCache.at = Date.now() - 4 * 60 * 1000;   // повторить через минуту
    }
    return areasCache.map;
}

// слова, которые не отличают один телевизор от другого («на телевизоре в спальне», "the TV in the bedroom")
const TV_STOP_WORDS = ['телевизор', 'телевизоре', 'телевизора', 'комната', 'комнате', 'телевізор', 'телевізорі', 'телевізора',
    'кімната', 'кімнаті', 'the', 'television', 'room', 'fernseher', 'fernsehen', 'zimmer', 'dem', 'der', 'die', 'das', 'im'];

/** «в нашей спальне» ~ «Спальня Наша»: слова сравниваются по началу (падежи), порядок не важен. */
function wordsMatch(query, target) {
    const ws = s => String(s || '').toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3)
        .filter(w => !TV_STOP_WORDS.includes(w));
    const q = ws(query);
    const t = ws(target);
    if (!q.length || !t.length) return 0;
    const same = (a, b) => { const n = Math.max(3, Math.min(a.length, b.length) - 2); return a.slice(0, n) === b.slice(0, n); };
    const hit = q.filter(a => t.some(b => same(a, b))).length;
    return hit / Math.max(q.length, t.length);
}

/**
 * Какой телевизор имели в виду. tv — tv_id, имя или область (как сказали голосом); пусто — тот, где плеер
 * запущен, если он один. → {tv} | {error: 'tv_not_found'|'ambiguous_tv'|'no_tv', tvs}
 */
async function resolveTv(tvQuery) {
    const list = Object.values(tvs);
    const areas = await tvAreas();
    const brief = t => ({ tv_id: t.tv_id, name: t.name, area: areas[t.tv_id] || '', online: !!tvOnline[t.tv_id] });
    if (!list.length) return { error: 'no_tv', tvs: [] };
    const q = String(tvQuery || '').trim();
    if (q) {
        if (tvs[q]) return { tv: tvs[q] };
        const scored = list.map(t => ({ t, s: Math.max(wordsMatch(q, t.name), wordsMatch(q, areas[t.tv_id])) }))
            .filter(x => x.s > 0).sort((a, b) => b.s - a.s);
        if (!scored.length) return { error: 'tv_not_found', tvs: list.map(brief) };
        if (scored.length > 1 && scored[0].s === scored[1].s) return { error: 'ambiguous_tv', tvs: scored.map(x => brief(x.t)) };
        return { tv: scored[0].t };
    }
    if (list.length === 1) return { tv: list[0] };
    const on = list.filter(t => tvOnline[t.tv_id]);
    if (on.length === 1) return { tv: on[0] };
    return { error: on.length ? 'ambiguous_tv' : 'no_tv_on', tvs: (on.length ? on : list).map(brief) };
}

/** Плеер на телевизоре запущен и на связи: иначе включить TV, запустить плеер и дождаться online. */
async function ensurePlayer(t) {
    const target = tvTarget(t.tv_id);
    const state = await tvPowerState(target.host);
    // online без включённого TV — только что выключили, брокер ещё не заметил пропажу плеера
    if (tvOnline[t.tv_id] && state === 'on') return { ok: true };
    tvOnline[t.tv_id] = false;
    if (state !== 'on') {
        const p = await tvPowerOn(target);
        if (!p.ok) return { ok: false, error: 'tv_power_' + (p.error || 'failed') };
    }
    if (tvOnline[t.tv_id]) return { ok: true };
    // Запускаем сразу: раньше ждали 8 с, вдруг TV сам откроет плеер, но по журналу (04–06.11.2026) этого
    // не случилось ни разу — только +8 с к голосовой команде. Плеер уже открыт — запуск выводит его на экран.
    const l = await launchTvApp(target, DEFAULT_APP_ID);
    if (!l.ok) return { ok: false, error: 'launch_failed' };
    const online = tvOnline[t.tv_id] || await waitFor(`iptv/${t.tv_id}/availability`, m => m === 'online', 45000);
    return online ? { ok: true, started: true } : { ok: false, error: 'player_not_online' };
}

let requestSeq = 0;

/** Ответ «не понял, какой телевизор» из resolveTv. */
function tvError(found, tvQuery) {
    const names = found.tvs.map(t => t.name + (t.area ? ' (' + t.area + ')' : '')).join(', ');
    return {
        ok: false, error: found.error, tvs: found.tvs,
        message: found.error === 'ambiguous_tv' ? tr('assist.whichTv', { list: names })
            : found.error === 'tv_not_found' ? tr('assist.tvNotFound', { tv: tvQuery, list: names })
                : found.error === 'no_tv_on' ? tr('assist.noTvOn', { list: names })
                    : tr('assist.noTv')
    };
}

/** ISO-время для страницы: «30 окт., 19:08» на языке аддона; нет или битое — «—». */
// внизу страницы аддона: где код и как поддержать проект
const PROJECT_URL = 'https://github.com/indoor25/AssisTV';
const SUPPORT_URL = 'https://ko-fi.com/indoor25';
const whenLabel = iso => {
    const d = new Date(iso || NaN);
    return isNaN(d) ? '—' : d.toLocaleString(I18n.locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: process.env.TZ || undefined });
};
const hhmm = sec => new Date(sec * 1000).toLocaleTimeString(I18n.locale(), { hour: '2-digit', minute: '2-digit', timeZone: process.env.TZ || undefined });

/** Что играет на телевизоре — одной фразой и полями. */
function tvStatus(t, area) {
    const s = tvState[t.tv_id];
    const out = { tv_id: t.tv_id, name: t.name, area: area || '', online: !!tvOnline[t.tv_id] };
    if (!out.online || !s) return Object.assign(out, { text: tr('assist.playerOffShort', { tv: t.name }) });
    Object.assign(out, {
        state: s.state, channel: s.channel, number: s.number, group: s.group, playlist: s.playlist,
        programme: s.programme, programme_start: s.programme_start, programme_stop: s.programme_stop,
        volume: s.volume, muted: s.muted, film: s.vod_title || undefined, archive: !!s.archive,
        sleep_minutes: s.sleep_until ? Math.max(1, Math.round((s.sleep_until - Date.now() / 1000) / 60)) : undefined
    });
    const what = s.vod_title ? tr('assist.statusMovie', { title: s.vod_title })
        : tr(s.archive ? 'assist.statusChannelArchive' : 'assist.statusChannel', { channel: s.channel || '—' }) +
            (s.programme ? tr('assist.statusProgramme', { title: s.programme }) +
                (s.programme_stop && !s.archive ? tr('assist.statusUntil', { time: hhmm(s.programme_stop) }) : '') : '');
    const extra = [s.state && s.state !== 'playing' && I18n.has('assist.state.' + s.state) ? tr('assist.state.' + s.state) : '',
        s.muted ? tr('assist.statusMuted') : s.volume != null ? tr('assist.statusVolume', { n: s.volume }) : '',
        out.sleep_minutes ? tr('assist.statusSleep', { n: out.sleep_minutes }) : ''].filter(Boolean).join(', ');
    return Object.assign(out, { text: tr('assist.status', { tv: t.name, what, extra: extra ? ' — ' + extra : '' }) });
}

/** action: status — что идёт на указанном телевизоре, а без tv — на всех, где плеер запущен. */
async function requestStatus(msg) {
    const areas = await tvAreas();
    let list;
    if (String(msg.tv || '').trim()) {
        const found = await resolveTv(msg.tv);
        if (found.error) return tvError(found, msg.tv);
        list = [found.tv];
    } else {
        list = Object.values(tvs).filter(t => tvOnline[t.tv_id]);
        if (!list.length) {
            return { ok: true, tvs: Object.values(tvs).map(t => tvStatus(t, areas[t.tv_id])), message: tr('assist.playerOffAll') };
        }
    }
    const res = list.map(t => tvStatus(t, areas[t.tv_id]));
    return { ok: true, tvs: res, message: res.map(x => x.text).join('. ') };
}

const GUIDE_HOURS = 24;     // на сколько вперёд отдаётся программа канала
const GUIDE_MAX = 40;       // и не больше стольких передач — список читает языковая модель

/** Каналы всех M3U-плейлистов без защищённых групп (голосом взрослые каналы не называются), один раз по имени. */
function guideChannels() {
    const locked = parental.enabled() ? new Set(parental.groups(allGroups())) : new Set();
    const seen = new Map();
    for (const pl of playlistIndex.filter(p => p.kind === 'tv' && bundles[p.id])) {
        const data = bundles[pl.id].data;
        for (const c of data.channels || []) {
            if (seen.has(c.name) || locked.has(c.group)) continue;
            seen.set(c.name, { name: c.name, group: c.group, epgId: (data.match || {})[c.name] || null });
        }
    }
    return [...seen.values()];
}

const guideDay = sec => new Date(sec * 1000).toLocaleDateString('sv-SE', { timeZone: process.env.TZ || undefined });

/**
 * action: guide — {query?, tv?}: программа канала на ближайшие сутки. Телевизор не нужен: канал ищется по имени
 * в плейлистах аддона (тем же ChannelMatch, что и на TV). Без query — канал, который сейчас идёт на телевизоре.
 * → {ok, channel, now: {start, stop, title} | null, programmes: [{date, start, stop, title}], message}.
 */
async function requestGuide(msg) {
    if (!epgCache) return { ok: false, error: 'not_ready', message: tr('assist.guideNotReady') };
    const channels = guideChannels();
    let query = String(msg.query || '').trim();
    if (!query) {
        let list;
        if (String(msg.tv || '').trim()) {
            const found = await resolveTv(msg.tv);
            if (found.error) return tvError(found, msg.tv);
            list = [found.tv];
        } else {
            list = Object.values(tvs).filter(t => tvOnline[t.tv_id]);
        }
        const playing = list.map(t => tvState[t.tv_id]).find(st => st && st.channel && !st.vod_title);
        if (!playing) return { ok: false, error: 'no_channel', message: tr('assist.guideWhichChannel') };
        query = playing.channel;
    }
    const r = ChannelMatch.find(query, channels);
    if (!r.channel) {
        return { ok: false, error: 'not_found', query, alternatives: r.alternatives, message: tr('mqtt.channelNotFound', { name: query }) };
    }
    const ch = r.channel;
    const now = Date.now() / 1000;
    const all = (ch.epgId && epgCache.epgProgrammes[ch.epgId]) || [];
    const list = all.filter(p => p[1] > now && p[0] < now + GUIDE_HOURS * 3600).slice(0, GUIDE_MAX);
    if (!list.length) return { ok: false, error: 'no_epg', channel: ch.name, message: tr('assist.guideNoEpg', { channel: ch.name }) };
    const item = p => ({ date: guideDay(p[0]), start: hhmm(p[0]), stop: hhmm(p[1]), title: p[2] });
    const current = list[0][0] <= now ? list[0] : null;
    const next = list.slice(current ? 1 : 0, (current ? 1 : 0) + VOICE_RESULTS);
    const message = (current ? tr('assist.guideNow', { channel: ch.name, title: current[2], time: hhmm(current[1]) }) : tr('assist.guideChannel', { channel: ch.name })) +
        (next.length ? tr('assist.guideNext', { list: next.map(p => hhmm(p[0]) + ' — ' + p[2]).join('; ') }) : '');
    return {
        ok: true, channel: ch.name, today: guideDay(now), time: hhmm(now),
        now: current ? item(current) : null, programmes: list.map(item), message
    };
}

// ───────────────────────── Поиск по программе и напоминания ─────────────────────────

const GUIDE_DAYS = 7;       // на сколько дней вперёд программа лежит в памяти (сколько знает источник) — для поиска

const guide = createGuide({
    file: path.join(DATA_DIR, 'reminders.json'),
    getEpg: () => epgCache,
    getChannels: guideChannels,
    dayOf: sec => guideDay(sec),
    onDue: reminderDue,
    log
});

/** «сегодня в 21:45» / «завтра в 21:45» / «9 октября в 21:45» — для фраз, которые читают вслух. */
function whenText(sec) {
    const time = hhmm(sec);
    const day = guideDay(sec);
    const now = Date.now() / 1000;
    if (day === guideDay(now)) return tr('assist.whenToday', { time });
    if (day === guideDay(now + 86400)) return tr('assist.whenTomorrow', { time });
    const date = new Date(sec * 1000).toLocaleDateString(I18n.locale(), { day: 'numeric', month: 'long', timeZone: process.env.TZ || undefined });
    return tr('assist.whenDate', { date, time });
}

/** day из запроса: today / tomorrow / YYYY-MM-DD → 'YYYY-MM-DD'; пусто или непонятно — без отбора по дню. */
function guideDayOf(day) {
    const d = String(day || '').trim().toLowerCase();
    if (d === 'today') return guideDay(Date.now() / 1000);
    if (d === 'tomorrow') return guideDay(Date.now() / 1000 + 86400);
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined;
}

const guideItem = p => ({
    title: p.title, channel: p.channel, date: guideDay(p.start), start: hhmm(p.start), stop: hhmm(p.stop),
    live: p.live || undefined, also: p.also || undefined, ref: guide.refOf(p)
});
// во фразах название уже стоит в кавычках — свои кавычки и точку в конце у названия убираем («Иван Васильевич…».)
const sayTitle = t => String(t || '').replace(/^[\s«"„“”']+|[\s»"“”'.]+$/g, '');
const guidePhrase = p => tr(p.live ? 'assist.searchLive' : 'assist.searchItem', { title: sayTitle(p.title), when: whenText(p.start), channel: p.channel, time: hhmm(p.stop) });

/** Поиск передач по запросу {query, channel?, day?} → {query, total, items} | {error: ответ} — общий для поиска и «напомни». */
function findProgrammes(msg, limit) {
    if (!epgCache) return { error: { ok: false, error: 'not_ready', message: tr('assist.guideNotReady') } };
    const query = String(msg.query || '').trim();
    if (!query) return { error: { ok: false, error: 'no_query', message: tr('assist.searchNoQuery') } };
    let epgId;
    if (String(msg.channel || '').trim()) {
        const r = ChannelMatch.find(msg.channel, guideChannels());
        if (!r.channel || !r.channel.epgId) {
            return { error: { ok: false, error: 'not_found', query: msg.channel, alternatives: r.alternatives, message: tr('mqtt.channelNotFound', { name: msg.channel }) } };
        }
        epgId = r.channel.epgId;
    }
    return Object.assign({ query }, guide.search(query, { epgId, day: guideDayOf(msg.day), limit }));
}

/**
 * action: guide_search — {query, channel?, day?: today|tomorrow|YYYY-MM-DD}: передачи по всем каналам, в названии которых
 * есть слова запроса, — те, что идут сейчас, и будущие (сколько знает источник EPG, до недели). Телевизор не нужен.
 * → {ok, total, programmes: [{title, channel, date, start, stop, live?, also?, ref}], message}; ref — для action remind.
 */
function requestGuideSearch(msg) {
    const found = findProgrammes(msg, 30);
    if (found.error) return found.error;
    if (!found.items.length) return { ok: false, error: 'not_found', query: found.query, message: tr('assist.searchNone', { query: found.query }) };
    const top = found.items.slice(0, VOICE_RESULTS);
    return {
        ok: true, query: found.query, total: found.total, today: guideDay(Date.now() / 1000), time: hhmm(Date.now() / 1000),
        programmes: found.items.map(guideItem),
        message: top.map(guidePhrase).join('; ') + (found.total > top.length ? tr('assist.searchMore', { n: found.total - top.length }) : '')
    };
}

/**
 * action: remind — {ref} (из guide_search) или {query, channel?, day?} — ближайшая ещё не начавшаяся передача по запросу.
 * За 5 минут до начала: плашка на телевизорах с запущенным плеером и событие iptv/reminder (его озвучивает HA).
 */
function requestRemind(msg) {
    let item = null;
    let alternatives;
    if (msg.ref) {
        item = guide.byRef(msg.ref);
        if (!item) return { ok: false, error: 'not_found', message: tr('assist.remindNotFound') };
    } else {
        const found = findProgrammes(msg, 10);
        if (found.error) return found.error;
        const upcoming = found.items.filter(p => !p.live);
        item = upcoming[0];
        alternatives = upcoming.slice(1, 1 + VOICE_RESULTS).map(guideItem);
        if (!item) {
            const live = found.items[0];
            return live
                ? { ok: false, error: 'already_started', programme: guideItem(live), message: tr('assist.remindLive', { title: sayTitle(live.title), channel: live.channel, time: hhmm(live.stop) }) }
                : { ok: false, error: 'not_found', query: found.query, message: tr('assist.searchNone', { query: found.query }) };
        }
    }
    const r = guide.add(item);
    if (!r.ok) return { ok: false, error: r.error, programme: guideItem(item), message: tr('assist.remindLive', { title: sayTitle(item.title), channel: item.channel, time: hhmm(item.stop) }) };
    return {
        ok: true, programme: guideItem(item), alternatives, existed: r.existed || undefined,
        message: tr('assist.remindSet', { title: sayTitle(item.title), when: whenText(item.start), channel: item.channel })
    };
}

/** action: reminders — что напомнить; action: remind_cancel {query?} — убрать (пустой query — все). */
function requestReminders() {
    const items = guide.list();
    return {
        ok: true, reminders: items.map(guideItem),
        message: items.length ? tr('assist.remindList', { list: items.slice(0, VOICE_RESULTS).map(guidePhrase).join('; ') }) +
            (items.length > VOICE_RESULTS ? tr('assist.searchMore', { n: items.length - VOICE_RESULTS }) : '')
            : tr('assist.remindEmpty')
    };
}

function requestRemindCancel(msg) {
    const gone = guide.remove(msg.ref || msg.query);
    return gone.length
        ? { ok: true, removed: gone.map(guideItem), message: tr('assist.remindCancelled', { list: gone.slice(0, VOICE_RESULTS).map(r => '«' + sayTitle(r.title) + '»').join(', ') }) }
        : { ok: false, error: 'not_found', message: tr('assist.remindNothing') };
}

/**
 * Пора напомнить: на телевизорах, где плеер запущен, — плашка (iptv/<tv_id>/notify, OK на пульте включает канал);
 * в iptv/reminder — событие для Home Assistant: говорить голосом и слать пуши — его дело, не аддона.
 */
function reminderDue(r) {
    const minutes = Math.max(0, Math.round((r.start - Date.now() / 1000) / 60));
    const text = minutes > 0 ? tr('assist.remindDue', { n: minutes, title: sayTitle(r.title), channel: r.channel })
        : tr('assist.remindDueNow', { title: sayTitle(r.title), channel: r.channel });
    const shown = Object.values(tvs).filter(t => tvOnline[t.tv_id]);
    shown.forEach(t => mqttPublish(`iptv/${t.tv_id}/notify`, { kind: 'reminder', text, title: r.title, channel: r.channel, start: r.start, seconds: 60 }));
    mqttPublish('iptv/reminder', {
        title: r.title, channel: r.channel, start: r.start, start_time: hhmm(r.start), minutes, message: text,
        tvs: shown.map(t => ({ tv_id: t.tv_id, name: t.name }))
    });
    log(`напоминание: ${text} (плашка на ${shown.length} TV)`);
}

// ───────────────────────── «Что посмотреть вечером?» ─────────────────────────

// сколько времени шёл каждый канал и передача — по состоянию плееров, раз в минуту (history.js)
const history = createHistory({ file: path.join(DATA_DIR, 'watch-history.json'), log });

const TONIGHT_CHANNELS = 25;          // столько самых смотримых каналов просматриваем
const TONIGHT_FILL = 20;              // истории ещё мало — добираем первыми каналами из порядка на телевизоре
const TONIGHT_MAX = 60;               // и не больше стольких передач отдаём ассистенту
const TONIGHT_MIN_SEC = 20 * 60;      // короткие вставки (погода, анонсы) не предлагаем

/** «21», «21:30» → секунды от полуночи; пусто или непонятно — null. */
function clockSec(v) {
    const m = /^\s*(\d{1,2})(?:[:.](\d{2}))?\s*$/.exec(String(v == null ? '' : v));
    if (!m || +m[1] > 24 || +(m[2] || 0) > 59) return null;
    return +m[1] * 3600 + +(m[2] || 0) * 60;
}

/** Каналы для подборки: самые смотримые, а пока истории мало — ещё и первые в порядке на телевизоре. */
function tonightChannels() {
    const byName = new Map(guideChannels().filter(c => c.epgId).map(c => [c.name, c]));
    const out = [];
    const seenEpg = new Set();
    const add = name => {
        const c = byName.get(name);
        if (!c || seenEpg.has(c.epgId) || !(epgCache.epgProgrammes[c.epgId] || []).length) return;
        seenEpg.add(c.epgId);
        out.push(c);
    };
    history.topChannels(TONIGHT_CHANNELS).forEach(c => add(c.name));
    const watched = out.length;
    if (watched < 10) {
        const order = Object.values(tvChannels).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
        for (const row of (order && order.channels) || []) {
            if (out.length >= TONIGHT_FILL) break;
            add(row[0]);
        }
    }
    return { list: out, watched };
}

/**
 * action: tonight — {day?: today|tomorrow|YYYY-MM-DD, from?: «19» | «19:30», to?}: что будет вечером (по умолчанию
 * сегодня с 18:00 до полуночи, но не раньше «сейчас») на каналах, которые в доме смотрят. Выбирает и советует
 * ассистент; включить — action channel, напомнить — action remind {ref}.
 * → {ok, day, from, to, channels, often_watched, programmes: [{title, channel, start, stop, minutes, live?,
 *    watched_before?, ref}], message}
 */
function requestTonight(msg) {
    if (!epgCache) return { ok: false, error: 'not_ready', message: tr('assist.guideNotReady') };
    const now = Date.now() / 1000;
    const day = guideDayOf(msg.day) || guideDay(now);
    const midnight = Math.floor(new Date(day + 'T00:00:00').getTime() / 1000);
    const fromSec = clockSec(msg.from);
    const toSec = clockSec(msg.to);
    let start = Math.max(now, midnight + (fromSec != null ? fromSec : 18 * 3600));
    let end = midnight + (toSec != null ? toSec : 24 * 3600);
    if (toSec != null && end <= midnight + (fromSec || 0)) end += 86400;   // «с 22 до 2»
    if (end - start < 3600) end = start + 3 * 3600;   // поздний вечер: до полуночи почти ничего — на три часа вперёд
    const { list, watched } = tonightChannels();
    const byAir = new Map();
    list.forEach((ch, rank) => {
        for (const p of epgCache.epgProgrammes[ch.epgId]) {
            if (p[1] <= start) continue;
            if (p[0] >= end) break;
            const live = p[0] < start;
            if (p[1] - p[0] < TONIGHT_MIN_SEC || (live && p[1] - start < 30 * 60)) continue;
            const key = p[2].toLowerCase() + '\u0001' + p[0];
            if (!byAir.has(key)) byAir.set(key, { rank, channel: ch.name, epgId: ch.epgId, start: p[0], stop: p[1], title: p[2], live });
        }
    });
    const items = [...byAir.values()].sort((a, b) => (a.rank - b.rank) || (a.start - b.start)).slice(0, TONIGHT_MAX);
    if (!items.length) return { ok: false, error: 'nothing', day, message: tr('assist.tonightNone') };
    items.forEach(p => { p.before = history.watchedTitle(p.title); });
    // вслух — три: сначала то, что уже смотрели и что ещё не началось
    const top = items.slice().sort((a, b) => (b.before - a.before) || (a.live - b.live) || (a.rank - b.rank) || (a.start - b.start)).slice(0, VOICE_RESULTS);
    items.sort((a, b) => (a.start - b.start) || (a.rank - b.rank));
    return {
        ok: true, day, today: guideDay(now), time: hhmm(now), from: hhmm(start), to: hhmm(end),
        based_on: watched >= 10 ? 'history' : watched ? 'history+playlist' : 'playlist',
        channels: list.map(c => c.name), often_watched: history.topTitles(12).map(t => t.title),
        programmes: items.map(p => ({
            title: p.title, channel: p.channel, start: hhmm(p.start), stop: hhmm(p.stop), minutes: Math.round((p.stop - p.start) / 60),
            live: p.live || undefined, watched_before: p.before || undefined, ref: guide.refOf(p)
        })),
        message: tr('assist.tonight', { list: top.sort((a, b) => a.start - b.start).map(p => tr('assist.tonightItem', { time: hhmm(p.start), title: sayTitle(p.title), channel: p.channel })).join('; ') })
    };
}

// ───────────────────────── Архив из карточки HA ─────────────────────────

/** Канал открытого на телевизоре плейлиста по имени (карточка шлёт точное имя, голос — как услышал). */
function tvChannel(tvId, name) {
    const data = bundleForTv(tvId);
    if (!data) return { data: null, channel: null };
    const channel = data.channels.find(c => c.name === name) || ChannelMatch.find(name, data.channels).channel || null;
    return { data, channel };
}

/** Канал под родительским контролем и верного PIN в запросе нет → ответ-отказ; иначе null. */
function lockedReply(channel, msg) {
    if (!parental.enabled() || !parental.groups(allGroups()).includes(channel.group)) return null;
    if (msg.pin == null) return { ok: false, error: 'locked', channel: channel.name, message: tr('assist.channelLocked', { channel: channel.name }) };
    const r = parental.check(msg.pin, 'card');
    return r.ok ? null : Object.assign(r, { message: parentalError(r) });
}

/**
 * action: archive_guide — {query: канал, tv, pin?}: передачи канала за дни архива (включая ту, что идёт) — карточка
 * показывает их списком. → {ok, channel, days, now, programmes: [[start, stop, title]]}; архива нет — days 0.
 */
async function requestArchiveGuide(msg) {
    const found = await resolveTv(msg.tv);
    if (found.error) return tvError(found, msg.tv);
    const { data, channel } = tvChannel(found.tv.tv_id, String(msg.query || ''));
    if (!data || !epgCache) return { ok: false, error: 'not_ready', message: tr('assist.guideNotReady') };
    if (!channel) return { ok: false, error: 'not_found', query: msg.query, message: tr('mqtt.channelNotFound', { name: msg.query }) };
    const locked = lockedReply(channel, msg);
    if (locked) return locked;
    const days = channel.catchup && channel.catchup.available ? channel.catchup.days : 0;
    const epgId = data.match[channel.name] || null;
    return {
        ok: true, channel: channel.name, days, now: Math.floor(Date.now() / 1000),
        programmes: days && epgId ? archiveProgrammes(epgCache, epgId, days) : []
    };
}

/** Команда плееру и её ответ: {ok, value?, error?} | null (не ответил). */
function tvCommand(t, command, value, timeoutMs = 8000) {
    const wait = waitFor(`iptv/${t.tv_id}/command/result`, m => m && m.command === command, timeoutMs);
    mqttPublish(`iptv/${t.tv_id}/command`, value === undefined ? { command } : { command, value });
    return wait;
}

/** Почему не получилось включить запись — фразой. */
function archiveErrorText(error, channel) {
    return error === 'no_archive' ? tr('assist.noArchive', { channel })
        : error === 'no_programme' ? tr('assist.noProgramme', { channel })
            : error === 'locked' ? tr('assist.channelLocked', { channel })
                : error === 'not_found' ? tr('mqtt.channelNotFound', { name: channel })
                    : error === 'timeout' ? tr('assist.timeout')
                        : tr('assist.error', { error });
}

/**
 * action: archive — {query: канал, start: unix-сек, tv, pin?}: включить запись канала с момента start
 * (карточка — передача из списка archive_guide). Без start — текущая передача с начала.
 */
async function requestArchive(msg) {
    const found = await resolveTv(msg.tv);
    if (found.error) return tvError(found, msg.tv);
    const t = found.tv;
    const base = { tv_id: t.tv_id, tv_name: t.name };
    const { channel } = tvChannel(t.tv_id, String(msg.query || ''));
    if (!channel) return Object.assign(base, { ok: false, error: 'not_found', message: tr('mqtt.channelNotFound', { name: msg.query }) });
    const locked = lockedReply(channel, msg);
    if (locked) return Object.assign(base, locked);
    const ready = await ensurePlayer(t);
    if (!ready.ok) return Object.assign(base, { ok: false, error: ready.error, message: tr('assist.playerStartFailed', { tv: t.name }) });
    const start = Number(msg.start) || null;
    const r = await tvCommand(t, 'archive', { channel: channel.name, start, key: msg.pin != null ? parental.key() : undefined }, 15000);
    if (!r) return Object.assign(base, { ok: false, error: 'timeout', message: tr('assist.timeout') });
    return Object.assign(base, {
        ok: !!r.ok, channel: channel.name, start: r.value || start, error: r.error,
        message: r.ok ? tr('assist.archiveOn', { channel: channel.name, tv: t.name }) : archiveErrorText(r.error, channel.name)
    });
}

// ───────────────────────── «Перенеси в спальню» ─────────────────────────

/**
 * action: move — {to?, from?, keep?}: то, что идёт на одном телевизоре, продолжить на другом с того же места
 * (канал, запись из архива, фильм или серия). from не назван — тот единственный, где сейчас что-то идёт; to не
 * назван — другой телевизор, если их два. Первый телевизор после этого выключается (keep: true — оставить).
 */
async function requestMove(msg) {
    const all = Object.values(tvs);
    const named = async q => (String(q || '').trim() ? resolveTv(q) : null);
    const f = await named(msg.from);
    if (f && f.error) return tvError(f, msg.from);
    const g = await named(msg.to);
    if (g && g.error) return tvError(g, msg.to);
    let from = f && f.tv;
    let to = g && g.tv;
    const active = t => { const s = tvState[t.tv_id]; return !!(tvOnline[t.tv_id] && s && s.state && s.state !== 'stopped'); };
    if (!from) {
        const list = all.filter(t => active(t) && (!to || t.tv_id !== to.tv_id));
        if (list.length !== 1) {
            return list.length ? { ok: false, error: 'ambiguous_tv', tvs: list.map(t => ({ tv_id: t.tv_id, name: t.name })), message: tr('assist.moveWhich', { list: list.map(t => t.name).join(', ') }) }
                : { ok: false, error: 'nothing_playing', message: tr('assist.moveNothing') };
        }
        from = list[0];
    }
    if (!to) {
        const others = all.filter(t => t.tv_id !== from.tv_id);
        if (others.length !== 1) return { ok: false, error: 'no_target', tvs: others.map(t => ({ tv_id: t.tv_id, name: t.name })), message: tr('assist.moveNoTarget') };
        to = others[0];
    }
    const base = { from_id: from.tv_id, from_name: from.name, tv_id: to.tv_id, tv_name: to.name };
    if (to.tv_id === from.tv_id) return Object.assign(base, { ok: false, error: 'same_tv', message: tr('assist.moveSame', { tv: to.name }) });
    if (!tvOnline[from.tv_id]) return Object.assign(base, { ok: false, error: 'nothing_playing', message: tr('assist.moveNothing') });

    const w = await tvCommand(from, 'where');
    if (!w) return Object.assign(base, { ok: false, error: 'timeout', message: tr('assist.timeout') });
    if (!w.ok || !w.value) {
        return Object.assign(base, {
            ok: false, error: w.error || 'nothing_playing',
            message: w.error === 'not_playing' || !w.error ? tr('assist.moveNothing') : tr('assist.error', { error: w.error })
        });
    }
    const p = w.value;
    const what = p.kind === 'vod' ? p.title : p.channel;

    const ready = await ensurePlayer(to);
    if (!ready.ok) return Object.assign(base, { ok: false, error: ready.error, message: tr('assist.playerStartFailed', { tv: to.name }) });
    let r;
    if (p.kind === 'vod') {
        const playId = 'move:' + Date.now();
        const wait = waitFor(`iptv/${to.tv_id}/vod/play/result`, m => m && m.request_id === playId, 30000);
        mqttPublish(`iptv/${to.tv_id}/vod/play`, { request_id: playId, id: p.id, episode_fid: p.episode_fid != null ? p.episode_fid : undefined, position: p.position, title: p.title });
        r = await wait;
    } else if (p.kind === 'archive') {
        r = await tvCommand(to, 'archive', { channel: p.channel, start: p.time }, 15000);
    } else {
        const wait = waitFor(`iptv/${to.tv_id}/set_channel/result`, () => true, 15000);
        mqttPublish(`iptv/${to.tv_id}/set_channel`, String(p.channel));
        r = await wait;
    }
    if (!r) return Object.assign(base, { ok: false, error: 'timeout', message: tr('assist.timeout') });
    if (!r.ok) {
        return Object.assign(base, {
            ok: false, error: r.error, kind: p.kind,
            message: r.error === 'locked' ? tr('assist.channelLocked', { channel: what }) : tr('assist.moveFailed', { tv: to.name, error: r.error })
        });
    }
    log(`перенос: «${what}» (${p.kind}) ${from.tv_id} → ${to.tv_id}`);
    let sourceOff = false;
    if (!(msg.keep === true || /^(true|1|yes|on)$/i.test(String(msg.keep)))) {   // из шаблона HA приходит и строкой
        await tvCommand(from, 'stop', undefined, 4000);
        sourceOff = await tvPowerOff(from).then(x => x.ok, () => false);
    }
    return Object.assign(base, { ok: true, kind: p.kind, title: what, position: p.position, source_off: sourceOff, message: tr('assist.moved', { what, tv: to.name }) });
}

// ───────────────────────── Таймер сна ─────────────────────────

/** Выключить телевизор (интеграция Samsung Smart TV в HA). */
async function tvPowerOff(t) {
    if (!t.media_player) return { ok: false, error: 'no_media_player' };
    await haService('media_player', 'turn_off', { entity_id: t.media_player });
    return { ok: true };
}

// Таймер сна ведёт плеер (отсчёт на экране, плавное снижение громкости) и в конце просит аддон выключить TV
// (iptv/<tv_id>/tv/power_off). Плеер не запущен (смотрят YouTube) — «выключи через полчаса» отсчитывает сам аддон.
const addonSleep = {};    // tv_id -> {timer, until}

function setAddonSleep(t, minutes) {
    if (addonSleep[t.tv_id]) clearTimeout(addonSleep[t.tv_id].timer);
    delete addonSleep[t.tv_id];
    if (!(minutes > 0)) return;
    addonSleep[t.tv_id] = {
        until: Date.now() + minutes * 60000,
        timer: setTimeout(() => {
            delete addonSleep[t.tv_id];
            log(`таймер сна: выключаю ${t.tv_id}`);
            tvPowerOff(t).catch(err => log('таймер сна: ' + err.message));
        }, minutes * 60000)
    };
}

/** command sleep {value: минуты, 0 — отменить}. */
async function requestSleep(t, base, value) {
    const minutes = value === '' || value == null ? NaN : Math.round(Number(value));
    if (!isFinite(minutes) || minutes < 0 || minutes > 600) return Object.assign(base, { ok: false, error: 'bad_value', message: tr('assist.sleepBad') });
    const done = n => Object.assign(base, { ok: true, value: n, message: tr('assist.onTv', { text: n > 0 ? tr('assist.sleepSet', { n }) : tr('assist.sleepOff'), tv: t.name }) });
    if (tvOnline[t.tv_id]) {
        setAddonSleep(t, 0);
        const r = await tvCommand(t, 'sleep', minutes);
        if (!r) return Object.assign(base, { ok: false, error: 'timeout', message: tr('assist.timeout') });
        if (!r.ok) return Object.assign(base, { ok: false, error: r.error, message: tr('assist.error', { error: r.error }) });
        return done(r.value);
    }
    if (minutes > 0 && !t.media_player) return Object.assign(base, { ok: false, error: 'no_media_player', message: tr('assist.noMediaPlayer', { tv: t.name }) });
    setAddonSleep(t, minutes);
    return done(minutes);
}

// Команды плеера (js/mqtt-bridge.js handleCommand) и свои: open — включить TV и открыть плеер, power_off — выключить TV
const PLAYER_COMMANDS = ['play', 'pause', 'play_pause', 'stop', 'next', 'prev', 'next_episode', 'prev_episode', 'volume_up', 'volume_down', 'volume', 'mute', 'unmute', 'mute_toggle',
    'from_start', 'live', 'seek', 'seek_to', 'sleep'];

/** action: command — {command, value?, tv?}: пауза, громкость, следующий канал, открыть плеер, выключить TV. */
async function requestCommand(msg) {
    const command = String(msg.command || '').trim().toLowerCase();
    if (command !== 'open' && command !== 'power_off' && !PLAYER_COMMANDS.includes(command)) {
        return { ok: false, error: 'unknown_command', command, message: tr('assist.unknownCommand', { command, list: 'open, power_off, ' + PLAYER_COMMANDS.join(', ') }) };
    }
    const found = await resolveTv(msg.tv);
    if (found.error) return Object.assign(tvError(found, msg.tv), { command });
    const t = found.tv;
    const base = { command, tv_id: t.tv_id, tv_name: t.name };

    if (command === 'open') {
        const ready = await ensurePlayer(t);
        return Object.assign(base, ready.ok ? { ok: true, message: tr('assist.playerOpened', { tv: t.name }) }
            : { ok: false, error: ready.error, message: tr('assist.playerStartFailed', { tv: t.name }) });
    }
    if (command === 'power_off') {
        setAddonSleep(t, 0);
        const off = await tvPowerOff(t);
        if (!off.ok) return Object.assign(base, { ok: false, error: off.error, message: tr('assist.noMediaPlayer', { tv: t.name }) });
        return Object.assign(base, { ok: true, message: tr('assist.powerOff', { tv: t.name }) });
    }
    if (command === 'sleep') return requestSleep(t, base, msg.value);
    if (!tvOnline[t.tv_id]) return Object.assign(base, { ok: false, error: 'player_off', message: tr('assist.playerOff', { tv: t.name }) });
    const value = msg.value === '' || msg.value == null ? undefined : msg.value;
    const r = await tvCommand(t, command, value);
    if (!r) return Object.assign(base, { ok: false, error: 'timeout', message: tr('assist.timeout') });
    if (!r.ok) {
        const channel = (tvState[t.tv_id] || {}).channel || '';
        return Object.assign(base, {
            ok: false, error: r.error, message: r.error === 'bad_value' ? tr('assist.badVolume')
                : r.error === 'tvaudiocontrol_unavailable' ? tr('assist.noVolumeControl')
                    : r.error === 'no_archive' || r.error === 'no_programme' ? archiveErrorText(r.error, channel)
                        : r.error === 'not_archive' ? tr('assist.notArchive') : tr('assist.error', { error: r.error })
        });
    }
    const message = command.startsWith('volume') ? tr('mqtt.volume', { n: r.value })
        : command === 'mute_toggle' ? tr(r.value ? 'mqtt.muted' : 'mqtt.unmuted')
            : I18n.has('assist.cmd.' + command) ? tr('assist.cmd.' + command) : tr('assist.done');
    return Object.assign(base, { ok: true, value: r.value, message: tr('assist.onTv', { text: message, tv: t.name }) });
}

/**
 * iptv/request ← {request_id?, action, query?, fid?, episode_fid?, from_start?, tv?}
 *   action: guide {query?, tv?} — программа канала на сутки вперёд (requestGuide)
 *   action: guide_search {query, channel?, day?} — поиск передач по всем каналам; remind {ref | query, channel?, day?} —
 *           напомнить за 5 минут до начала; reminders — список; remind_cancel {query?} — убрать
 *   action: archive_guide {query: канал, tv} — передачи канала за дни архива (карточка HA);
 *           archive {query: канал, start?, tv} — включить запись с момента start (без start — текущая передача с начала)
 *   action: tonight {day?, from?, to?} — что будет вечером на каналах, которые в доме смотрят (requestTonight);
 *           move {to?, from?, keep?} — продолжить то, что идёт, на другом телевизоре с того же места (requestMove)
 *   action: channel {query, tv?, from_start?} — from_start: включить канал и текущую передачу с начала (из архива)
 *   command: next_episode / prev_episode — соседняя серия текущего сериала; seek N — сдвиг на N секунд;
 *           seek_to N — абсолютная позиция (секунды от начала видео или unix-секунды архива);
 *           from_start — текущая передача с начала; live — из архива в эфир;
 *           sleep N — выключить телевизор через N минут (0 — отменить)
 *   action: vod_search — найти (TV не нужен); vod_play — найти (или fid) и включить на телевизоре; оба ищут по
 *           всем источникам по очереди; quality ('4K', '1080p', 'best'… или словами в query) — в каком качестве;
 *           vod_info {query} — рейтинг (Кинопоиск, TMDB), жанры и описание фильма, TV не нужен;
 *           channel — включить канал по имени; status — что идёт; command {command, value?} — пауза, громкость,
 *           next/prev (канал), next_episode/prev_episode (серия), open (включить TV и плеер), power_off (выключить TV);
 *           favorites — список избранного; favorite {fid, title, …, add?} — добавить/убрать/переключить;
 *           favorite_add {query? | choice? | id?, tv?} — голосом: без названия — фильм, который сейчас идёт на
 *           телевизоре; с названием — поиск по источникам; вариантов несколько — список на экран и error = ambiguous.
 *           favorites_titles — избранное одними названиями (для ассистента: «подбери что-нибудь по моему избранному»);
 *           watchlist_add {text, by?} — «Посмотреть позже»: текст или ссылка с телефона (watchlist.js);
 *           watchlist — список; watchlist_remove {key | query} — убрать;
 *           vod_recommend {titles, tv?} — подборка: из названных фильмов остаются те, что есть у источников и не в
 *           избранном, и уходят на экран телевизора страницей с постерами (iptv/<tv_id>/suggest); выбрать — пультом
 *           или vod_play {choice: N}.
 * → iptv/request/result {request_id, ok, action, ..., error?, message} — message можно прочитать голосом.
 */
async function handleRequest(msg, resultTopic = 'iptv/request/result') {
    const rid = msg.request_id != null ? msg.request_id : 'r' + (++requestSeq);
    const action = String(msg.action || '');
    const reply = obj => mqttPublish(resultTopic, Object.assign({ request_id: rid, action }, obj));
    try {
        if (action === 'vod_search') {
            // голосом список зачитывается вслух: три названия — предел, дальше ассистент должен переспрашивать
            const r = await vod.searchAll(msg.query || '', { limit: msg.limit || VOICE_RESULTS, quality: msg.quality });
            return reply({
                ok: r.results.length > 0, query: r.query, results: r.results, best: r.best, sources: r.tried,
                error: r.results.length ? undefined : 'not_found',
                message: r.results.length ? tr('assist.found', { list: r.results.slice(0, VOICE_RESULTS).map(x => x.title + (x.year ? ' (' + x.year + ')' : '')).join('; ') })
                    : tr('assist.vodNotFound', { query: msg.query })
            });
        }
        // карточка HA открывает защищённые группы — PIN проверяет аддон
        if (action === 'parental_check') {
            const r = parental.check(msg.pin, 'card');
            return reply(Object.assign(r, { message: r.ok ? tr('assist.pinOk') : parentalError(r) }));
        }
        if (action === 'favorites') {
            repairFavoritePosters().catch(() => { /* список доступен и без восстановления постеров */ });
            const items = favorites.list();
            return reply({
                ok: true, items,
                message: items.length
                    ? tr('assist.favorites', { list: items.slice(0, VOICE_RESULTS).map(x => x.title + (x.year ? ' (' + x.year + ')' : '')).join('; ') })
                    : tr('assist.favoritesEmpty')
            });
        }
        if (action === 'favorite') {
            const r = toggleFavorite(msg);
            return reply(Object.assign(r, {
                message: tr(r.favorite ? 'assist.favoriteAdded' : 'assist.favoriteRemoved', { title: msg.title || '' })
            }));
        }
        if (action === 'watchlist_add') return reply(await requestWatchlistAdd(msg));
        if (action === 'watchlist') return reply(requestWatchlist());
        if (action === 'watchlist_remove') return reply(requestWatchlistRemove(msg));
        if (action === 'vod_info') return reply(await requestVodInfo(msg));
        if (action === 'favorite_add') return reply(await requestFavoriteAdd(msg));
        if (action === 'favorites_titles') return reply(requestFavoritesTitles());
        if (action === 'vod_recommend') return reply(await requestRecommend(msg));
        if (action === 'status') return reply(await requestStatus(msg));
        if (action === 'command') return reply(await requestCommand(msg));
        if (action === 'guide') return reply(await requestGuide(msg));
        if (action === 'guide_search') return reply(requestGuideSearch(msg));
        if (action === 'remind') return reply(requestRemind(msg));
        if (action === 'reminders') return reply(requestReminders());
        if (action === 'remind_cancel') return reply(requestRemindCancel(msg));
        if (action === 'archive_guide') return reply(await requestArchiveGuide(msg));
        if (action === 'archive') return reply(await requestArchive(msg));
        if (action === 'tonight') return reply(requestTonight(msg));
        if (action === 'move') return reply(await requestMove(msg));
        if (action !== 'vod_play' && action !== 'channel') return reply({ ok: false, error: 'unknown_action', message: tr('assist.unknownAction') });
        // канал с PIN (карточка HA): телевизору уходит ключ — без него защищённый канал по MQTT не включится (голос — никогда)
        let unlockKey = null;
        if (action === 'channel' && msg.pin != null) {
            const r = parental.check(msg.pin, 'card');
            if (!r.ok) return reply(Object.assign(r, { message: parentalError(r) }));
            unlockKey = parental.key();
        }

        // что включать — сначала, чтобы не будить телевизор ради «не нашёл»
        let item = null;
        let alternatives;
        // «включи … в 4К»: качество отдельным полем или словами в самом запросе (их разбирает поиск)
        let wantQuality = action === 'vod_play' && msg.quality ? parseQuality(msg.quality).quality : null;
        if (action === 'vod_play') {
            // id — составной («portal:48357»); карточка и старые скрипты шлют fid без источника
            let playFid = msg.id != null && msg.id !== '' ? msg.id : msg.fid;
            // «включи второй» — ответ на подборку, которая сейчас на экране
            if (playFid == null && parseInt(msg.choice, 10) > 0) {
                const picked = recPicked(msg.choice);
                if (!picked) return reply({ ok: false, error: 'bad_choice', message: tr('assist.recommendBadChoice') });
                playFid = picked.id;
                if (!String(msg.tv || '').trim() && recOffer.tvs[0]) msg.tv = recOffer.tvs[0];
                if (!msg.title) msg.title = picked.title;
            }
            if (playFid != null) {
                // избранное живёт долго, а идентификаторы источников не вечны: не открылся — ищем по названию
                try {
                    item = await vod.details(playFid);
                } catch (e) {
                    const name = String(msg.query || msg.title || '').trim();
                    if (!name || e.message === 'no_portal') throw e;
                    log(`request: ${playFid} не открылся (${e.message}) — ищу «${name}»`);
                    // ищем в том же источнике: у другого свои идентификаторы и своя озвучка
                    const r = await vod.search(name, { limit: VOICE_RESULTS, src: VodSources.splitId(playFid).type });
                    alternatives = r.results;
                    if (!r.best) {
                        return reply({
                            ok: false, error: 'not_found', query: name, alternatives,
                            message: tr('assist.vodNotFound', { query: name })
                        });
                    }
                    item = r.best;
                }
            } else {
                // голосу всё равно, из какого источника фильм: по очереди, до первого уверенного совпадения
                const r = await vod.searchAll(msg.query || '', { limit: VOICE_RESULTS, quality: msg.quality });
                alternatives = r.results;
                wantQuality = r.quality || wantQuality;
                if (!r.best) {
                    return reply({
                        ok: false, error: 'not_found', query: msg.query, alternatives,
                        message: r.results.length ? tr('assist.vodSimilar', { list: r.results.slice(0, VOICE_RESULTS).map(x => x.title + (x.year ? ' (' + x.year + ')' : '')).join('; ') })
                            : tr('assist.vodNotFound', { query: msg.query })
                    });
                }
                item = r.best;
            }
        } else if (!String(msg.query || '').trim()) {
            return reply({ ok: false, error: 'no_query', message: tr('assist.noQuery') });
        }

        const found = await resolveTv(msg.tv);
        if (found.error) return reply(Object.assign(tvError(found, msg.tv), { title: item ? item.title : undefined }));
        const t = found.tv;
        const ready = await ensurePlayer(t);
        if (!ready.ok) return reply({ ok: false, error: ready.error, tv_id: t.tv_id, tv_name: t.name, message: tr('assist.playerStartFailed', { tv: t.name }) });

        if (action === 'channel') {
            const wait = waitFor(`iptv/${t.tv_id}/set_channel/result`, () => true, 15000);
            mqttPublish(`iptv/${t.tv_id}/set_channel`, unlockKey ? { name: String(msg.query), key: unlockKey } : String(msg.query));
            const r = await wait;
            if (!r) return reply({ ok: false, error: 'timeout', tv_id: t.tv_id, tv_name: t.name, message: tr('assist.timeout') });
            // «включи … с начала»: канал включён — теперь текущую передачу из архива с её начала
            if (r.ok && msg.from_start) {
                const again = await tvCommand(t, 'from_start', undefined, 10000);
                return reply({
                    ok: true, tv_id: t.tv_id, tv_name: t.name, channel: r.channel, from_start: !!(again && again.ok),
                    message: again && again.ok ? tr('assist.channelFromStart', { channel: r.channel, tv: t.name })
                        : tr('assist.channelOn', { channel: r.channel, tv: t.name }) + '. ' + archiveErrorText(again ? again.error : 'timeout', r.channel)
                });
            }
            return reply({
                ok: !!r.ok, tv_id: t.tv_id, tv_name: t.name, channel: r.channel, error: r.error, alternatives: r.alternatives,
                message: r.ok ? tr('assist.channelOn', { channel: r.channel, tv: t.name })
                    : r.error === 'locked' ? tr('assist.channelLocked', { channel: r.channel })
                        : tr('mqtt.channelNotFound', { name: msg.query })
            });
        }

        const playId = rid + ':' + Date.now();
        const wait = waitFor(`iptv/${t.tv_id}/vod/play/result`, m => m && m.request_id === playId, 30000);
        mqttPublish(`iptv/${t.tv_id}/vod/play`, {
            request_id: playId, id: item.id, fid: item.fid, episode_fid: msg.episode_fid != null ? msg.episode_fid : undefined,
            // stream — выбранная озвучка, если у источника их несколько (у портала одна)
            stream: msg.stream != null ? msg.stream : undefined,
            // quality — высота кадра ('2160', '1080'…), 'max' или 'min': телевизор берёт такое или ближайшее
            quality: wantQuality || undefined,
            from_start: !!msg.from_start, title: item.title
        });
        const r = await wait;
        if (!r) return reply({ ok: false, error: 'timeout', tv_id: t.tv_id, tv_name: t.name, id: item.id, fid: item.fid, title: item.title, message: tr('assist.timeout') });
        log(`request: ${action} «${item.title}» (${item.id}) на ${t.tv_id} — ${r.ok ? 'ok' : r.error}`);
        const played = { title: r.title || item.title, tv: t.name };
        const ql = r.ok ? playedQuality(wantQuality, r, item) : {};
        return reply({
            ok: !!r.ok, tv_id: t.tv_id, tv_name: t.name, id: item.id, fid: item.fid, title: played.title, year: item.year,
            kind: item.kind, src: item.src, error: r.error, alternatives,
            quality: ql.quality, quality_wanted: ql.wanted, quality_match: ql.match, qualities: ql.qualities,
            message: !r.ok ? tr('vod.playFailedTitle', { title: item.title, error: r.error })
                : ql.key ? tr(ql.key, Object.assign({ q: ql.quality, wanted: ql.wanted }, played))
                    : tr('assist.vodOn', played)
        });
    } catch (err) {
        log(`request ${action}: ${err.message}`);
        return reply({ ok: false, error: err.message, message: err.message === 'no_portal' ? tr('assist.noPortal') : tr('assist.error', { error: err.message }) });
    }
}

const qualityLabel = q => {
    const n = +(/\d{3,4}/.exec(String(q || '')) || [0])[0];
    return n >= 2160 ? '4K' : n ? n + 'p' : '';
};

/**
 * Что сказать о качестве после «включи … в 4К». wanted — что просили, r — ответ телевизора
 * ({quality — что включил, qualities — что было на выбор}; старый плеер их не присылает).
 * → {} (о качестве не просили или сказать нечего) | {key — фраза, wanted, quality, match, qualities}
 */
function playedQuality(wanted, r, item) {
    if (!wanted || r.quality === undefined) return {};
    const qualities = (r.qualities || []).map(qualityLabel).filter(Boolean);
    const edge = wanted === 'max' || wanted === 'min';
    const want = edge ? '' : qualityLabel(wanted);
    const got = qualityLabel(r.quality);
    if (!got) {
        // выбирать не из чего: одна ссылка. У портала 4K — отдельная запись, её нашёл ещё поиск
        const match = edge || (wanted === '2160' && /4K/.test(item.quality || ''));
        return { key: match ? null : 'assist.vodOnNoQuality', wanted: want, quality: null, match, qualities };
    }
    const match = edge || got === want;
    return {
        key: match ? 'assist.vodOnQuality' : qualities.length > 1 ? 'assist.vodOnNearest' : 'assist.vodOnOnly',
        wanted: want, quality: got, match, qualities
    };
}

// ───────── «Посмотреть позже» (watchlist.js) ─────────

/** Как источник называется у пользователя: имя его плейлиста («Кино и сериалы»), иначе тип. */
function sourceName(type) {
    return (playlistIndex.find(p => p.kind === 'vod' && (VodSources.parseUrl(p.url) || {}).type === type) || {}).name || type;
}

/** Запись для телевизора и для ответа: source — имя источника, где фильм нашёлся. */
function watchPublic(item) {
    return Object.assign({}, item, { source: item.found ? sourceName(item.found.src) : null });
}

/** watchlist_add {text, by?} — прислали с телефона (webhook HA) или сказали голосом. */
async function requestWatchlistAdd(msg) {
    const text = String(msg.text || msg.query || '').trim();
    const r = await watchlist.add(text, { by: msg.by });
    if (!r.ok) return { ok: false, error: r.error, text, message: tr('assist.watchNoTitle', { text: text.slice(0, 80) }) };
    syncFavoritePosterPins();
    const it = watchPublic(r.item);
    const name = it.title + (it.year ? ' (' + it.year + ')' : '');
    const key = r.already ? 'assist.watchAlready' : it.found ? 'assist.watchAddedFound' : 'assist.watchAddedMissing';
    return {
        ok: true, already: r.already, item: it, title: it.title, year: it.year, kp_rating: it.kpRating,
        available: !!it.found, source: it.source,
        message: tr(key, { title: name, source: it.source || '' }) + (it.kpRating ? ' ★ ' + it.kpRating.toFixed(1) : '')
    };
}

function requestWatchlist() {
    const items = watchlist.list().map(watchPublic);
    return {
        ok: true, items,
        message: items.length
            ? tr('assist.watchList', { n: items.length, list: items.slice(0, VOICE_RESULTS).map(x => x.title + (x.year ? ' (' + x.year + ')' : '')).join('; ') })
            : tr('assist.watchEmpty')
    };
}

/** watchlist_remove {key} — с телевизора; {query} — голосом, по названию. */
function requestWatchlistRemove(msg) {
    let key = msg.key;
    if (!key && msg.query) {
        const qa = ChannelMatch.analyze(String(msg.query), false);
        let best = null;
        watchlist.list().forEach(i => {
            const sc = ChannelMatch.score(qa, ChannelMatch.analyze(i.title, false));
            if (!best || sc > best.sc) best = { i, sc };
        });
        if (best && best.sc >= vod.MIN_SCORE) key = best.i.key;
    }
    const prev = key ? watchlist.remove(key) : null;
    if (!prev) return { ok: false, error: 'not_found', message: tr('assist.watchNotFound', { title: msg.query || '' }) };
    syncFavoritePosterPins();
    return { ok: true, key: prev.key, title: prev.title, items: watchlist.list().map(watchPublic), message: tr('assist.watchRemoved', { title: prev.title }) };
}

// ───────── «добавь в избранное» голосом ─────────

const FAV_OFFER_MS = 10 * 60 * 1000;   // сколько помним предложенные варианты («второй» — ответ на вопрос)
const FAV_CLOSE = 0.08;                // насколько похожими должны быть названия, чтобы переспросить
const FAV_SURE = 0.85;                 // ниже — название совпало лишь частично: тоже переспрашиваем
const FAV_OPTIONS = 5;                 // вариантов на экране; вслух называются первые VOICE_RESULTS
let favOffer = null;                   // {at, options: [{n, id, title, year, kind}], tvs: [tv_id]}

const favName = x => x.title + (x.year ? ' (' + x.year + ')' : '');

/** Телевизоры, которым показать список: названный (или единственный с плеером), иначе все с запущенным плеером. */
async function favScreens(tvQuery) {
    const found = await resolveTv(tvQuery);
    if (found.tv) return tvOnline[found.tv.tv_id] ? [found.tv.tv_id] : [];
    return Object.values(tvs).filter(t => tvOnline[t.tv_id]).map(t => t.tv_id);
}

function favDone(item, screens) {
    const already = favorites.has(item.id);
    const r = toggleFavorite(Object.assign({}, item, { add: true }));
    const message = tr(already ? 'assist.favoriteAlready' : 'assist.favoriteAdded', { title: favName(item) });
    // плашка с вопросом ещё на экране — меняем её на ответ
    (screens || []).forEach(id => mqttPublish(`iptv/${id}/notify`, { kind: 'favorite', text: message, seconds: 6 }));
    favOffer = null;
    return { ok: true, id: r.id, title: item.title, year: item.year || null, kind: item.kind, already, favorite: true, message };
}

/**
 * favorite_add: {query} — найти по названию во всех источниках; {choice: N} или {id} — ответ на вопрос
 * «какой добавить»; пусто — фильм, который сейчас идёт на телевизоре (tv — на каком, если их несколько).
 */
async function requestFavoriteAdd(msg) {
    const offer = favOffer && Date.now() - favOffer.at < FAV_OFFER_MS ? favOffer : null;
    const query = String(msg.query || '').trim();
    const choice = parseInt(msg.choice, 10);
    const hasId = msg.id != null && msg.id !== '';

    if (choice > 0 || hasId) {
        const picked = offer && offer.options.find(o => choice > 0 ? o.n === choice : String(o.id) === String(msg.id));
        if (picked) return favDone(picked, offer.tvs);
        if (!hasId) return { ok: false, error: 'bad_choice', message: tr('assist.favoriteBadChoice') };
        const d = await vod.details(msg.id);
        return favDone({ id: d.id, title: d.title, year: d.year, kind: d.kind, poster: d.poster, quality: d.quality });
    }

    if (!query) {
        // «добавь это в избранное»: что идёт на телевизоре; сериал — сам сериал, а не серия (vod_fav от плеера)
        const playing = t => { const s = tvState[t.tv_id]; return tvOnline[t.tv_id] && s && s.vod_title ? s : null; };
        let list = Object.values(tvs).filter(playing);
        if (String(msg.tv || '').trim()) {
            const found = await resolveTv(msg.tv);
            if (found.error) return tvError(found, msg.tv);
            list = list.filter(t => t.tv_id === found.tv.tv_id);
        }
        if (!list.length) return { ok: false, error: 'no_movie', message: tr('assist.favoriteNoMovie') };
        if (list.length > 1) return tvError({ error: 'ambiguous_tv', tvs: list.map(t => ({ tv_id: t.tv_id, name: t.name, area: '' })) }, msg.tv);
        const s = playing(list[0]);
        const f = s.vod_fav || { id: s.vod_id, title: s.vod_title };
        if (!f.id) return { ok: false, error: 'no_movie', message: tr('assist.favoriteNoMovie') };
        return favDone(f, [list[0].tv_id]);
    }

    const r = await vod.searchAll(query, { limit: FAV_OPTIONS });
    const pool = r.all || r.results;
    if (!pool.length) return { ok: false, error: 'not_found', query, message: tr('assist.vodNotFound', { query }) };
    // 4K и HDR того же фильма — не отдельные варианты: остаётся первая запись (обычная)
    const seen = new Set();
    const uniq = pool.filter(x => { const k = [x.src, cleanTitle(x.title).toLowerCase(), x.year || ''].join('|'); return !seen.has(k) && seen.add(k); });
    // добавляем молча, только когда название совпало почти дословно и спутать не с чем; иначе спрашиваем
    const close = uniq.filter(x => x.score >= uniq[0].score - FAV_CLOSE);
    if (r.best && close.length === 1 && close[0].score >= FAV_SURE) return favDone(close[0]);
    const options = r.best && close.length > 1 ? close : uniq;
    // один и тот же фильм бывает в двух источниках — тогда рядом с названием пишем, откуда он
    const mixed = new Set(options.map(x => x.src)).size > 1;
    const srcName = type => (playlistIndex.find(p => p.kind === 'vod' && (VodSources.parseUrl(p.url) || {}).type === type) || {}).name || type;
    const favLabel = x => favName(x) + (mixed ? ' — ' + srcName(x.src) : '');

    const screens = await favScreens(msg.tv);
    favOffer = { at: Date.now(), tvs: screens, options: options.map((x, i) => Object.assign({ n: i + 1 }, x)) };
    const lines = favOffer.options.map(o => o.n + '. ' + favLabel(o));
    screens.forEach(id => mqttPublish(`iptv/${id}/notify`, {
        // options и request — чтобы выбрать можно было и пультом: телевизор ответит favorite_add {choice}
        kind: 'favorite', text: tr('assist.favoriteWhichScreen'), seconds: 60,
        options: favOffer.options.map(o => ({ n: o.n, label: favLabel(o) })), request: { action: 'favorite_add' }
    }));
    return {
        ok: false, error: 'ambiguous', query, on_screen: screens.length > 0,
        options: favOffer.options.map(o => ({ choice: o.n, id: o.id, title: o.title, year: o.year, kind: o.kind, source: o.src })),
        message: tr('assist.favoriteWhich', { list: lines.slice(0, VOICE_RESULTS).join('; ') })
    };
}

// ───────── «подбери фильм по моему избранному» ─────────

const REC_OFFER_MS = 30 * 60 * 1000;   // сколько помним подборку («включи второй»)
const REC_TITLES = 20;                 // столько названий от ассистента проверяем
const REC_ON_SCREEN = 20;              // на экран уходит всё, что нашлось: страница прокручивается рядами по шесть
const REC_SCORE = 0.75;                // название у источника должно совпасть уверенно: предлагаем именно этот фильм
const FAV_TITLES = 80;                 // столько избранного отдаём ассистенту (новые первыми)
let recOffer = null;                   // {at, tvs: [tv_id], options: [{n, id, title, …}]}

/** Вариант N из подборки, пока она свежая. */
function recPicked(choice) {
    const n = parseInt(choice, 10);
    return recOffer && Date.now() - recOffer.at < REC_OFFER_MS ? recOffer.options.find(o => o.n === n) || null : null;
}

const recName = x => cleanTitle(String(x.title || '')).toLowerCase().replace(/ё/g, 'е');
const recKey = x => recName(x) + '|' + (x.year || '');
/** Тот же фильм? Год есть не у всех записей: без года сравнивается одно название. */
const recSame = (a, b) => recName(a) === recName(b) && (!a.year || !b.year || Number(a.year) === Number(b.year));

// ───────── что уже смотрели: в подборку не попадает ─────────
// Историю просмотра телевизор держит у себя, поэтому аддон ведёт свою — по состоянию плеера (iptv/<tv_id>/state):
// фильм или сериал, который не выключили за WATCHED_AFTER_MS, считается просмотренным. Файл — /data/watched.json.

const WATCHED_FILE = path.join(DATA_DIR, 'watched.json');
const WATCHED_AFTER_MS = 10 * 60 * 1000;   // включили и сразу бросили — не «посмотрел»
const WATCHED_MAX = 1000;
let watched = [];                          // [{id, title, year, kind, at}] — новые первыми
const watching = {};                       // tv_id → {id, timer}
try { watched = JSON.parse(fs.readFileSync(WATCHED_FILE, 'utf8')).items || []; } catch (e) { /* файла ещё нет */ }

function markWatched(item) {
    if (!item || !item.id || !item.title) return;
    watched = watched.filter(w => String(w.id) !== String(item.id));
    watched.unshift({ id: String(item.id), title: item.title, year: item.year || null, kind: item.kind || 'movie', at: Date.now() });
    watched = watched.slice(0, WATCHED_MAX);
    try { fs.writeFileSync(WATCHED_FILE, JSON.stringify({ items: watched })); } catch (e) { log('watched.json: ' + e.message); }
    log(`просмотрено: «${item.title}» (${item.id})`);
}

/** Что сейчас идёт на телевизоре: у серии — сам сериал (vod_fav от плеера). */
function nowWatching(tvId) {
    const st = tvState[tvId];
    if (!st || !st.vod_title) return null;
    const f = st.vod_fav || { id: st.vod_id, title: st.vod_title };
    return f.id ? f : null;
}

function trackWatched(tvId) {
    const now = nowWatching(tvId);
    const cur = watching[tvId];
    if (cur && now && String(cur.id) === String(now.id)) return;
    if (cur) clearTimeout(cur.timer);
    delete watching[tvId];
    if (!now) return;
    watching[tvId] = {
        id: now.id,
        timer: setTimeout(() => {
            delete watching[tvId];
            const still = nowWatching(tvId);
            if (still && String(still.id) === String(now.id)) markWatched(still);
        }, WATCHED_AFTER_MS)
    };
}

const isWatched = x => watched.some(w => String(w.id) === String(x.id) || recSame(w, x));

// что показывали в подборках недавно — чтобы на «ещё варианты» не предлагать то же самое
const REC_SHOWN_MS = 6 * 60 * 60 * 1000;
let recShown = [];                         // [{title, year, at}]
const recentlyShown = () => (recShown = recShown.filter(x => Date.now() - x.at < REC_SHOWN_MS));

/**
 * favorites_titles — избранное названиями: по нему ассистент сам придумывает, что предложить.
 * watched — что уже смотрели (в подборку не попадёт), suggested_recently — что недавно предлагали.
 */
function requestFavoritesTitles() {
    const items = favorites.list();
    const titles = items.slice(0, FAV_TITLES).map(favName);
    return {
        ok: true, count: items.length, titles,
        watched: watched.slice(0, FAV_TITLES).map(favName),
        suggested_recently: recentlyShown().map(favName),
        message: items.length ? tr('assist.favoritesAll', { list: titles.join('; ') }) : tr('assist.favoritesEmpty')
    };
}

/** Один предложенный фильм: есть ли он у источников (уверенное совпадение) и что о нём знают каталоги. */
async function recLookup(title) {
    let found = null;
    try {
        found = (await vod.searchAll(title, { limit: 1 })).best;
    } catch (e) {
        if (e.message === 'no_portal') throw e;
    }
    if (!found || found.score < REC_SCORE) return null;
    // ассистент называет фильм с годом: одноимённый фильм другого года («Помни» 2000 и 2012) — не тот
    const want = (String(title).match(/\b(19|20)\d\d\b/) || [])[0];
    if (want && found.year && Math.abs(found.year - Number(want)) > 1) return null;
    const m = await vod.meta({ title: found.title, year: found.year, kind: found.kind }).catch(() => ({}));
    return {
        id: found.id, fid: found.fid, src: found.src, kind: found.kind, quality: found.quality || '',
        title: found.title, year: found.year || m.metaYear || null, poster: !!found.poster,
        kpRating: m.kpRating || null, rating: m.rating || null, genres: (m.genres || []).slice(0, 3),
        description: m.description || ''
    };
}

/**
 * vod_recommend {titles: [..] | "название; название", tv?} — подборка от ассистента. Что предложить, решает он
 * (по избранному из favorites_titles); здесь из названного остаётся то, что реально можно включить и чего ещё
 * нет в избранном, и уходит на экран: iptv/<tv_id>/suggest {title, seconds, items: [{n, id, title, year, kind,
 * poster, kpRating, rating, genres, description}]}. Телевизор не найден или не один — список только голосом.
 * Просмотренное (watched) не попадает никогда; more: true («ещё варианты») — не попадает и то, что уже
 * показывали за последние часы.
 */
async function requestRecommend(msg) {
    const raw = Array.isArray(msg.titles) ? msg.titles : String(msg.titles || msg.query || '').split(/[;\n|]+/);
    const seenTitle = new Set();
    const titles = raw.map(t => String(t || '').replace(/^\s*\d+[.)]\s*/, '').trim())
        .filter(t => t && !seenTitle.has(t.toLowerCase()) && seenTitle.add(t.toLowerCase())).slice(0, REC_TITLES);
    if (!titles.length) return { ok: false, error: 'no_titles', message: tr('assist.recommendNoTitles') };

    const favIds = new Set(favorites.list().map(f => String(f.id)));
    // в избранном год есть не у всех записей: без года сравниваем по одному названию
    const favs = favorites.list().map(f => ({ name: recName(f), year: f.year || null }));
    const inFavorites = x => favIds.has(String(x.id)) ||
        favs.some(f => f.name === recName(x) && (!f.year || !x.year || f.year === x.year));
    const more = msg.more === true || /^(true|1|yes|да)$/i.test(String(msg.more || '').trim());
    const shownBefore = more ? recentlyShown() : [];
    const options = [];
    const missing = [];
    const skipped = [];                // есть у источников, но уже смотрели или уже предлагали
    const have = new Set();
    // по три разом: ждать четырнадцать названий подряд долго, а все сразу — лишняя нагрузка на источники
    for (let i = 0; i < titles.length && options.length < REC_ON_SCREEN; i += 3) {
        const part = await Promise.all(titles.slice(i, i + 3).map(t => recLookup(t).catch(e => {
            if (e.message === 'no_portal') throw e;
            return null;
        })));
        part.forEach((x, k) => {
            if (!x) return missing.push(titles[i + k]);
            if (inFavorites(x) || have.has(recKey(x))) return;
            if (isWatched(x) || shownBefore.some(o => recSame(o, x))) return skipped.push(favName(x));
            have.add(recKey(x));
            if (options.length < REC_ON_SCREEN) options.push(x);
        });
    }
    if (!options.length) {
        return {
            ok: false, error: 'none_available', not_available: missing, already_seen_or_suggested: skipped,
            message: tr(skipped.length ? 'assist.recommendNoneNew' : 'assist.recommendNone')
        };
    }
    options.forEach((o, i) => { o.n = i + 1; });
    if (!more) recShown = [];          // новая просьба — новый отсчёт; «ещё» копит показанное
    options.forEach(o => recShown.push({ title: o.title, year: o.year, at: Date.now() }));

    // куда показать: названный телевизор, единственный или единственный включённый; иначе — только голосом
    const found = await resolveTv(msg.tv);
    let shown = null;
    if (found.tv) {
        const ready = await ensurePlayer(found.tv);
        if (ready.ok) {
            shown = found.tv;
            mqttPublish(`iptv/${shown.tv_id}/suggest`, {
                title: tr('assist.recommendScreen'), seconds: 180,
                items: options.map(o => ({
                    n: o.n, id: o.id, title: o.title, year: o.year, kind: o.kind, quality: o.quality, poster: o.poster,
                    kpRating: o.kpRating, rating: o.rating, genres: o.genres, description: o.description
                }))
            });
        }
    }
    recOffer = { at: Date.now(), tvs: shown ? [shown.tv_id] : [], options };
    log(`request: vod_recommend${more ? ' (ещё)' : ''} — ${options.length} из ${titles.length}` + (shown ? ` на ${shown.tv_id}` : ', без экрана'));
    const list = options.slice(0, VOICE_RESULTS).map(o => o.n + '. ' + favName(o)).join('; ');
    return {
        ok: true, on_screen: !!shown, tv_id: shown ? shown.tv_id : undefined, tv_name: shown ? shown.name : undefined,
        tv_error: found.error || undefined, tvs: found.error ? found.tvs : undefined,
        options: options.map(o => ({
            choice: o.n, id: o.id, title: o.title, year: o.year, kind: o.kind,
            kinopoisk_rating: o.kpRating, tmdb_rating: o.rating, genres: o.genres
        })),
        not_available: missing, already_seen_or_suggested: skipped,
        message: shown ? tr('assist.recommendShown', { tv: shown.name, list }) : tr('assist.recommendList', { list })
    };
}

/** vod_info {query} — рейтинг и описание фильма: Кинопоиск и TMDB, телевизор не нужен. */
async function requestVodInfo(msg) {
    const query = String(msg.query || '').trim();
    if (!query) return { ok: false, error: 'no_query', message: tr('assist.noQuery') };
    if (!kp.enabled() && !tmdb.enabled()) return { ok: false, error: 'no_ratings', message: tr('assist.vodInfoOff') };
    const i = await vod.info(query);
    if (!i) return { ok: false, error: 'not_found', query, message: tr('assist.vodInfoNotFound', { query }) };
    const name = i.title + (i.year ? ' (' + i.year + ')' : '');
    const ratings = [i.kpRating ? tr('assist.vodInfoKp', { n: i.kpRating }) : '', i.rating ? tr('assist.vodInfoTmdb', { n: i.rating }) : '']
        .filter(Boolean).join(', ');
    return {
        ok: true, query, title: i.title, year: i.year, kind: i.kind,
        kinopoisk_rating: i.kpRating, kinopoisk_votes: i.kpVotes, tmdb_rating: i.rating, tmdb_votes: i.votes,
        genres: i.genres, description: i.description, available: i.available, id: i.id || undefined,
        message: [
            ratings ? tr('assist.vodInfoRated', { title: name, ratings }) : tr('assist.vodInfoNoRating', { title: name }),
            i.genres.length ? i.genres.slice(0, 3).join(', ') : '',
            i.description
        ].filter(Boolean).join('. ')
    };
}

/**
 * iptv/vod/search ← {request_id, query, limit, src?} | текст;
 * iptv/vod/details ← {request_id, id|fid} — для карточки HA (id составной, fid — старый вид).
 */
async function handleVodTopic(kind, text) {
    let msg;
    try { msg = JSON.parse(text); } catch (e) { msg = kind === 'search' ? { query: text } : { fid: text }; }
    if (!msg || typeof msg !== 'object') msg = kind === 'search' ? { query: String(msg) } : { fid: msg };
    const topic = `iptv/vod/${kind}/result`;
    try {
        const body = kind === 'search'
            ? await vod.search(msg.query || '', { limit: msg.limit || 24, src: msg.src || undefined })
            : { item: await vod.details(msg.id != null && msg.id !== '' ? msg.id : msg.fid) };
        mqttPublish(topic, Object.assign({ request_id: msg.request_id, ok: true }, body));
    } catch (err) {
        mqttPublish(topic, { request_id: msg.request_id, ok: false, error: err.message });
    }
}

// ───────────────────────── HTTP ─────────────────────────

function send(res, code, body, headers = {}) {
    res.writeHead(code, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache', ...headers });
    res.end(body);
}

function sendJson(res, code, obj) {
    send(res, code, JSON.stringify(obj, null, 2), { 'Content-Type': 'application/json; charset=utf-8' });
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', c => { size += c.length; if (size > 65536) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function clientIp(req) {
    return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Тексты окна сопоставления (web/mapping.js) на языке аддона: ключи map.* и нужные общие. */
function mappingTexts() {
    const out = {};
    const en = requireShared('lang/en.js');
    Object.keys(en).filter(k => k.startsWith('map.') || k === 'common.loading').forEach(k => { out[k] = tr(k); });
    return out;
}

/** Страница аддона (кнопка «Открыть веб-интерфейс» / панель HA): какие TV есть, их топики, плейлисты.
 *  Ссылки относительные — страница открывается и напрямую на :8765, и через ingress HA. */
/** Ошибка установки или настройки плагина (plugins.js) → текст для страницы. */
function pluginError(e) {
    const [code, field] = String(e || '').split(':');
    const k = { no_register: 'page.plErrNoRegister', many_types: 'page.plErrManyTypes', bad_type: 'page.plErrBadType',
        too_large: 'page.plErrTooLarge', bad_url: 'page.plErrBadUrl', required: 'page.plErrRequired', bad_value: 'page.plErrBadValue' }[code];
    return k ? tr(k, { field: field || '' }) : String(e || '');
}

async function renderPage({ ingress, parentalNote, pluginNote } = {}) {
    await pluginsReady;
    const list = Object.values(tvs).map(tvPublic);
    const lockAttr = ingress ? '' : ` disabled title="${esc(tr('page.onlyViaPanel'))}"`;
    const ents = list.length ? await haEntities() : null;
    // выпадающий список сущностей HA; без API (запуск на ПК) — обычное поле
    const entityField = (name, domain, value, hint) => {
        if (!ents) return `<input name="${name}" value="${esc(value)}" placeholder="${domain}.…">`;
        const opts = ents[domain].map(e => `<option value="${esc(e.id)}"${e.id === value ? ' selected' : ''}>${esc(e.name)} — ${esc(e.id)}</option>`);
        if (value && !ents[domain].some(e => e.id === value)) opts.unshift(`<option value="${esc(value)}" selected>${esc(value)} (${esc(tr('page.notInHa'))})</option>`);
        return `<select name="${name}"><option value="">— ${hint} —</option>${opts.join('')}</select>`;
    };
    const waiting = pairing.list();
    const pairHtml = `
      <section class="tv" id="pairing">
        <p class="muted">${esc(tr('page.pairHint'))}</p>
        ${waiting.length ? waiting.map(p => `
          <form method="post" action="pairing/${p.id}/accept">
            <span><b class="code">${esc(p.code.replace(/(\d{3})(\d{3})/, '$1 $2'))}</b> ${esc(p.model || '')} · ${esc(p.ip)}</span>
            <button>${esc(tr('page.pairAccept'))}</button>
            <button class="secondary" formaction="pairing/${p.id}/reject">${esc(tr('page.pairReject'))}</button>
          </form>`).join('') : `<p>${esc(tr('page.pairNone'))}</p>`}
      </section>`;
    const accessHtml = t => `
        <form method="post" action="tvs/${encodeURIComponent(t.tv_id)}/revoke" onsubmit="return confirm(${esc(JSON.stringify(tr('page.revokeConfirm', { name: t.name })))})">
          <span class="badge ${t.paired || t.legacy ? 'on' : 'off'}">${esc(tr(t.paired ? 'page.accessPaired' : t.legacy ? 'page.accessLegacy' : 'page.accessNone'))}</span>
          ${t.paired || t.legacy ? `<button class="small secondary">${esc(tr('page.revoke'))}</button>` : ''}
          <button class="small secondary" formaction="tvs/${encodeURIComponent(t.tv_id)}/legacy" name="on" value="${t.legacy ? '0' : '1'}">${esc(tr(t.legacy ? 'page.legacyOff' : 'page.legacyOn'))}</button>
        </form>`;
    const tvHtml = list.length ? list.map(t => `
      <section class="tv">
        <h2>${esc(t.name)} <code>${esc(t.tv_id)}</code>
          <span class="badge ${t.online ? 'on' : 'off'}">${esc(tr(t.online ? 'page.online' : 'page.offline'))}</span></h2>
        <p class="muted">${esc(t.model)} · ${esc(t.ip)} · ${esc(tr('page.lastSeen', { time: whenLabel(t.lastSeen || t.registeredAt) }))}</p>
        ${accessHtml(t)}
        <form method="post" action="tvs/${encodeURIComponent(t.tv_id)}">
          <label>${esc(tr('page.tvName'))}<input name="name" value="${esc(t.name)}"></label>
          <label>${esc(tr('page.remote'))}${entityField('remote_entity', 'remote', t.remote_entity, tr('page.notSelected'))}</label>
          <label>${esc(tr('page.mediaPlayer'))}${entityField('media_player', 'media_player', t.media_player, tr('page.notSelected'))}</label>
          <label>${esc(tr('page.adultMode'))}<select name="adult_mode"${lockAttr}>
            <option value="lock"${t.adult_mode !== 'hide' ? ' selected' : ''}>${esc(tr('page.adultLock'))}</option>
            <option value="hide"${t.adult_mode === 'hide' ? ' selected' : ''}>${esc(tr('page.adultHide'))}</option></select></label>
          <button>${esc(tr('settings.save'))}</button>
        </form>
        <p class="muted">${esc(tr('page.areaHint', { name: 'IPTV ' + t.name }))}</p>
        <details><summary>${esc(tr('page.cardTitle'))}</summary>
          <p>${esc(tr('page.cardHow'))}</p>
          <pre>type: custom:tizen-iptv-card
tv_id: ${esc(t.tv_id)}</pre></details>
        <details><summary>${esc(tr('page.topicsTitle'))}</summary><table>${Object.entries(t.topics).map(([k, v]) =>
            `<tr><td>${esc(k)}</td><td><code>${esc(v)}</code></td></tr>`).join('')}</table>
          <p>${esc(tr('page.entities'))} <code>sensor.iptv_${esc(t.tv_id)}_playback</code>, <code>select.iptv_${esc(t.tv_id)}_playlist</code>…</p></details>
        <form method="post" action="tvs/${encodeURIComponent(t.tv_id)}/delete" onsubmit="return confirm(${esc(JSON.stringify(tr('page.deleteConfirm', { name: t.name })))})">
          <button class="danger">${esc(tr('page.deleteTv'))}</button></form>
      </section>`).join('') : `<p>${esc(tr('page.noTvs'))}</p>`;
    const plHtml = playlistIndex.map(p => {
        const s = (status.playlists || []).find(x => x.id === p.id) || {};
        const info = p.kind === 'vod' ? tr('page.portal')
            : s.lastError ? tr('page.buildError', { error: s.lastError.message })
                : s.lastSuccess ? tr('page.built', { matched: s.matchedChannels, total: s.playlistChannels, time: whenLabel(s.lastSuccess) }) : tr('page.notBuilt');
        const btn = p.kind === 'tv' ? `<button class="small" onclick="IptvMapping.open(${p.id})">+ ${esc(tr('page.mapChannel'))}</button>` : '';
        return `<tr><td>${p.id}</td><td>${esc(p.name)}</td><td>${esc(tr(p.kind === 'vod' ? 'playlists.kindVod' : 'playlists.kindTv'))}</td><td>${esc(info)}</td><td>${btn}</td></tr>`;
    }).join('');
    // родительский контроль: PIN не показывается никогда (хранится только хеш), забыли — задают новый здесь
    const groupsAll = allGroups();
    const protectedGroups = parental.groups(groupsAll);
    const groupNames = [...new Set(groupsAll.concat(protectedGroups))];
    const parentalHtml = `
      <section class="tv" id="parental">
        ${parentalNote ? `<p class="note">${esc(parentalNote)}</p>` : ''}
        <p class="muted">${parental.enabled()
            ? `<span class="badge on">${esc(tr('page.parentalOn'))}</span> ${esc(tr('page.parentalOnText'))}`
            : `<span class="badge off">${esc(tr('page.parentalOff'))}</span> ${esc(tr('page.parentalOffText'))}`}</p>
        ${ingress ? '' : `<p class="note">${esc(tr('page.directReadOnly'))}</p>`}
        <form method="post" action="parental/pin" autocomplete="off">
          <label>${esc(tr(parental.enabled() ? 'page.newPin' : 'page.pin'))}<input name="pin" type="password" inputmode="numeric" pattern="\\d{4}" maxlength="4" required${lockAttr}></label>
          <label>${esc(tr('page.pinRepeat'))}<input name="pin2" type="password" inputmode="numeric" pattern="\\d{4}" maxlength="4" required${lockAttr}></label>
          <label class="chk"><input type="checkbox" onclick="this.form.pin.type=this.form.pin2.type=this.checked?'text':'password'"${lockAttr}> ${esc(tr('page.show'))}</label>
          <button${lockAttr}>${esc(tr('page.savePin'))}</button>
        </form>
        <p class="muted">${esc(tr('page.forgotPin'))}</p>
        <form method="post" action="parental/groups">
          <div class="groups">${groupNames.map(g => `<label class="chk"><input type="checkbox" name="group" value="${esc(g)}"${protectedGroups.includes(g) ? ' checked' : ''}${lockAttr}> ${esc(g)}</label>`).join('') || `<span class="muted">${esc(tr('page.noGroups'))}</span>`}</div>
          <button${lockAttr}>${esc(tr('page.saveGroups'))}</button>
          ${parental.groupsChosen() ? '' : `<span class="muted">${esc(tr('page.defaultGroups'))}</span>`}
        </form>
        ${parental.enabled() ? `<form method="post" action="parental/off" onsubmit="return confirm(${esc(JSON.stringify(tr('page.parentalOffConfirm')))})"><button class="danger"${lockAttr}>${esc(tr('page.parentalOffBtn'))}</button></form>` : ''}
      </section>`;
    const pluginRows = plugins.report().map(p => {
        const name = (p.meta && p.meta.name) || p.type;
        const state = p.error ? ['off', tr('page.plStateErr')] : p.enabled ? ['on', tr('page.plStateOn')] : ['off', tr('page.plStateOff')];
        const info = [p.meta.version ? 'v' + p.meta.version : '', p.meta.author || '',
            p.origin === 'legacy' ? tr('page.plOriginLegacy') : p.origin === 'builtin' ? tr('page.plOriginBuiltin') : '',
            p.sha256 ? 'sha256 ' + p.sha256.slice(0, 16) + '…' : ''].filter(Boolean).join(' · ');
        const home = /^https?:\/\//.test(p.meta.homepage || '') ? ` · <a href="${esc(p.meta.homepage)}" target="_blank" rel="noopener">${esc(p.meta.homepage)}</a>` : '';
        const fields = p.fields.map(f => `<label>${esc(f.label)}${f.required ? ' *' : ''}<input name="s_${esc(f.key)}" type="${f.type}" value="${esc(f.value)}"${f.type === 'password' && f.isSet ? ` placeholder="${esc(tr('page.plSecretSet'))}"` : ''} autocomplete="off"></label>`).join('');
        return `
      <section class="tv">
        <h2>${esc(name)} <code>${esc(p.type)}</code> <span class="badge ${state[0]}">${esc(state[1])}</span></h2>
        <p class="muted">${esc(info)}${home}</p>
        ${p.error ? `<p class="note">${esc(p.error)}</p>` : ''}
        <form method="post" action="plugins/${encodeURIComponent(p.type)}" autocomplete="off">
          <label>${esc(tr('page.plName'))}<input name="name" value="${esc(p.name)}" placeholder="${esc(name)}"></label>
          ${fields}
          <label class="chk"><input type="checkbox" name="enabled" value="1"${p.enabled ? ' checked' : ''}> ${esc(tr('page.plEnabled'))}</label>
          <label class="chk"><input type="checkbox" name="offline" value="1"${p.offline ? ' checked' : ''} onchange="if(this.checked&&!confirm(${esc(JSON.stringify(tr('page.plOfflineWarn')))}))this.checked=false"> ${esc(tr('page.plOffline'))}</label>
          <button>${esc(tr('settings.save'))}</button>
        </form>
        ${p.origin !== 'builtin' ? `<form method="post" action="plugins/${encodeURIComponent(p.type)}/delete" onsubmit="return confirm(${esc(JSON.stringify(tr('page.plDeleteConfirm', { name })))})"><button class="danger">${esc(tr('page.plDelete'))}</button></form>` : ''}
      </section>`;
    }).join('');
    const pluginTexts = { installed: tr('page.plInstalled'), ready: tr('page.plInstalledReady'), updated: tr('page.plUpdated'), loading: tr('common.loading') };
    const pluginsHtml = `
      <section class="tv" id="plugin-install">
        ${pluginNote ? `<p class="note">${esc(pluginNote)}</p>` : ''}
        <p class="muted">${esc(tr('page.plHint'))}</p>
        <form id="pl-install" onsubmit="return false">
          <label>${esc(tr('page.plUrl'))}<input name="url" type="url" placeholder="https://…/plugin.js"></label>
          <button id="pl-url-btn">${esc(tr('page.plInstallUrl'))}</button>
          <label>${esc(tr('page.plFile'))}<input id="pl-file" type="file" accept=".js,text/javascript"></label>
        </form>
        <p class="muted" id="pl-msg"></p>
      </section>
      ${pluginRows || `<p>${esc(tr('page.plNone'))}</p>`}
<script>(function () {
  var T = ${JSON.stringify(pluginTexts).replace(/</g, '\\u003c')};
  var msg = document.getElementById('pl-msg');
  function install(body) {
    msg.textContent = T.loading;
    fetch('plugins/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (!r.ok) { msg.textContent = r.message || r.error; return; }
        location.href = './?pnote=' + encodeURIComponent((r.updated ? T.updated : r.ready ? T.ready : T.installed).replace('{name}', (r.meta && r.meta.name) || r.type)) + '#plugins';
      }, function (e) { msg.textContent = String(e); });
  }
  document.getElementById('pl-url-btn').onclick = function () {
    var u = document.querySelector('#pl-install [name=url]').value.trim();
    if (u) install({ url: u });
  };
  document.getElementById('pl-file').onchange = function () {
    var f = this.files && this.files[0];
    if (!f) return;
    var rd = new FileReader();
    rd.onload = function () { install({ code: String(rd.result) }); };
    rd.readAsText(f);
  };
})();</script>`;
    return `<!doctype html><html lang="${I18n.language()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(tr('page.title'))}</title><style>
body{font:15px system-ui,sans-serif;margin:0;padding:16px;background:#111;color:#eee}
h1{font-size:22px}h2{font-size:18px;margin:0 0 4px}code{background:#222;padding:1px 5px;border-radius:4px}
.tv{background:#1b1b1b;border-radius:12px;padding:14px;margin:12px 0}.muted{color:#999;margin:0 0 10px}
form{display:flex;flex-wrap:wrap;gap:10px;align-items:end}label{display:flex;flex-direction:column;font-size:12px;color:#aaa;gap:3px}
input,select{font:inherit;padding:6px 8px;border-radius:6px;border:1px solid #444;background:#0c0c0c;color:#eee;min-width:180px;max-width:100%}
button{font:inherit;padding:7px 16px;border-radius:6px;border:0;background:#2d6cdf;color:#fff;cursor:pointer}
button.danger{background:#6d2323;margin-top:10px}
.note{background:#2a2410;border-left:3px solid #c9a227;padding:6px 10px;margin:0 0 10px}
label.chk{flex-direction:row;align-items:center;gap:6px;font-size:14px;color:#ddd}label.chk input{min-width:0}
.groups{display:flex;flex-wrap:wrap;gap:6px 18px;width:100%;margin:10px 0 4px}
.badge{font-size:12px;padding:2px 8px;border-radius:99px;margin-left:6px;vertical-align:middle}.on{background:#1e5d2c}.off{background:#5d1e1e}
table{border-collapse:collapse;margin-top:8px}td{padding:3px 10px;border-bottom:1px solid #2a2a2a;vertical-align:top}
details{margin-top:10px}a{color:#7aa7ff}pre{background:#0c0c0c;padding:8px 12px;border-radius:6px}
button.small{padding:4px 10px;font-size:13px}.code{font-size:20px;letter-spacing:2px;margin-right:8px}#pairing form{margin:8px 0}button.secondary{background:#3a3a3a}button:disabled{opacity:.45;cursor:default}
body.mp-open{overflow:hidden}.mp-back[hidden]{display:none}
.mp-back{position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;padding:12px;z-index:10}
.mp{background:#1b1b1b;border-radius:12px;width:100%;max-width:1200px;height:100%;max-height:900px;display:flex;flex-direction:column;overflow:hidden}
.mp-head{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid #2a2a2a}
.mp-x{background:none;font-size:24px;padding:0 8px}
.mp-cols{flex:1;display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:10px;min-height:0}
.mp-col{display:flex;flex-direction:column;min-height:0;min-width:0}
.mp-tools{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.mp-tools input:not([type]){flex:1;min-width:0}
.mp-chk{flex-direction:row;align-items:center;font-size:13px}.mp-chk input{min-width:0}
.mp-count{font-size:12px;color:#888;margin:6px 2px}
.mp-list{flex:1;overflow:auto;border:1px solid #2a2a2a;border-radius:8px}
.mp-row{padding:6px 10px;border-bottom:1px solid #242424;cursor:pointer}.mp-row:hover{background:#242424}
.mp-row.sel{background:#1d3a6e}.mp-row.cur{box-shadow:inset 3px 0 #3bb45a}
.mp-epg{display:flex;gap:10px;align-items:center}.mp-epg img{width:48px;height:28px;object-fit:contain;flex:none}.mp-txt{min-width:0}
.mp-name{overflow-wrap:anywhere}.mp-sub{font-size:12px;color:#8fbf8f;overflow-wrap:anywhere}.mp-sub.bad{color:#d98080}
.mp-badge{font-size:11px;background:#5a4a1a;border-radius:99px;padding:1px 7px;margin-left:6px}.mp-badge.opt{background:#333}
.mp-foot{border-top:1px solid #2a2a2a;padding:10px 14px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.mp-sel{flex:1;min-width:200px}.mp-btns{display:flex;gap:8px;flex-wrap:wrap}.mp-msg{width:100%;font-size:13px;color:#aaa}
@media (max-width:700px){.mp-cols{grid-template-columns:1fr;grid-template-rows:1fr 1fr}}
</style></head><body>
<h1>${esc(tr('page.pairTitle'))}</h1>${pairHtml}
<h1>${esc(tr('page.tvs'))}</h1>${tvHtml}
<h1>${esc(tr('parental.title'))}</h1>${parentalHtml}
<h1 id="plugins">${esc(tr('page.plTitle'))}</h1>${pluginsHtml}
<h1>${esc(tr('playlists.title'))}</h1><p class="muted">${esc(tr('page.playlistsHint'))} <a href="status">/status</a> ·
<a href="rebuild">${esc(tr('page.rebuild'))}</a> — ${esc(tr('page.rebuildHint'))}</p>
<table><tr><td>id</td><td>${esc(tr('page.colName'))}</td><td>${esc(tr('page.colKind'))}</td><td>${esc(tr('page.colState'))}</td><td></td></tr>${plHtml}</table>
<h1>${esc(tr('page.manualTitle'))}</h1>
<p class="muted">${esc(tr('page.manualHint'))}</p>
<div id="manual-map" class="muted">${esc(tr('common.loading'))}</div>
<script>window.IPTV_I18N = ${JSON.stringify(mappingTexts()).replace(/</g, '\\u003c')};</script>
<script src="mapping.js"></script>
<p class="muted" style="margin-top:40px">AssisTV · <a href="${PROJECT_URL}" target="_blank" rel="noopener">GitHub</a> ·
<a href="${SUPPORT_URL}" target="_blank" rel="noopener">☕ ${esc(tr('page.support'))}</a></p>
</body></html>`;
}

const server = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0].replace(/^\/+/, '/');
    // POST с JSON из браузера (стенд, карточка) идёт после preflight-запроса
    if (req.method === 'OPTIONS') {
        return send(res, 204, '', { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' });
    }
    const admin = fromIngress(req);
    // старый плеер (до 1.3) ходит без токена и сам выполняет плагины: ему — как раньше
    const legacyReq = !admin && !/^Bearer\s/i.test(String(req.headers.authorization || ''));
    const access = routeAccess(url);
    if (access === 'admin' && !admin && !(url === '/tvs.json' && fromHassio(req))) {
        return sendJson(res, 403, { error: 'forbidden', message: tr('page.onlyViaPanel') });
    }
    if (access === 'tv' && !admin && !tvFromRequest(req)) {
        return sendJson(res, 401, { error: 'unauthorized', message: tr('pair.needed') });
    }
    try {
        if (url === '/' && req.method === 'GET') {
            // напрямую на :8765 страницы нет: на ней настройки, а менять их можно только из HA
            if (!admin) return send(res, 200, '<!doctype html><meta charset="utf-8"><title>IPTV</title><p style="font:16px system-ui">' + esc(tr('page.openInHa')) + '</p>', { 'Content-Type': 'text/html; charset=utf-8' });
            const q = new URL(req.url, 'http://x').searchParams;
            return send(res, 200, await renderPage({ ingress: true, parentalNote: q.get('parental'), pluginNote: q.get('pnote') }), { 'Content-Type': 'text/html; charset=utf-8' });
        }
        if (url === '/playlists.json') {
            return sendJson(res, 200, publicPlaylists({ withUrl: legacyReq }));
        }
        // программа канала за прошлые дни — телевизор просит, когда открывают программу канала с архивом
        let m = /^\/playlists\/(\d+)\/archive\.json$/.exec(url);
        if (m) {
            const name = new URL(req.url, 'http://x').searchParams.get('name') || '';
            const b = bundles[+m[1]];
            if (!b || !epgCache) return sendJson(res, 503, { error: 'not_ready' });
            const channel = b.data.channels.find(c => c.name === name);
            if (!channel) return sendJson(res, 404, { error: 'not_found' });
            const days = channel.catchup && channel.catchup.available ? channel.catchup.days : 0;
            const epgId = b.data.match[name] || null;
            return sendJson(res, 200, {
                name, days, epgId,
                programmes: days && epgId ? archiveProgrammes(epgCache, epgId, days) : []
            });
        }
        // что идёт на канале (при архиве — шло) с описанием — телевизор просит по ▲ при просмотре
        m = /^\/playlists\/(\d+)\/programme\.json$/.exec(url);
        if (m) {
            const params = new URL(req.url, 'http://x').searchParams;
            const name = params.get('name') || '';
            const at = Number(params.get('at')) || Date.now() / 1000;
            const b = bundles[+m[1]];
            if (!b || !epgCache) return sendJson(res, 503, { error: 'not_ready' });
            const epgId = b.data.match[name] || null;
            if (!epgId) return sendJson(res, 200, { name, epgId: null, programme: null, next: null });
            return sendJson(res, 200, Object.assign({ name, epgId }, await programmeInfo(epgCache, epgId, at)));
        }
        m = /^\/playlists\/(\d+)\.json$/.exec(url);
        if (m) {
            const pl = playlistIndex.find(p => p.id === +m[1]);
            if (!pl) return sendJson(res, 404, { error: 'not_found' });
            if (pl.kind === 'vod') return sendJson(res, 200, { id: pl.id, name: pl.name, kind: 'vod', url: pl.url });
            const b = bundles[pl.id];
            if (!b) return sendJson(res, 503, { error: 'not_ready', message: 'плейлист ещё не собран, см. /status' });
            const gzipOk = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
            // на TV нет логов — так хотя бы видно, что телевизор забрал плейлист
            log(`playlists/${pl.id}.json -> ${clientIp(req)}${gzipOk ? ' (gzip)' : ''}`);
            return send(res, 200, gzipOk ? b.gzip : b.json, {
                'Content-Type': 'application/json; charset=utf-8',
                ...(gzipOk ? { 'Content-Encoding': 'gzip' } : {})
            });
        }
        if (url === '/tvs/register' && req.method === 'POST') {
            let body;
            try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { return sendJson(res, 400, { error: 'bad_json' }); }
            const r = await registerTv(body, clientIp(req));
            if (r.denied) return sendJson(res, 403, { error: 'pairing_required', message: tr('pair.updatePlayer') });
            if (r.busy) return sendJson(res, 429, { error: 'busy', message: tr('pair.busy') });
            if (r.pairing) return sendJson(res, 202, { pairing: r.pairing });
            const t = r.tv;
            const o = readOptions();
            const token = r.token || (t.tokenHash ? String(body.token || '') : '');
            // хост — тот же, по которому TV достучался до аддона. С токеном MQTT идёт через аддон (mqtt-proxy.js),
            // старому плееру — как раньше: WebSocket-слушатель Mosquitto и логин аддона
            const host = String(req.headers.host || '').replace(/:\d+$/, '');
            const mqttInfo = !mqttLogin ? null : token
                ? { host, port: PORT, path: mqttProxy.PATH, username: t.tv_id, password: token }
                : { host, port: o.mqttWsPort, username: mqttLogin.username, password: mqttLogin.password };
            return sendJson(res, 200, Object.assign(tvPublic(t), {
                token: r.token || undefined,
                mqtt: mqttInfo,
                playlists: publicPlaylists({ withUrl: !body.pairing }),
                parental: parental.forTv(t.adult_mode, allGroups())
            }));
        }
        // PIN с пульта телевизора; перебор — 5 попыток, потом минута паузы (parental.js)
        if (url === '/parental/check' && req.method === 'POST') {
            let body;
            try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { return sendJson(res, 400, { ok: false, error: 'bad_json' }); }
            const id = String(body.tv_id || '');
            const r = parental.check(body.pin, 'tv:' + (tvs[id] ? id : clientIp(req)));
            if (!r.ok && r.error !== 'disabled') log(`родительский контроль: неверный PIN с TV ${id || clientIp(req)} (${r.error})`);
            return sendJson(res, 200, Object.assign(r, { message: r.ok ? '' : parentalError(r) }));
        }
        m = /^\/parental\/(pin|off|groups)$/.exec(url);
        if (m && req.method === 'POST') {
            if (!fromIngress(req)) return send(res, 403, tr('page.onlyViaPanel'), { 'Content-Type': 'text/plain; charset=utf-8' });
            const form = new URLSearchParams(await readBody(req));
            let note = '';
            if (m[1] === 'pin') {
                const pin = String(form.get('pin') || '').trim();
                if (!parental.validPin(pin)) note = tr('page.pin4');
                else if (pin !== String(form.get('pin2') || '').trim()) note = tr('page.pinMismatch');
                else { parental.setPin(pin); note = tr('page.pinSaved'); }
            } else if (m[1] === 'off') {
                parental.clearPin();
                note = tr('page.parentalDisabled');
            } else {
                parental.setGroups(form.getAll('group'));
                note = tr('page.groupsSaved');
            }
            parentalChanged();
            return send(res, 303, '', { Location: '../?parental=' + encodeURIComponent(note) + '#parental' });
        }
        // раздел «Плагины»: установка (JSON {url} или {code} из страницы), настройки (форма), удаление
        if (url === '/plugins/install' && req.method === 'POST') {
            let body;
            try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { return sendJson(res, 400, { ok: false, error: 'bad_json' }); }
            try {
                await pluginsReady;
                const r = body.url ? await plugins.installFromUrl(String(body.url)) : await plugins.install(body.code);
                refreshVodSources();
                // настройки уже были (строка из опций, обновление) — плагин сразу работает
                const ready = plugins.sources().some(x => x.src === r.type);
                return sendJson(res, 200, Object.assign({ ok: true, ready }, r));
            } catch (e) {
                return sendJson(res, 200, { ok: false, error: e.message, message: pluginError(e.message) });
            }
        }
        m = /^\/plugins\/([a-z0-9_-]+)(\/delete)?$/.exec(url);
        if (m && req.method === 'POST') {
            let note = '';
            try {
                await pluginsReady;
                if (m[2]) await plugins.remove(m[1]);
                else {
                    const form = new URLSearchParams(await readBody(req));
                    const settings = {};
                    for (const [k, v] of form) if (k.startsWith('s_')) settings[k.slice(2)] = v;
                    await plugins.update(m[1], { name: form.get('name') || '', enabled: form.get('enabled') === '1', offline: form.get('offline') === '1', settings });
                }
                note = tr(m[2] ? 'page.plDeleted' : 'page.plSaved');
            } catch (e) {
                note = pluginError(e.message);
            }
            refreshVodSources();
            return send(res, 303, '', { Location: (m[2] ? '../../' : '../') + '?pnote=' + encodeURIComponent(note) + '#plugins' });
        }
        m = /^\/pairing\/([0-9a-f]+)\/(accept|reject)$/.exec(url);
        if (m && req.method === 'POST') {
            if (m[2] === 'reject') pairing.reject(m[1]);
            else {
                const p = pairing.approve(m[1]);
                if (p && p.token) {
                    // запись появляется сразу (видно на странице); токен телевизор заберёт при следующем опросе
                    const t = tvForDuid(p.duid, p.model, p.ip);
                    t.tokenHash = hashToken(p.token);
                    t.legacy = false;
                    t.ip = p.ip;
                    saveTvs();
                    updateCardData();
                }
            }
            return send(res, 303, '', { Location: '../../' });
        }
        m = /^\/tvs\/([\w-]+)\/(revoke|legacy)$/.exec(url);
        if (m && req.method === 'POST' && tvs[m[1]]) {
            const t = tvs[m[1]];
            if (m[2] === 'revoke') {
                delete t.tokenHash;
                t.legacy = false;
                mqttProxy.disconnectTv(t.tv_id);
                log(`TV ${t.tv_id}: привязка сброшена`);
            } else {
                t.legacy = new URLSearchParams(await readBody(req)).get('on') === '1';
                log(`TV ${t.tv_id}: старый плеер без привязки — ${t.legacy ? 'разрешён' : 'запрещён'}`);
            }
            saveTvs();
            return send(res, 303, '', { Location: '../../' });
        }
        if (url === '/tvs.json') {
            return sendJson(res, 200, Object.values(tvs).map(tvPublic));
        }
        m = /^\/tvs\/([\w-]+)\/delete$/.exec(url);
        if (m && req.method === 'POST' && tvs[m[1]]) {
            const id = m[1];
            mqttProxy.disconnectTv(id);
            clearTvFromBroker('tizen_iptv_' + id, 'iptv/' + id);
            delete tvs[id];
            delete tvChannels[id];
            saveTvs();
            fs.writeFileSync(TV_CHANNELS_FILE, JSON.stringify(tvChannels));
            try { fs.unlinkSync(path.join(card.WWW_DIR, `channels-${id}.json`)); } catch (e) { /* не было */ }
            updateCardData();
            log(`TV ${id}: удалён`);
            return send(res, 303, '', { Location: '../../' });
        }
        m = /^\/tvs\/([\w-]+)$/.exec(url);
        if (m && req.method === 'POST' && tvs[m[1]]) {
            const form = new URLSearchParams(await readBody(req));
            const t = tvs[m[1]];
            for (const k of ['name', 'remote_entity', 'media_player']) {
                if (form.has(k)) t[k] = form.get(k).trim();
            }
            // скрыть/показать с замком — тоже родительский контроль: только через панель HA
            if (form.has('adult_mode') && fromIngress(req)) t.adult_mode = form.get('adult_mode') === 'hide' ? 'hide' : 'lock';
            if (!t.name) t.name = t.tv_id;
            saveTvs();
            publishTvConfig(t);
            updateCardData();
            log(`TV ${t.tv_id}: изменён — «${t.name}», remote ${t.remote_entity || '—'}, media_player ${t.media_player || '—'}, ` +
                `защищённые группы — ${t.adult_mode === 'hide' ? 'скрыты' : 'с замком'}`);
            // обратно на страницу; относительный адрес, чтобы работало и через ingress
            return send(res, 303, '', { Location: '../' });
        }
        // постер из кеша: /local/… открывает только карточка внутри HA, телевизору нужен обычный адрес
        m = /^\/posters\/([\w-]+)\.jpg$/.exec(url);
        if (m) {
            const file = path.join(card.WWW_DIR, 'posters', m[1] + '.jpg');
            if (!fs.existsSync(file)) return sendJson(res, 404, { error: 'not_found' });
            return send(res, 200, fs.readFileSync(file), { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' });
        }
        // «Посмотреть позже» — общее на все телевизоры (watchlist.js)
        if (url === '/watchlist.json') {
            return sendJson(res, 200, { items: watchlist.list().map(watchPublic) });
        }
        if (url === '/watchlist' && req.method === 'POST') {
            let body;
            try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { return sendJson(res, 400, { ok: false, error: 'bad_json' }); }
            if (body.action === 'add') return sendJson(res, 200, await requestWatchlistAdd(body));
            if (body.action === 'remove') return sendJson(res, 200, requestWatchlistRemove(body));
            if (body.action === 'recheck' && body.key) {
                const it = await watchlist.recheck(body.key);
                syncFavoritePosterPins();
                return sendJson(res, 200, { ok: !!it, item: it ? watchPublic(it) : null, items: watchlist.list().map(watchPublic) });
            }
            return sendJson(res, 400, { ok: false, error: 'bad_action' });
        }
        // избранное видеопортала — общее на все телевизоры (favorites.js)
        if (url === '/favorites.json') {
            repairFavoritePosters().catch(() => { /* список доступен и без восстановления постеров */ });
            // Есть копия постера в аддоне — телевизору её: чужой CDN со временем умирает (05.11.2026 у HdRezka
            // перестал отвечать адрес постеров), а сохранённая ссылка в записи остаётся старой.
            // «/local/…» плеер (и старый тоже) превращает в <аддон>/posters/<id>.jpg.
            return sendJson(res, 200, { items: favorites.list().map(f => (f.posterLocal && /^\/local\//.test(f.posterLocal)
                ? Object.assign({}, f, { poster: f.posterLocal }) : f)) });
        }
        if (url === '/favorites' && req.method === 'POST') {
            let body;
            try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { return sendJson(res, 400, { ok: false, error: 'bad_json' }); }
            try {
                return sendJson(res, 200, toggleFavorite(body));
            } catch (e) {
                return sendJson(res, 400, { ok: false, error: e.message });
            }
        }
        /**
         * Копии плагинов для телевизора: старому плееру — все (он выполняет их сам), новому — только с
         * «работать на телевизоре без аддона», вместе с адресом источника (offline): ими TV открывает фильмы,
         * когда аддон недоступен. sha1 — чтобы не скачивать уже скачанное (TV держит код в localStorage).
         */
        if (url === '/vod-sources.json') {
            await pluginsReady;
            if (legacyReq) return sendJson(res, 200, { sources: plugins.list() });
            return sendJson(res, 200, {
                sources: plugins.list({ offlineOnly: true }),
                offline: plugins.sources().filter(s => s.offline).map(s => ({ id: s.id, src: s.src, url: s.url }))
            });
        }
        m = /^\/vod-sources\/([\w-]+)\.js$/.exec(url);
        if (m) {
            const code = plugins.code(m[1], { offlineOnly: !legacyReq });
            if (code == null) return sendJson(res, 404, { error: 'not_found' });
            log(`плагин ${m[1]}.js -> ${clientIp(req)}`);
            return send(res, 200, code, { 'Content-Type': 'text/javascript; charset=utf-8' });
        }
        /**
         * Источник фильмов для телевизора: {playlist: id, method, args} → {ok, result}. Плагин выполняется
         * здесь, в песочнице, — ключ источника на телевизор не уходит.
         */
        if (url === '/vod/call' && req.method === 'POST') {
            let body;
            try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { return sendJson(res, 400, { ok: false, error: 'bad_json' }); }
            await pluginsReady;
            const pl = playlistIndex.find(p => p.kind === 'vod' && p.id === +body.playlist);
            if (!pl) return sendJson(res, 404, { ok: false, error: 'no_source' });
            try {
                const result = await sandbox.call(pl.url, String(body.method || ''), Array.isArray(body.args) ? body.args : []);
                return sendJson(res, 200, { ok: true, result });
            } catch (e) {
                return sendJson(res, 200, { ok: false, error: e.message });
            }
        }
        // для проверки поиска из браузера: /vod/search?q=матрица[&src=portal]
        if (url === '/vod/search') {
            const p = new URL(req.url, 'http://x').searchParams;
            return sendJson(res, 200, await vod.search(p.get('q') || '', { src: p.get('src') || undefined }));
        }
        /**
         * Рейтинги (Кинопоиск и TMDB), жанры и описание по названию: телевизор берёт карточку фильма
         * прямо у портала, а не у аддона, поэтому метаданные докладываются отдельным запросом.
         * /vod/meta?title=Матрица&year=1999&kind=movie&desc=1 (desc=1 — описание у TV уже есть)
         */
        if (url === '/vod/meta') {
            const p = new URL(req.url, 'http://x').searchParams;
            const title = p.get('title') || '';
            if (!title) return sendJson(res, 400, { ok: false, error: 'no_title' });
            if (!tmdb.enabled() && !kp.enabled()) return sendJson(res, 200, { ok: true, enabled: false, meta: {} });
            const meta = await vod.meta({
                title, year: +p.get('year') || null,
                kind: p.get('kind') === 'series' ? 'series' : 'movie',
                description: p.get('desc') ? 'x' : ''
            });
            return sendJson(res, 200, { ok: true, enabled: true, meta });
        }
        /**
         * Рецензии зрителей Кинопоиска: /vod/reviews?id=<kpId>&page=1[&order=…]
         * id — тот самый kpId из /vod/meta. Страница — 20 штук, сверху самые полезные по мнению
         * читателей (у популярного фильма их сотни, свежие обычно пустые).
         */
        if (url === '/vod/reviews') {
            const p = new URL(req.url, 'http://x').searchParams;
            const id = +p.get('id');
            if (!id) return sendJson(res, 400, { ok: false, error: 'no_id' });
            if (!kp.enabled()) return sendJson(res, 200, { ok: true, enabled: false, reviews: { total: 0, pages: 0, page: 1, items: [] } });
            const reviews = await kp.reviews(id, {
                page: Math.max(1, +p.get('page') || 1),
                order: p.get('order') || undefined
            });
            return sendJson(res, 200, { ok: true, enabled: true, reviews });
        }
        if (url === '/mapping.js') {
            return send(res, 200, fs.readFileSync(path.join(__dirname, 'web', 'mapping.js')), { 'Content-Type': 'text/javascript; charset=utf-8' });
        }
        if (url === '/mapping/epg.json') {
            if (!epgCache) return sendJson(res, 503, { error: 'not_ready', message: tr('map.notReady') });
            const c = epgCatalog();
            const gzipOk = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
            return send(res, 200, gzipOk ? c.gzip : c.json, {
                'Content-Type': 'application/json; charset=utf-8', ...(gzipOk ? { 'Content-Encoding': 'gzip' } : {})
            });
        }
        m = /^\/mapping\/playlists\/(\d+)\.json$/.exec(url);
        if (m) {
            if (!epgCache || !m3uCache) return sendJson(res, 503, { error: 'not_ready', message: tr('map.notReady') });
            const r = mappingPlaylist(+m[1]);
            return r ? sendJson(res, 200, r) : sendJson(res, 404, { error: 'not_found', message: tr('map.playlistNotFound') });
        }
        if (url === '/mapping.json') {
            return sendJson(res, 200, { manual: readMapping(), options: optionsManualMap() });
        }
        if (url === '/mapping' && req.method === 'POST') {
            let body;
            try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { return sendJson(res, 400, { ok: false, error: 'bad_json' }); }
            const name = String(body.name || '').trim();
            const value = body.epg_id == null || body.epg_id === '' ? null : String(body.epg_id);
            if (!name) return sendJson(res, 400, { ok: false, error: tr('map.noName') });
            if (value && value !== NO_EPG && epgCache && !epgCache.epgChannels[value]) {
                return sendJson(res, 400, { ok: false, error: tr('map.noEpgChannel', { id: value }) });
            }
            const map = readMapping();
            if (value) map[name] = value; else delete map[name];
            writeAtomic(MAPPING_FILE, JSON.stringify(map, null, 2));
            log(`сопоставление: «${name}» → ${value == null ? 'автоматически' : value === NO_EPG ? 'без программы' : value}`);
            return sendJson(res, 200, await rematch());
        }
        if (url === '/status' && !admin && !fromHassio(req)) {
            // снаружи — только «жив ли и готов ли»: подробности (адреса TV, несовпавшие каналы) — из панели HA
            return sendJson(res, 200, { ok: true, epg: !!epgCache, playlists: (status.playlists || []).map(p => ({ id: p.id, ready: !!p.lastSuccess })) });
        }
        if (url === '/status') {
            // квота ключа Кинопоиска — здесь же: когда рейтинги вдруг пропали, первым делом смотрят сюда
            return sendJson(res, 200, Object.assign({}, status, {
                tvs: Object.values(tvs).map(tvPublic),
                // какие источники фильмов установлены и не сломан ли какой-нибудь из них
                vod_sources: plugins.report(),
                tmdb: tmdb.enabled(),
                kinopoisk: kp.enabled() ? (await kp.quota()) || { error: true } : false
            }));
        }
        if (url === '/rebuild') {
            const already = building;
            rebuild(/[?&]force=1/.test(req.url));
            return send(res, 202, already ? 'уже собирается' : 'сборка запущена, см. /status',
                { 'Content-Type': 'text/plain; charset=utf-8' });
        }
        send(res, 404, 'not found');
    } catch (err) {
        log(`HTTP ${req.method} ${url}: ${err.message}`);
        sendJson(res, 400, { error: err.message });
    }
});

fs.mkdirSync(DATA_DIR, { recursive: true });
loadFromDisk();
/**
 * Язык страницы и ответов для Assist: опция language; auto — язык Home Assistant (Настройки → Система → Общие),
 * не узнали (запуск на компьютере) — ADDON_LANG или английский.
 */
async function setupLanguage() {
    let code = 'auto';
    try { code = readOptions().language; } catch (e) { /* нет опций */ }
    if (code === 'auto') {
        code = process.env.ADDON_LANG || 'en';
        try {
            const res = await fetch('http://supervisor/core/api/config', {
                headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}` },
                signal: AbortSignal.timeout(5000)
            });
            if (res.ok) code = (await res.json()).language || code;
        } catch (e) { /* API недоступен */ }
    }
    I18n.setLanguage(I18n.normalize(code) || 'en');
    log(`язык: ${I18n.language()}`);
}

const mqttProxy = attachMqttProxy({ server, authenticate: tvForMqtt, upstream: () => mqttLogin, log });
server.listen(PORT, () => log(`слушаю порт ${PORT}`));

try { card.installCard(log); } catch (err) { log('карточка HA: не установилась: ' + err.message); }
// channels.json старой карточки без tv_id (до 2.1) — больше не пишется
try { fs.unlinkSync(path.join(card.WWW_DIR, 'channels.json')); log('карточка HA: удалён старый channels.json'); } catch (e) { /* уже нет */ }
updateCardData();
setInterval(updateCardData, 30 * 60 * 1000);
setupLanguage().then(startMqtt);

removeOldInfoFiles();   // от прошлого запуска: в памяти EPG ещё нет, файл описаний соберётся заново
rebuild();
repairFavoritePosters().catch(() => { /* восстановление постеров не должно мешать запуску */ });
guide.start();   // напоминания о передачах — проверка раз в 20 с
setInterval(() => history.tick(Object.keys(tvs).filter(id => tvOnline[id]).map(id => tvState[id])), history.TICK_SEC * 1000);
const refreshMs = Math.max(1, readOptions().refreshHours) * 3600e3;
setInterval(rebuild, refreshMs);
// «Посмотреть позже»: то, чего не было у источников, раз в сутки ищем снова (первый раз — через 10 мин после старта)
const recheckWatchlist = () => pluginsReady.then(() => watchlist.recheckDue()).then(syncFavoritePosterPins).catch(e => log('посмотреть позже: ' + e.message));
setTimeout(recheckWatchlist, 10 * 60 * 1000);
setInterval(recheckWatchlist, 3600 * 1000);
