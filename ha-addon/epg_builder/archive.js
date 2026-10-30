/**
 * Проверка, есть ли у канала архив на самом деле.
 *
 * В M3U провайдера архив помечен tvg-rec="N" (дней), но у заметной части таких каналов его нет: сервер
 * на запрос архива отвечает 200 и пустым плейлистом без сегментов (проверено запросами 15–16.09.2026,
 * ~половина помеченных каналов). Поэтому каждый помеченный канал проверяется запросом:
 *   <ссылка канала>?utc=<час назад>&lutc=<сейчас>  →  в плейлисте есть сегменты  →  первый сегмент отдаётся.
 * Сегмент проверяем отдельно: плейлист перечисляет сегменты «на всякий случай», и за пределами реальной
 * глубины архива они отвечают 404.
 *
 * Результаты — в /data/archive.json { "<url канала>": { ok, at } }. Каждый канал проверяется не чаще раза в
 * CHECK_TTL_MS, по CONCURRENCY запросов одновременно: ~1000 каналов × ~60 мс ≈ полминуты.
 */
const fs = require('fs');

const CHECK_TTL_MS = 20 * 3600e3;
const CONCURRENCY = 3;
const TIMEOUT_MS = 8000;
const FETCH_HEADERS = { 'User-Agent': 'Mozilla/5.0 (SMART-TV; Tizen) epg-builder' };

/** Ссылка на архив провайдера (схема Edem/iLook «shift»): с utc (unix-сек) по «сейчас». */
function archiveUrl(url, utc, lutc) {
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'utc=' + Math.floor(utc) + '&lutc=' + Math.floor(lutc);
}

async function fetchTimeout(url, opts) {
    return fetch(url, Object.assign({ headers: FETCH_HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) }, opts));
}

/** true — архив есть, false — нет; исключение — сеть/таймаут (результат не записываем). */
async function probe(url) {
    const now = Date.now() / 1000;
    const res = await fetchTimeout(archiveUrl(url, now - 3600, now));
    if (!res.ok) return false;
    const body = await res.text();
    const seg = body.split('\n').map(l => l.trim()).find(l => l && l[0] !== '#');
    if (!seg) return false;
    const segRes = await fetchTimeout(new URL(seg, res.url).href, {
        headers: Object.assign({ Range: 'bytes=0-187' }, FETCH_HEADERS)
    });
    try { await segRes.arrayBuffer(); } catch (e) { /* тело не нужно */ }
    return segRes.status === 200 || segRes.status === 206;
}

function createArchiveChecker({ file, log }) {
    let cache = {};
    try { cache = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { cache = {}; }
    let running = null;

    function save() {
        fs.writeFileSync(file + '.tmp', JSON.stringify(cache));
        fs.renameSync(file + '.tmp', file);
    }

    /** { url: true|false } — что известно сейчас (для build.js assemblePlaylists). */
    function snapshot() {
        const out = {};
        for (const [url, r] of Object.entries(cache)) out[url] = r.ok;
        return out;
    }

    /**
     * Проверить каналы с tvg-rec из загруженных M3U ([{channels}]), у которых результат устарел.
     * → true, если у какого-то канала результат поменялся (плейлисты надо пересобрать).
     */
    function check(loaded) {
        if (running) return running;
        running = (async () => {
            const urls = new Set();
            for (const l of loaded || []) {
                for (const c of l.channels || []) if (c.catchup && c.catchup.days > 0) urls.add(c.url);
            }
            // каналов, которых больше нет в плейлистах, не храним
            for (const url of Object.keys(cache)) if (!urls.has(url)) delete cache[url];
            const todo = [...urls].filter(url => !cache[url] || Date.now() - cache[url].at > CHECK_TTL_MS);
            if (!todo.length) return false;

            const t0 = Date.now();
            log(`архив: проверяю ${todo.length} каналов`);
            let changed = false;
            let errors = 0;
            let i = 0;
            const worker = async () => {
                while (i < todo.length) {
                    const url = todo[i++];
                    try {
                        const ok = await probe(url);
                        if (!cache[url] || cache[url].ok !== ok) changed = true;
                        cache[url] = { ok, at: Date.now() };
                    } catch (e) {
                        errors++;
                    }
                }
            };
            await Promise.all(Array.from({ length: CONCURRENCY }, worker));
            save();
            const ok = [...urls].filter(url => cache[url] && cache[url].ok).length;
            log(`архив: проверено за ${((Date.now() - t0) / 1000).toFixed(0)} с, архив есть у ${ok} из ${urls.size}` +
                (errors ? `, не ответили ${errors}` : ''));
            return changed;
        })().finally(() => { running = null; });
        return running;
    }

    return { snapshot, check, isRunning: () => !!running };
}

module.exports = { createArchiveChecker, archiveUrl };
