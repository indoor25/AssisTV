/**
 * «Посмотреть позже» — общий на все телевизоры список фильмов, которые прислали с телефона (решение
 * пользователя 03.11.2026): увидел где-то фильм, поделился названием или ссылкой, а дома на TV в разделе
 * фильмов уже лежит постер, и OK открывает карточку из того источника, где фильм нашёлся.
 *
 *   /data/watchlist.json — { items: [{key, text, title, originalTitle, year, kind, kpId, kpRating, genres,
 *                                    description, posterLocal, found, checkedAt, addedAt, by}] }
 *
 * Присылают что угодно: чистое название, строку с годом, пост с хештегами, ссылку на Кинопоиск/IMDb или
 * на страницу с трейлером. Разбор (parseShared) оставляет кандидатов в названия, Кинопоиск говорит, какой
 * это фильм (постер, год, рейтинг — их видно, даже если у источников фильма нет), а источники — можно ли
 * его включить (found: {id, src, title, year, kind}). Нигде нет — запись остаётся серой с постером и раз в
 * сутки ищется заново (recheckDue): фильм может появиться у источника позже.
 *
 * key — «kp:<номер Кинопоиска>», без Кинопоиска — id найденного у источника, иначе «t:<название>|<год>».
 * Одно и то же прислали дважды — запись поднимается наверх, второй не появляется.
 */
const fs = require('fs');

const MAX_ITEMS = 300;
const RECHECK_MS = 20 * 3600e3;     // не найденное ищем заново не чаще раза в сутки (с запасом)
const PAGE_TIMEOUT_MS = 6000;
const PAGE_MAX_BYTES = 600 * 1024;  // заголовок страницы — в самом начале, дальше читать незачем
const MAX_CANDIDATES = 4;           // поиск Кинопоиска — 5 запросов/сек и дневная квота, лишнего не спрашиваем

const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const URL_RE = /https?:\/\/[^\s<>"«»]+/gi;
// слова, которыми название окружают в постах и заголовках страниц (ru, uk, en, de)
const NOISE_RE = new RegExp('(^|\\s)(' + [
    'официальный', 'официальный трейлер', 'русский трейлер', 'трейлер', 'тизер', 'тизер-трейлер', 'дублированный',
    'на русском', 'на русском языке', 'смотреть', 'смотреть онлайн', 'онлайн', 'бесплатно', 'в хорошем качестве',
    'полностью', 'все серии', 'все сезоны', 'новинка', 'премьера', 'фильм', 'фильмы', 'сериал', 'мультфильм',
    'мультсериал', 'кино', 'аниме', 'обзор', 'рецензия', 'отзыв', 'смотрите', 'смотри', 'советую', 'видео',
    'офіційний', 'трейлер українською', 'українською', 'дивитися', 'фільм', 'серіал',
    'official', 'official trailer', 'trailer', 'teaser', 'final trailer', 'watch', 'online', 'free', 'full movie',
    'movie', 'film', 'series', 'tv series', 'review', 'video', 'youtube', 'offizieller', 'deutsch', 'ganzer film',
    'hd', 'fhd', 'full hd', '4k', 'uhd', '1080p', '720p', '2160p', 'hdr'
].sort((a, b) => b.length - a.length).join('|') + ')(?=\\s|$)', 'giu');

/** «Дюна (2021) — официальный трейлер #кино» → «Дюна», год 2021. */
function cleanPiece(s) {
    let t = String(s || '')
        .replace(URL_RE, ' ')
        .replace(/[#@][\p{L}\p{N}_]+/gu, ' ')
        .replace(/\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}️‍]/gu, ' ')
        .replace(/[«»"“”„]/g, ' ')
        .replace(/\[[^\]]*\]/g, ' ')
        // «(Official Video)», «(4K Remaster)», «(русская озвучка)» — в скобках названия почти не бывает
        .replace(/\([^)]*\)/g, ' ');
    // «3 сезон», «сезон 3», «season 2» — Кинопоиск знает сериал целиком
    t = t.replace(/(^|\s)(\d+\s*(сезон|сезона|season|staffel)|(сезон|season|staffel)\s*\d+)(?=\s|$)/giu, ' ');
    for (let i = 0; i < 3; i++) t = t.replace(NOISE_RE, ' ');
    return t.replace(/\s+/g, ' ').replace(/^[\s.,:;!?|—–\-]+|[\s.,:;!?|—–\-]+$/g, '').trim();
}

function yearIn(s) {
    const m = /(?:^|[^\d])((?:19[0-9]|20[0-4])\d)(?=[^\d]|$)/.exec(String(s || ''));
    return m ? parseInt(m[1], 10) : null;
}

/**
 * Присланный текст → {urls, year, candidates}: кандидаты в названия, лучшие первыми — строка целиком
 * (без шума), потом куски между разделителями («Дюна: Часть вторая | Netflix» → «Дюна: Часть вторая»,
 * «Дюна»…). Год из текста отдельно: внутри кандидатов его нет.
 */
function parseShared(text) {
    const raw = String(text || '').slice(0, 2000);
    const urls = raw.match(URL_RE) || [];
    const lines = raw.replace(URL_RE, ' ').split(/\r?\n/).map(l => l.trim()).filter(l => /\p{L}/u.test(l)).slice(0, 3);
    const year = yearIn(lines.join(' '));
    const candidates = [];
    const push = s => {
        const c = cleanPiece(String(s).replace(/\(?\b(?:19|20)\d\d\b\)?/g, ' '));
        if (c.length >= 2 && /\p{L}|\d/u.test(c) && c.length <= 120 && !candidates.some(x => norm(x) === norm(c))) candidates.push(c);
    };
    // название в кавычках — почти всегда то, что нужно: «Смотрите «Мастер и Маргарита»»
    lines.forEach(line => (line.match(/«[^«»]{2,80}»|"[^"]{2,80}"|“[^”]{2,80}”/g) || []).forEach(push));
    lines.forEach(line => {
        push(line);
        // разделители заголовков: «Название — трейлер», «Название | Сайт», «Название: подзаголовок»
        const pieces = line.split(/\s[—–|•\-/]\s|\s?[|•]\s?/);
        pieces.forEach(push);
        pieces.forEach(piece => { const c = piece.split(/:\s/); if (c.length > 1) c.forEach(push); });
    });
    return { urls, year, candidates };
}

/** Ссылка на карточку каталога: точнее любого названия. */
function catalogLink(urls) {
    for (const u of urls || []) {
        let m = /kinopoisk\.ru\/(?:film|series)\/(\d+)/i.exec(u);
        if (m) return { kp: parseInt(m[1], 10) };
        m = /imdb\.com\/(?:[a-z]{2}\/)?title\/(tt\d+)/i.exec(u);
        if (m) return { imdb: m[1] };
    }
    return null;
}

function decodeEntities(s) {
    return String(s || '').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&laquo;/g, '«')
        .replace(/&raquo;/g, '»').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–').replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (m, c) => String.fromCharCode(+c))
        .replace(/&#x([0-9a-f]+);/gi, (m, c) => String.fromCharCode(parseInt(c, 16)))
        .replace(/&amp;/g, '&');
}

/** Заголовок страницы по ссылке (YouTube — через oEmbed: его HTML тяжёлый и без og:title для ботов). */
async function pageTitle(url, fetchImpl = fetch) {
    try {
        if (/(^|\.)(youtube\.com|youtu\.be)\//i.test(url.replace(/^https?:\/\//, ''))) {
            const r = await fetchImpl('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(url),
                { signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
            if (r.ok) return String((await r.json()).title || '');
            return '';
        }
        const r = await fetchImpl(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AssisTV)', 'Accept-Language': 'ru,en;q=0.8' },
            redirect: 'follow', signal: AbortSignal.timeout(PAGE_TIMEOUT_MS)
        });
        if (!r.ok) return '';
        const buf = Buffer.from(await r.arrayBuffer()).subarray(0, PAGE_MAX_BYTES).toString('utf8');
        const meta = name => {
            const m = new RegExp('<meta[^>]+(?:property|name)=["\']' + name + '["\'][^>]*content=["\']([^"\']+)', 'i').exec(buf) ||
                new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]*(?:property|name)=["\']' + name + '["\']', 'i').exec(buf);
            return m ? m[1] : '';
        };
        const t = meta('og:title') || meta('twitter:title') || ((/<title[^>]*>([^<]+)<\/title>/i.exec(buf) || [])[1] || '');
        return decodeEntities(t).trim();
    } catch (e) {
        return '';
    }
}

/**
 * kp — kinopoisk.js (enrich, film, byImdb), vod — vod.js (searchAll, poster), log.
 * fetchImpl — для теста (заголовки страниц).
 */
function createWatchlist({ file, log, kp, vod, fetchImpl }) {
    let items = read();
    const busy = new Set();

    function read() {
        try {
            const d = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (d && Array.isArray(d.items)) return d.items.filter(i => i && i.key && i.title);
        } catch (e) { /* ещё нет */ }
        return [];
    }

    function save() {
        fs.writeFileSync(file + '.tmp', JSON.stringify({ items }, null, 2));
        fs.renameSync(file + '.tmp', file);
    }

    function list() { return items.slice(); }

    function find(key) { return items.find(i => i.key === key) || null; }

    /** Запись, в которой фильм с этим id источника (кнопка «Убрать» в обычной карточке фильма). */
    function findByFound(id) {
        return id == null ? null : items.find(i => i.found && String(i.found.id) === String(id)) || null;
    }

    /** id постеров списка — чтобы кеш их не вытеснял (vod.setPinnedPosters). */
    function posterIds() {
        return items.map(i => i.found ? i.found.id : i.kpId ? 'kp:' + i.kpId : null).filter(Boolean);
    }

    const yearsClose = (a, b) => !a || !b || Math.abs(a - b) <= 1;

    /** Есть ли фильм у источников: сначала русское название, потом оригинальное. → {id, src, …} | null */
    async function findInSources(title, year, originalTitle) {
        for (const t of [title, originalTitle].filter(Boolean)) {
            try {
                const r = await vod.searchAll(t + (year ? ' ' + year : ''), { limit: 5 });
                const b = r.best;
                if (b && yearsClose(year, b.year)) {
                    return { id: b.id, src: b.src, title: b.title, year: b.year || null, kind: b.kind, quality: b.quality || '', poster: b.poster || null };
                }
            } catch (e) {
                if (e.message === 'no_portal') return null;
                log(`посмотреть позже: поиск «${t}»: ${e.message}`);
            }
        }
        return null;
    }

    /** Что это за фильм: ссылка каталога, иначе кандидаты из текста и заголовка страницы по очереди. */
    async function identify(text) {
        const p = parseShared(text);
        const link = catalogLink(p.urls);
        let meta = null;
        if (link && kp && kp.enabled()) meta = link.kp ? await kp.film(link.kp) : await kp.byImdb(link.imdb);
        let candidates = p.candidates;
        let year = p.year;
        if (!meta && !link && p.urls.length) {
            // ссылка на трейлер или пост: название — в заголовке страницы
            const title = await pageTitle(p.urls[0], fetchImpl);
            if (title) {
                const q = parseShared(title);
                candidates = candidates.concat(q.candidates.filter(c => !candidates.some(x => norm(x) === norm(c))));
                year = year || q.year;
            }
        }
        if (!meta && kp && kp.enabled()) {
            for (const c of candidates.slice(0, MAX_CANDIDATES)) {
                meta = await kp.enrich({ title: c, year, kind: 'movie' });
                if (meta) break;
            }
        }
        return { meta, candidates, year };
    }

    function sameEntry(a, b) {
        if (a.key === b.key) return true;
        if (a.kpId && b.kpId) return a.kpId === b.kpId;
        return !!(a.found && b.found && String(a.found.id) === String(b.found.id));
    }

    /**
     * Добавить присланное. → {ok, item, already} | {ok: false, error: 'no_title'}
     * by — откуда пришло (телефон, голос), только для журнала и подписи.
     */
    async function add(text, { by } = {}) {
        const src = String(text || '').trim();
        if (!src) return { ok: false, error: 'no_title' };
        const { meta, candidates, year } = await identify(src);
        const title = meta ? meta.title : candidates[0];
        if (!title) return { ok: false, error: 'no_title' };
        const y = meta ? meta.year : year;
        let found = await findInSources(title, y, meta && meta.originalTitle);
        // Кинопоиск промолчал (нет ключа, квота) — источник ищется по остальным кускам текста
        if (!found && !meta) {
            for (const c of candidates.slice(1, MAX_CANDIDATES)) {
                found = await findInSources(c, year);
                if (found) break;
            }
        }
        const entry = {
            key: meta ? 'kp:' + meta.id : found ? String(found.id) : 't:' + norm(title) + '|' + (y || ''),
            text: src.slice(0, 500),
            title: meta ? meta.title : found ? found.title : title,
            originalTitle: (meta && meta.originalTitle) || '',
            year: y || (found && found.year) || null,
            kind: (meta && meta.kind) || (found && found.kind) || 'movie',
            kpId: meta ? meta.id : null,
            kpRating: meta ? meta.rating : null,
            kpReviews: meta ? meta.reviews : 0,
            genres: meta ? (meta.genres || []).slice(0, 3) : [],
            description: meta ? String(meta.description || '').slice(0, 1500) : '',
            posterLocal: null,
            found,
            checkedAt: Date.now(),
            addedAt: Date.now(),
            by: by || ''
        };
        // постер: у источника — он уже в кеше после поиска; нет у источника — копия постера Кинопоиска
        if (found && found.poster && /^\/local\//.test(found.poster)) entry.posterLocal = found.poster;
        else if (meta && (meta.posterPreview || meta.poster)) {
            entry.posterLocal = await vod.poster('kp:' + meta.id, meta.posterPreview || meta.poster).catch(() => null);
        }
        const prev = items.find(i => sameEntry(i, entry));
        if (prev) entry.addedAt = prev.addedAt;
        items = [entry].concat(items.filter(i => !sameEntry(i, entry))).slice(0, MAX_ITEMS);
        save();
        log(`посмотреть позже: ${prev ? 'снова' : 'добавлено'} «${entry.title}»${entry.year ? ' (' + entry.year + ')' : ''} — ` +
            (found ? 'есть: ' + found.id : 'у источников нет') + (by ? ', от ' + by : '') + `, всего ${items.length}`);
        return { ok: true, item: entry, already: !!prev };
    }

    function remove(key) {
        const prev = find(key);
        if (!prev) return null;
        items = items.filter(i => i.key !== key);
        save();
        log(`посмотреть позже: убрано «${prev.title}», осталось ${items.length}`);
        return prev;
    }

    /** Поискать запись у источников заново (кнопка на TV и раз в сутки для ненайденного). */
    async function recheck(key) {
        const it = find(key);
        if (!it || busy.has(key)) return it;
        busy.add(key);
        try {
            const found = await findInSources(it.title, it.year, it.originalTitle);
            const cur = find(key);
            if (!cur) return null;
            cur.checkedAt = Date.now();
            if (found && !cur.found) log(`посмотреть позже: «${cur.title}» появился — ${found.id}`);
            if (found) {
                cur.found = found;
                if (found.poster && /^\/local\//.test(found.poster) && !cur.posterLocal) cur.posterLocal = found.poster;
            }
            save();
            return cur;
        } finally {
            busy.delete(key);
        }
    }

    async function recheckDue() {
        const due = items.filter(i => !i.found && Date.now() - (i.checkedAt || 0) > RECHECK_MS);
        for (const it of due) await recheck(it.key).catch(() => null);
        return due.length;
    }

    return { list, find, findByFound, posterIds, add, remove, recheck, recheckDue, MAX_ITEMS };
}

module.exports = { createWatchlist, parseShared, cleanPiece, catalogLink, pageTitle };
