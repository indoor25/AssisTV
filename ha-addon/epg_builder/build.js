/**
 * Сборка плейлистов для телевизора: M3U + сопоставленный с ним EPG одним готовым JSON.
 *
 * Зачем: исходный epg.it999.ru/epg.xml.gz — 42 МБ gzip / 386 МБ XML, и телевизор падает по
 * памяти, пытаясь его разобрать (проверено замером). Здесь та же работа делается
 * на Raspberry Pi, а телевизор получает маленький JSON только по каналам своего плейлиста и
 * только на нужное окно времени. Плейлистов может быть несколько: каждый M3U качается и
 * разбирается отдельно, а XMLTV — один раз на всех (он самый тяжёлый).
 *
 * Прошлые передачи EPG держатся в памяти на глубину архива (до 7 дней), но в JSON плейлиста идёт только окно
 * past_hours…future_hours: программу за прошлые дни телевизор запрашивает по одному каналу, когда её открывают
 * (archiveProgrammes → /playlists/<id>/archive.json).
 *
 * Описания передач (с жанром и возрастом) в память не берутся: уникальных текстов ~100 тыс., это ~70 МБ строк.
 * Они пишутся в файл (createInfoStore, одинаковые — один раз), у передачи — только ссылка 4-м элементом;
 * телевизор просит описание одной передачи (programmeInfo → /playlists/<id>/programme.json).
 *
 * Разобранный EPG (все каналы источника, не только совпавшие) остаётся в памяти сервиса: ручная привязка
 * канала на странице аддона пересобирает плейлисты по нему за секунды, без повторного скачивания
 * (rematch). Каналов источника ~3,2 тыс. — по ним же страница показывает, у кого есть передачи.
 *
 * Разбор и нормализация — НЕ копии, а те же самые файлы, что на TV (js/xmltv-parser.js,
 * js/m3u-parser.js, js/channel-name.js): иначе совпадения каналов на бэкенде и в плеере
 * разъедутся. В контейнер аддона они кладутся в ./shared скриптом деплоя.
 *
 * Результат по одному M3U-плейлисту (version 2) — это же отдаёт /playlists/<id>.json:
 * {
 *   version, id, name, kind: 'tv', generatedAt, from, to,   // from/to — unix-секунды, окно передач
 *   channels:     [{ id, name, logo, group, url, catchup }],  // разобранный M3U, как parseM3U;
 *                 // catchup.available: true/false — архив проверен запросом (archive.js), нет поля — ещё не проверяли
 *   match:        { "<имя канала как в плейлисте>": "<epgId>" },
 *   channels_epg: { "<epgId>": { displayNames: [...имена из плейлиста], icon } },
 *   programmes:   { "<epgId>": [[startSec, stopSec, "title"], ...] }  // отсортированы по start
 * }
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { Readable } = require('stream');

function requireShared(name) {
    const local = path.join(__dirname, 'shared', name);
    return require(fs.existsSync(local) ? local : path.join(__dirname, '..', '..', 'js', name));
}
const { normalizeChannelName } = requireShared('channel-name.js');
const { parseM3U } = requireShared('m3u-parser.js');
const { createXmltvParser } = requireShared('xmltv-parser.js');

const FETCH_HEADERS = { 'User-Agent': 'Mozilla/5.0 (SMART-TV; Tizen) epg-builder' };

/**
 * Источник фильмов, а не M3U-плейлист каналов: адрес вида <тип>::[параметры]<url>
 * (portal::[key:…]http://…). Тот же разбор, что VodSources.isSourceUrl() в js/vod-sources.js —
 * повторён здесь строкой, чтобы сборка плейлистов не зависела от реестра плагинов.
 */
const isSourceUrl = url => /^\s*[a-z0-9_-]+::/i.test(url || '');

async function fetchText(url) {
    const res = await fetch(url, { headers: FETCH_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.text();
}

/** Потоково качает и разбирает XMLTV: в памяти одновременно только текущий кусок текста. */
async function parseXmltvSource(url, { from, to, mapTitle, mapInfo }) {
    const res = await fetch(url, { headers: FETCH_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);

    const parser = createXmltvParser({ from, to, mapTitle, mapInfo, trackLastStop: true, compact: true });
    let stream = Readable.fromWeb(res.body);

    // gzip определяем по сигнатуре 1f 8b, а не по расширению: некоторые источники отдают .gz без
    // расширения в URL и наоборот
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done) throw new Error('empty response from ' + url);
    const head = Buffer.from(first.value);
    const rest = Readable.from((async function* () {
        yield head;
        for (let r = await iterator.next(); !r.done; r = await iterator.next()) yield r.value;
    })());
    stream = head[0] === 0x1f && head[1] === 0x8b ? rest.pipe(zlib.createGunzip()) : rest;

    stream.setEncoding('utf8'); // StringDecoder корректно склеивает UTF-8, разрезанный между чанками
    for await (const chunk of stream) parser.push(chunk);
    return parser.end();
}

/** Значение ручной привязки «без программы»: убрать неверное автоматическое совпадение. */
const NO_EPG = '-';

/**
 * Какому каналу EPG соответствует канал плейлиста. how: manual — ручная привязка, auto — по имени,
 * none — не нашёлся (или привязан «без программы»), bad — ручная привязка указывает на канал, которого нет.
 */
function resolveChannel(name, epg, manualMap) {
    const manual = manualMap[name];
    if (manual === NO_EPG) return { id: null, how: 'manual' };
    if (manual) {
        const id = epg.epgChannels[manual] ? manual : epg.byNorm[normalizeChannelName(manual)] || null;
        if (id) return { id, how: 'manual' };
        const auto = epg.byNorm[normalizeChannelName(name)] || null;
        return { id: auto, how: 'bad', manual };
    }
    const id = epg.byNorm[normalizeChannelName(name)] || null;
    return { id, how: id ? 'auto' : 'none' };
}

/** Сопоставление одного плейлиста с уже разобранным EPG. */
function matchPlaylist(playlist, epg, manualMap, log) {
    const windowFrom = Math.floor(epg.from.getTime() / 1000);
    // в памяти сервиса программа лежит дальше окна плейлиста (поиск по программе) — телевизору уходит только окно
    const windowTo = Math.floor(epg.to.getTime() / 1000);
    const match = {};
    const unmatched = [];
    const used = new Set();
    for (const ch of playlist) {
        const r = resolveChannel(ch.name, epg, manualMap);
        if (r.how === 'bad') log(`manualMap: для "${ch.name}" не найден канал EPG "${r.manual}"`);
        if (r.id) { match[ch.name] = r.id; used.add(r.id); } else unmatched.push(ch.name);
    }

    const channels = {};
    const programmes = {};
    let programmeCount = 0;
    for (const id of used) {
        channels[id] = {
            displayNames: Object.keys(match).filter(name => match[name] === id),
            icon: epg.epgChannels[id].icon || null
        };
        programmes[id] = epg.epgProgrammes[id].filter(p => p[1] > windowFrom && p[0] <= windowTo).map(publicProgramme);
        programmeCount += programmes[id].length;
    }
    return { match, channels, programmes, unmatched, epgChannelCount: used.size, programmeCount };
}

const INFO_SEP = '\u0001';   // разделитель полей записи в файле описаний

/** Передача без ссылки на описание — так она уходит телевизору. */
function publicProgramme(p) {
    return p.length > 3 ? p.slice(0, 3) : p;
}

/**
 * Файл описаний передач: запись «жанр, возраст, описание» через INFO_SEP в UTF-8, одинаковые пишутся один раз.
 * Ссылка на запись — число смещение·65536 + длина (0 — описания нет). Файл свой у каждой загрузки EPG
 * (info-<время>.bin): старый читают, пока новый EPG не заменил его в памяти сервиса.
 */
function createInfoStore(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `info-${Date.now()}.bin`);
    const fd = fs.openSync(file, 'w');
    const seen = new Map();   // md5 записи → ссылка
    let offset = 0;
    let chunks = [];
    let pending = 0;
    const flush = () => {
        if (!pending) return;
        fs.writeSync(fd, Buffer.concat(chunks));
        chunks = [];
        pending = 0;
    };
    return {
        file,
        put({ desc, category, rating }) {
            if (!desc && !category && !rating) return 0;
            let buf = Buffer.from(category + INFO_SEP + rating + INFO_SEP + desc, 'utf8');
            if (buf.length > 65535) buf = buf.subarray(0, 65535);
            const key = crypto.createHash('md5').update(buf).digest('base64');
            let ref = seen.get(key);
            if (ref === undefined) {
                ref = offset * 65536 + buf.length;
                seen.set(key, ref);
                chunks.push(buf);
                pending += buf.length;
                offset += buf.length;
                if (pending > 1 << 20) flush();
            }
            return ref;
        },
        finish() { flush(); fs.closeSync(fd); return { unique: seen.size, bytes: offset }; },
        abort() { try { fs.closeSync(fd); } catch (e) { /* уже закрыт */ } fs.rmSync(file, { force: true }); }
    };
}

/** Описание по ссылке из передачи: {category, rating, desc} или null. */
async function readInfo(file, ref) {
    if (!file || !ref) return null;
    const len = ref % 65536;
    const offset = (ref - len) / 65536;
    const fh = await fs.promises.open(file, 'r');
    try {
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, offset);
        const [category, rating, ...rest] = buf.toString('utf8').split(INFO_SEP);
        return { category: category || null, rating: rating || null, desc: rest.join(INFO_SEP) || null };
    } finally {
        await fh.close();
    }
}

/**
 * Передача канала EPG, идущая в момент at (unix-сек), с описанием и следующая за ней:
 * {programme: {start, stop, title, category, rating, desc} | null, next: {start, stop, title} | null}.
 */
async function programmeInfo(epg, epgId, at) {
    const list = (epg && epg.epgProgrammes[epgId]) || [];
    let lo = 0, hi = list.length;   // первая передача, закончившаяся позже at
    while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid][1] <= at) lo = mid + 1; else hi = mid; }
    const p = list[lo] && list[lo][0] <= at ? list[lo] : null;
    const n = p ? list[lo + 1] : list[lo];
    const info = p ? await readInfo(epg.infoFile, p[3]) : null;
    return {
        programme: p ? Object.assign({ start: p[0], stop: p[1], title: p[2] }, info || { category: null, rating: null, desc: null }) : null,
        next: n ? { start: n[0], stop: n[1], title: n[2] } : null
    };
}

/**
 * Скачивает и разбирает все XMLTV-источники. Каналы берутся ВСЕ, без отсева по плейлисту: иначе вручную
 * привязать канал, у которого другое имя, было бы не к чему.
 * Возвращает { from, to (окно плейлиста), archiveFrom, guideTo (что лежит в памяти), loadedAt, epgChannels: {id: {names, icon}}, epgProgrammes: {id: [[s, e, title]]},
 *   lastStop: {id: sec}, byNorm: {нормализованное имя: id}, infoFile }.
 * opts.infoDir — куда писать файл описаний (без него описания не разбираются, передачи — [s, e, title]).
 */
async function loadEpg(opts) {
    const log = opts.log || (() => {});
    const now = Date.now();
    const from = new Date(now - (opts.pastHours ?? 3) * 3600e3);
    const to = new Date(now + (opts.futureHours ?? 36) * 3600e3);
    // для архива передачи храним глубже окна плейлиста — на столько дней, сколько архива у каналов
    const archiveFrom = new Date(Math.min(from.getTime(), now - (opts.archiveDays || 0) * 86400e3));
    // а для поиска по программе («когда футбол?») — вперёд, сколько знает источник, но не дальше guideDays
    const guideTo = new Date(Math.max(to.getTime(), now + (opts.guideDays || 0) * 86400e3));

    // Источники по порядку: при конфликте выигрывает тот, что раньше в списке.
    const epgChannels = {};
    const epgProgrammes = {};
    const lastStop = {};
    const byNorm = {};   // первое совпадение выигрывает
    // Передач за неделю ~600 тыс., а названий в разы меньше («Новости»…). Кроме того, название, вырезанное
    // регуляркой из куска XML, держит в памяти V8 весь этот кусок. Поэтому парсер (mapTitle) копирует названия и
    // хранит по одному экземпляру: без этого разбор недели передач съедал больше 640 МБ и падал.
    const titles = new Map();
    const intern = t => {
        let v = titles.get(t);
        if (v === undefined) { v = Buffer.from(t, 'utf8').toString('utf8'); titles.set(v, v); }
        return v;
    };

    const infoStore = opts.infoDir ? createInfoStore(opts.infoDir) : null;
    const mapInfo = infoStore ? info => infoStore.put(info) : null;
    try {
        for (let i = 0; i < opts.epgUrls.length; i++) {
            const url = opts.epgUrls[i];
            const ts = Date.now();
            log(`epg[${i}]: загрузка ${url}`);
            const parsed = await parseXmltvSource(url, { from: archiveFrom, to: guideTo, mapTitle: intern, mapInfo });
            // id разных источников могут пересекаться — у всех, кроме первого, делаем префикс
            const prefix = i === 0 ? '' : `s${i}:`;
            let n = 0;
            for (const [rawId, info] of Object.entries(parsed.channels)) {
                const id = prefix + rawId;
                epgChannels[id] = { names: info.displayNames || [info.displayName], icon: info.icon };
                // передачи приходят из парсера уже готовыми [s, e, title, ссылка на описание?] (compact)
                epgProgrammes[id] = (parsed.programmes[rawId] || []).sort((a, b) => a[0] - b[0]);
                parsed.programmes[rawId] = null;
                lastStop[id] = parsed.lastStop[rawId] ? Math.floor(parsed.lastStop[rawId] / 1000) : null;
                // В источнике бывают дубли одного канала под разными id, и часть из них пустая.
                // Поэтому первое совпадение выигрывает, только пока у него есть передачи.
                const hasProgrammes = epgProgrammes[id].length > 0;
                for (const name of [...epgChannels[id].names, rawId]) {
                    const norm = normalizeChannelName(name);
                    const prev = byNorm[norm];
                    if (!prev || (hasProgrammes && !epgProgrammes[prev].length)) byNorm[norm] = id;
                }
                n++;
            }
            log(`epg[${i}]: ${n} каналов за ${((Date.now() - ts) / 1000).toFixed(1)} с`);
        }
    } catch (err) {
        if (infoStore) infoStore.abort();
        throw err;
    }
    let infoFile = null;
    if (infoStore) {
        const st = infoStore.finish();
        if (st.bytes) {
            infoFile = infoStore.file;
            log(`описания передач: ${st.unique} разных, ${(st.bytes / 1e6).toFixed(1)} МБ в ${path.basename(infoFile)}`);
        } else {
            // в источниках нет ни описаний, ни жанров — пустой файл не нужен, TV покажет «Описание недоступно»
            infoStore.abort();
            log('описания передач: в источниках EPG их нет');
        }
    }
    return { from, to, archiveFrom, guideTo, loadedAt: new Date().toISOString(), epgChannels, epgProgrammes, lastStop, byNorm, infoFile };
}

/** Качает и разбирает M3U. [{pl, channels} | {pl, error}] — сломанный плейлист не мешает остальным. */
async function loadM3uPlaylists(playlists, log) {
    const loaded = [];
    for (const pl of playlists) {
        try {
            log(`плейлист ${pl.id} «${pl.name}»: загрузка`);
            const channels = parseM3U(await fetchText(pl.url));
            if (!channels.length) throw new Error('плейлист пустой или не разобрался');
            log(`плейлист ${pl.id} «${pl.name}»: ${channels.length} каналов`);
            loaded.push({ pl, channels });
        } catch (err) {
            log(`плейлист ${pl.id} «${pl.name}»: ОШИБКА ${err.message}`);
            loaded.push({ pl, error: err.message });
        }
    }
    return loaded;
}

/** Самый глубокий архив (дней) среди каналов загруженных M3U — на столько назад храним передачи. */
function maxArchiveDays(loaded) {
    let days = 0;
    for (const l of loaded) for (const c of l.channels || []) if (c.catchup && c.catchup.days > days) days = c.catchup.days;
    return Math.min(days, 14);
}

/** Канал с отметкой, проверен ли архив: archive — { url: true|false } из archive.js. */
function withArchive(channel, archive) {
    if (!channel.catchup || !(channel.catchup.days > 0) || !archive || !(channel.url in archive)) return channel;
    return Object.assign({}, channel, { catchup: Object.assign({}, channel.catchup, { available: archive[channel.url] }) });
}

/** Передачи канала EPG для просмотра архива: начавшиеся за последние days дней и до «сейчас». [[start, stop, title]] */
function archiveProgrammes(epg, epgId, days) {
    const list = (epg && epg.epgProgrammes[epgId]) || [];
    const now = Date.now() / 1000;
    const from = now - days * 86400;
    return list.filter(p => p[0] >= from && p[0] < now).map(publicProgramme);
}

/** Готовые данные плейлистов из уже загруженных M3U и EPG: [{id, data, stats} | {id, error}]. */
function assemblePlaylists(loaded, epg, manualMap, log, archive) {
    const t0 = Date.now();
    const generatedAt = new Date().toISOString();
    return loaded.map(({ pl, channels, error }) => {
        if (error) return { id: pl.id, error };
        const m = matchPlaylist(channels, epg, manualMap || {}, log || (() => {}));
        const data = {
            version: 2,
            id: pl.id,
            name: pl.name,
            kind: 'tv',
            generatedAt,
            epgLoadedAt: epg.loadedAt,
            from: Math.floor(epg.from.getTime() / 1000),
            to: Math.floor(epg.to.getTime() / 1000),
            channels: channels.map(c => withArchive(c, archive)),
            match: m.match,
            channels_epg: m.channels,
            programmes: m.programmes
        };
        const stats = {
            playlistChannels: channels.length,
            matchedChannels: Object.keys(m.match).length,
            epgChannels: m.epgChannelCount,
            programmes: m.programmeCount,
            unmatched: m.unmatched,
            durationSec: +((Date.now() - t0) / 1000).toFixed(1)
        };
        return { id: pl.id, data, stats };
    });
}

/**
 * opts: {
 *   playlists: [{ id, name, url }]   — только M3U, порталы сюда не передаются
 *   epgUrls: [...], pastHours, futureHours,
 *   manualMap: { "<имя в плейлисте>": "<epgId или display-name канала в EPG>" | "-" },
 *   archive: { "<url канала>": true|false }  — результаты проверки архива (archive.js),
 *   log: fn
 * }
 * Возвращает { results, loaded, epg } — loaded и epg сервис держит в памяти для rematch.
 */
async function buildPlaylists(opts) {
    const log = opts.log || (() => {});
    const loaded = await loadM3uPlaylists(opts.playlists, log);
    if (!loaded.some(l => l.channels)) {
        return { results: loaded.map(l => ({ id: l.pl.id, error: l.error })), loaded: null, epg: null };
    }
    const epg = await loadEpg({ ...opts, archiveDays: maxArchiveDays(loaded) });
    return { results: assemblePlaylists(loaded, epg, opts.manualMap, log, opts.archive), loaded, epg };
}

module.exports = { buildPlaylists, loadEpg, assemblePlaylists, archiveProgrammes, programmeInfo, resolveChannel, isSourceUrl, normalizeChannelName, NO_EPG };
