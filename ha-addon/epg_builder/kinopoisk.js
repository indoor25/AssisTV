/**
 * Рейтинг Кинопоиска и рецензии зрителей — то, ради чего пользователь читал их на стороннем сайте.
 *
 * API неофициальное (kinopoiskapiunofficial.tech), ключ — опция аддона `kinopoisk_key`, уходит в
 * заголовке X-API-KEY. Ключа нет — модуль молча выключен, всё работает как раньше на одном TMDB.
 * Любая ошибка сети или разбора даёт null/[]: рейтинг и рецензии — украшение, карточка фильма из-за
 * них открываться не перестаёт.
 *
 * Чем дополняет TMDB (оба живут одновременно, см. vod.meta):
 *   — оценка, которой у нас доверяют: у русского и советского кино на TMDB голосов почти нет;
 *   — рецензии ПО-РУССКИ и помногу (на TMDB их единицы и по-английски);
 *   — жанры единообразно строчными («драма», «фантастика») — у TMDB русские жанры сериалов
 *     приходят вразнобой («НФ и Фэнтези» рядом с «драма»).
 *
 * Лимиты: у поиска 5 запросов/сек (остальное 25), поэтому поиск сериализован с паузой SEARCH_GAP_MS.
 * Дневная квота у ключа небольшая — её остаток отдаёт сам API (quota()), он виден в /status аддона.
 *
 * Кеш: найденное и промахи — на диске (/data/kinopoisk.json), как у TMDB. Тексты рецензий на диск НЕ
 * кладём — у популярного фильма их сотни по несколько килобайт, это разнесло бы /data; они живут в
 * памяти недолго (одного вечера у экрана хватает).
 */
const fs = require('fs');
const path = require('path');

function requireShared(name) {
    const local = path.join(__dirname, 'shared', name);
    return require(fs.existsSync(local) ? local : path.join(__dirname, '..', '..', 'js', name));
}
const ChannelMatch = requireShared('channel-match.js');

const API = 'https://kinopoiskapiunofficial.tech';
const TTL_MS = 30 * 24 * 3600e3;
const TTL_MISS_MS = 7 * 24 * 3600e3;
const MAX_ITEMS = 3000;
const MIN_SCORE = 0.6;
const MIN_VOTES = 10;
const TIMEOUT_MS = 8000;
const SAVE_DELAY_MS = 5000;
const SEARCH_GAP_MS = 220;          // у /search-by-keyword лимит 5 запросов/сек
const REVIEWS_PER_PAGE = 20;        // столько отдаёт API на страницу
const REVIEW_CACHE = 12;            // страниц рецензий в памяти (LRU)
const REVIEW_TTL_MS = 3600e3;
const QUOTA_TTL_MS = 600e3;

const SERIES_TYPES = { TV_SERIES: 1, MINI_SERIES: 1, TV_SHOW: 1 };

const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Год у поиска — строка, у сериалов бывает «2011-2019». */
function yearOf(v) {
    const n = parseInt(String(v || '').slice(0, 4), 10);
    return n >= 1870 && n <= 2200 ? n : null;
}

/** «7.9» → 7.9, а «99%» — это процент ожидания непоказанного фильма, не оценка. */
function parseRating(v) {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    if (!s || s === 'null' || s.endsWith('%')) return null;
    const n = parseFloat(s.replace(',', '.'));
    return isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : null;
}

/** Рецензии пишут люди в веб-форме: попадаются теги, &nbsp; и вереницы пустых строк. */
function cleanText(s) {
    return String(s || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&laquo;/g, '«').replace(/&raquo;/g, '»')
        .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–').replace(/&hellip;/g, '…')
        .replace(/&#(\d+);/g, (m, c) => String.fromCharCode(+c))
        .replace(/&amp;/g, '&')
        .replace(/\r/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function createKinopoisk({ getKey, file, log }) {
    let cache = { v: 1, items: {} };
    let saveTimer = null;
    const reviewCache = new Map();  // 'id|page|order' -> {t, data}
    let chain = Promise.resolve();
    let lastSearch = 0;
    let quotaHit = null;

    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (raw && raw.items) cache = raw;
    } catch (e) { /* первого запуска ещё не было */ }

    function enabled() { return !!String(getKey() || '').trim(); }

    function saveSoon() {
        if (saveTimer) return;
        saveTimer = setTimeout(() => {
            saveTimer = null;
            try {
                const keys = Object.keys(cache.items);
                if (keys.length > MAX_ITEMS) {
                    keys.sort((a, b) => cache.items[a].t - cache.items[b].t)
                        .slice(0, keys.length - MAX_ITEMS).forEach(k => delete cache.items[k]);
                }
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, JSON.stringify(cache));
            } catch (e) {
                log(`Кинопоиск: кеш не сохранён: ${e.message}`);
            }
        }, SAVE_DELAY_MS);
        if (saveTimer.unref) saveTimer.unref();
    }

    async function get(endpoint, params) {
        const u = new URL(API + endpoint);
        Object.keys(params || {}).forEach(k => {
            if (params[k] !== null && params[k] !== undefined && params[k] !== '') u.searchParams.set(k, params[k]);
        });
        const res = await fetch(u, {
            headers: { 'X-API-KEY': String(getKey()).trim(), accept: 'application/json' },
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
        if (res.status === 401) throw new Error('ключ не принят (401)');
        if (res.status === 402) throw new Error('квота ключа исчерпана (402)');
        if (res.status === 429) throw new Error('слишком часто (429)');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
    }

    /** Поиск сериализован: 5 запросов/сек — это лимит, за которым идёт 429. */
    function searchThrottled(keyword) {
        const run = chain.then(async () => {
            const wait = SEARCH_GAP_MS - (Date.now() - lastSearch);
            if (wait > 0) await new Promise(r => setTimeout(r, wait));
            lastSearch = Date.now();
            return get('/api/v2.1/films/search-by-keyword', { keyword });
        });
        chain = run.then(() => {}, () => {});
        return run;
    }

    /** Лучший кандидат поиска или null — та же сверка ChannelMatch, что у каналов и у TMDB. */
    function pick(films, title, year) {
        const qa = ChannelMatch.analyze(title, false);
        const nq = norm(title);
        let best = null;
        (films || []).slice(0, 8).forEach((f, order) => {
            const names = [f.nameRu, f.nameEn, f.nameOriginal].filter(Boolean);
            if (!names.length) return;
            let s = Math.max(...names.map(n => norm(n) === nq ? 1 : ChannelMatch.score(qa, ChannelMatch.analyze(n, false))));
            // тот же расчёт, что в tmdb.js: разница в пару лет законна (прокат, озвучка), а
            // большая — это обычно ремейк с тем же названием, и чужой рейтинг хуже, чем никакой
            const ry = yearOf(f.year);
            if (year && ry) {
                const diff = Math.abs(ry - year);
                s += diff <= 1 ? 0.15 : diff <= 3 ? -0.1 : -0.5;
            }
            if (!best || s > best.s || (s === best.s && order < best.order)) best = { f, s, order };
        });
        return best && best.s >= MIN_SCORE ? best.f : null;
    }

    /** Карточка фильма из ответа /films/{id} (full) и/или строки поиска (f) — одна форма для enrich и film. */
    function card(id, full, f) {
        f = f || {};
        const rating = full ? parseRating(full.ratingKinopoisk) : parseRating(f.rating);
        const votes = (full ? full.ratingKinopoiskVoteCount : f.ratingVoteCount) || 0;
        const genres = ((full && full.genres) || f.genres || []).map(g => g && g.genre).filter(Boolean);
        return {
            id,
            kind: (full ? (full.serial || SERIES_TYPES[full.type]) : SERIES_TYPES[f.type]) ? 'series' : 'movie',
            title: (full && (full.nameRu || full.nameOriginal)) || f.nameRu || f.nameEn || '',
            originalTitle: (full && (full.nameOriginal || full.nameEn)) || f.nameEn || '',
            year: (full && full.year) || yearOf(f.year),
            rating: rating && votes >= MIN_VOTES ? rating : null,
            votes,
            imdbRating: full ? parseRating(full.ratingImdb) : null,
            genres,
            description: cleanText(full ? (full.description || full.shortDescription) : ''),
            reviews: (full && full.reviewsCount) || 0,
            poster: (full && full.posterUrl) || f.posterUrl || null,
            posterPreview: (full && full.posterUrlPreview) || f.posterUrlPreview || null,
            url: (full && full.webUrl) || `https://www.kinopoisk.ru/film/${id}/`
        };
    }

    /** Фильм по номеру Кинопоиска (ссылка kinopoisk.ru/film/123) → то же, что enrich, или null. */
    async function film(id) {
        id = parseInt(id, 10);
        if (!enabled() || !(id > 0)) return null;
        try {
            return card(id, await get(`/api/v2.2/films/${id}`, {}));
        } catch (e) {
            log(`Кинопоиск: фильм ${id}: ${e.message}`);
            return null;
        }
    }

    /** Фильм по ссылке IMDb (tt0133093) → то же, что enrich, или null. */
    async function byImdb(imdbId) {
        if (!enabled() || !/^tt\d+$/.test(String(imdbId || ''))) return null;
        try {
            const d = await get('/api/v2.2/films', { imdbId });
            const f = d && d.items && d.items[0];
            return f && f.kinopoiskId ? film(f.kinopoiskId) : null;
        } catch (e) {
            log(`Кинопоиск: IMDb ${imdbId}: ${e.message}`);
            return null;
        }
    }

    /**
     * Метаданные по названию и году → {id, kind, rating, votes, imdbRating, genres, description,
     * reviews, year, title, poster, url} или null. title должен быть очищен (vod.cleanTitle).
     */
    async function enrich({ title, year, kind }) {
        if (!enabled() || !title) return null;
        const key = [kind === 'series' ? 'tv' : 'movie', norm(title), year || ''].join('|');
        const hit = cache.items[key];
        if (hit && Date.now() - hit.t < (hit.data ? TTL_MS : TTL_MISS_MS)) return hit.data;

        let data = null;
        try {
            const found = await searchThrottled(title);
            const f = pick(found.films, title, year);
            if (f) {
                const id = f.filmId;
                // вторым запросом — карточка: в поиске рейтинг приходит строкой и без числа рецензий,
                // а число рецензий решает, показывать ли на телевизоре кнопку «Рецензии»
                const full = await get(`/api/v2.2/films/${id}`, {}).catch(e => {
                    log(`Кинопоиск: карточка ${id}: ${e.message}`);
                    return null;
                });
                data = card(id, full, f);
            }
        } catch (e) {
            log(`Кинопоиск: «${title}»: ${e.message}`);
            return hit ? hit.data : null;   // сеть отвалилась — лучше просроченный кеш, чем пусто
        }
        cache.items[key] = { t: Date.now(), data };
        saveSoon();
        return data;
    }

    /**
     * Рецензии зрителей → {total, pages, positive, negative, neutral, page, items:[…]}.
     * По умолчанию сверху те, что сочли полезными больше всего, — читать стоит их, а не свежие.
     */
    async function reviews(id, { page = 1, order = 'USER_POSITIVE_RATING_DESC' } = {}) {
        const empty = { total: 0, pages: 0, positive: 0, negative: 0, neutral: 0, page: 1, perPage: REVIEWS_PER_PAGE, items: [] };
        if (!enabled() || !id) return empty;
        const ck = `${id}|${page}|${order}`;
        const hit = reviewCache.get(ck);
        if (hit && Date.now() - hit.t < REVIEW_TTL_MS) return hit.data;
        try {
            const d = await get(`/api/v2.2/films/${id}/reviews`, { page, order });
            const data = {
                total: d.total || 0,
                pages: d.totalPages || 0,
                positive: d.totalPositiveReviews || 0,
                negative: d.totalNegativeReviews || 0,
                neutral: d.totalNeutralReviews || 0,
                page,
                perPage: REVIEWS_PER_PAGE,
                items: (d.items || []).map(r => ({
                    id: r.kinopoiskId,
                    type: String(r.type || 'unknown').toLowerCase(),   // positive | negative | neutral | unknown
                    author: r.author || '',
                    title: cleanText(r.title),
                    text: cleanText(r.description),
                    date: (r.date || '').slice(0, 10),
                    helpful: r.positiveRating || 0,
                    notHelpful: r.negativeRating || 0
                })).filter(r => r.text)
            };
            reviewCache.set(ck, { t: Date.now(), data });
            if (reviewCache.size > REVIEW_CACHE) reviewCache.delete(reviewCache.keys().next().value);
            return data;
        } catch (e) {
            log(`Кинопоиск: рецензии ${id}: ${e.message}`);
            return hit ? hit.data : empty;
        }
    }

    /**
     * Остаток квоты ключа — чтобы «рейтинги вдруг пропали» не приходилось выяснять вслепую.
     * Ответ держим QUOTA_TTL_MS: /status открывают часто, а сам этот запрос тоже тратит квоту.
     */
    async function quota() {
        if (!enabled()) return null;
        if (quotaHit && Date.now() - quotaHit.t < QUOTA_TTL_MS) return quotaHit.data;
        try {
            const d = await get(`/api/v1/api_keys/${encodeURIComponent(String(getKey()).trim())}`, {});
            const q = x => x ? { value: x.value, used: x.used } : null;
            const data = { total: q(d.totalQuota), daily: q(d.dailyQuota) };
            quotaHit = { t: Date.now(), data };
            return data;
        } catch (e) {
            log(`Кинопоиск: квота: ${e.message}`);
            return null;
        }
    }

    return { enabled, enrich, film, byImdb, reviews, quota, MIN_SCORE };
}

module.exports = { createKinopoisk, cleanText, parseRating, yearOf };
