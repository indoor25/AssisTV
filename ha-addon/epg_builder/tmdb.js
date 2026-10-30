/**
 * Рейтинги, жанры и описания фильмов с TMDB (themoviedb.org) — в API видеопортала их нет
 * (у портала рейтинга нет). Рядом работает kinopoisk.js — русская оценка и рецензии; TMDB остаётся
 * ради мирового каталога, который Кинопоиск знает хуже. Отзывы TMDB не берём: их единицы и
 * по-английски, рецензии читаем с Кинопоиска.
 *
 * Ключ — опция аддона `tmdb_key` (в настройках TMDB это «API Key (v3 auth)», 32 символа, не v4-токен).
 * Ключа нет — модуль молча выключен, карточка фильма выглядит как раньше. Любая ошибка сети или разбора
 * тоже даёт null: рейтинг — украшение, из-за него карточка открываться не перестаёт.
 *
 * Как ищется соответствие: портал даёт только название и год, поэтому TMDB опрашивается поиском
 * (/search/movie или /search/tv) и результат сверяется тем же ChannelMatch, что и каналы, — названия
 * расходятся («Матрица» / «The Matrix», «Игра престолов. Сезон 8» / «Game of Thrones»). Совпадение
 * ниже MIN_SCORE считается промахом: лучше без рейтинга, чем чужой рейтинг.
 *
 * Кеш — /data/tmdb.json (найденное 30 дней, промахи 7: у TMDB пополняется база, а у портала правятся
 * названия). Без кеша каждое открытие карточки — два запроса в интернет с телевизора в спальне.
 */
const fs = require('fs');
const path = require('path');

function requireShared(name) {
    const local = path.join(__dirname, 'shared', name);
    return require(fs.existsSync(local) ? local : path.join(__dirname, '..', '..', 'js', name));
}
const ChannelMatch = requireShared('channel-match.js');

const API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/w500';
const TTL_MS = 30 * 24 * 3600e3;
const TTL_MISS_MS = 7 * 24 * 3600e3;
const MAX_ITEMS = 3000;
const MIN_SCORE = 0.6;
// у свежих и редких фильмов рейтинг ставят несколько человек — «10.0» по трём голосам показывать нечестно
const MIN_VOTES = 10;
const TIMEOUT_MS = 8000;
const SAVE_DELAY_MS = 5000;

// язык аддона → язык TMDB (описания и названия жанров приходят на нём)
const LANGS = { ru: 'ru-RU', en: 'en-US', uk: 'uk-UA', de: 'de-DE' };

const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function createTmdb({ getKey, getLang, file, log }) {
    let cache = { v: 1, items: {} };
    let saveTimer = null;
    const genreCache = new Map();   // 'movie|ru-RU' -> {id: название}

    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (raw && raw.items) cache = raw;
    } catch (e) { /* первого запуска ещё не было */ }

    function enabled() { return !!String(getKey() || '').trim(); }

    function lang() { return LANGS[getLang()] || LANGS.en; }

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
                log(`TMDB: кеш не сохранён: ${e.message}`);
            }
        }, SAVE_DELAY_MS);
        if (saveTimer.unref) saveTimer.unref();
    }

    async function get(endpoint, params) {
        const u = new URL(API + endpoint);
        u.searchParams.set('api_key', String(getKey()).trim());
        Object.keys(params || {}).forEach(k => {
            if (params[k] !== null && params[k] !== undefined && params[k] !== '') u.searchParams.set(k, params[k]);
        });
        const res = await fetch(u, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
    }

    /** {id: название} для kind ('movie' | 'series'); список у TMDB меняется редко — держим в памяти. */
    async function genreMap(kind) {
        const type = kind === 'series' ? 'tv' : 'movie';
        const key = type + '|' + lang();
        if (genreCache.has(key)) return genreCache.get(key);
        const data = await get(`/genre/${type}/list`, { language: lang() });
        const map = {};
        (data.genres || []).forEach(g => { map[g.id] = g.name; });
        genreCache.set(key, map);
        return map;
    }

    /** Лучший кандидат поиска TMDB или null. */
    function pick(results, title, year) {
        const qa = ChannelMatch.analyze(title, false);
        const nq = norm(title);
        let best = null;
        (results || []).slice(0, 8).forEach((r, order) => {
            const names = [r.title, r.name, r.original_title, r.original_name].filter(Boolean);
            if (!names.length) return;
            let s = Math.max(...names.map(n => {
                if (norm(n) === nq) return 1;
                return ChannelMatch.score(qa, ChannelMatch.analyze(n, false));
            }));
            const date = r.release_date || r.first_air_date || '';
            const ry = date ? +date.slice(0, 4) : null;
            // Год расходится на год-два законно (прокат / выход на ТВ / год озвучки у портала), а вот
            // разница побольше — это обычно ремейк с тем же названием («Дюна» 1984 и 2021, «Солярис»
            // 1972 и 2002). Штраф 0.5 валит даже точное совпадение названия: чужой рейтинг хуже, чем
            // никакого.
            if (year && ry) {
                const diff = Math.abs(ry - year);
                s += diff <= 1 ? 0.15 : diff <= 3 ? -0.1 : -0.5;
            }
            if (!best || s > best.s || (s === best.s && order < best.order)) best = { r, s, order };
        });
        return best && best.s >= MIN_SCORE ? best.r : null;
    }

    /**
     * Метаданные по названию и году → {id, kind, rating, votes, genres:[…], overview, poster, url} или null.
     * title должен быть уже очищен (vod.cleanTitle): без «[HDR]», «4K» и номера сезона.
     */
    async function enrich({ title, year, kind }) {
        if (!enabled() || !title) return null;
        const key = [kind === 'series' ? 'tv' : 'movie', norm(title), year || '', lang()].join('|');
        const hit = cache.items[key];
        if (hit && Date.now() - hit.t < (hit.data ? TTL_MS : TTL_MISS_MS)) return hit.data;

        let data = null;
        try {
            const type = kind === 'series' ? 'tv' : 'movie';
            const alt = type === 'tv' ? 'movie' : 'tv';
            const yearKey = type === 'tv' ? 'first_air_date_year' : 'year';
            // year у TMDB — жёсткий фильтр, а год у портала бывает неточным, поэтому при пустом ответе
            // тот же тип переспрашивается без года (год всё равно учтён оценкой). Последняя попытка —
            // второй тип: сериалы портала нередко заведены как фильмы и наоборот.
            const attempts = [
                { type, params: year ? { [yearKey]: year } : null },
                ...(year ? [{ type, params: null }] : []),
                { type: alt, params: null }
            ];
            let r = null;
            let rtype = type;
            for (const a of attempts) {
                const found = await get(`/search/${a.type}`,
                    Object.assign({ query: title, language: lang(), include_adult: 'false' }, a.params || {}));
                r = pick(found.results, title, year);
                if (r) { rtype = a.type; break; }
            }
            if (r) {
                const rkind = rtype === 'tv' ? 'series' : 'movie';
                const genres = await genreMap(rkind).catch(() => ({}));
                const date = r.release_date || r.first_air_date || '';
                data = {
                    id: r.id,
                    kind: rkind,
                    title: r.title || r.name || '',
                    year: date ? +date.slice(0, 4) : null,
                    rating: r.vote_average && (r.vote_count || 0) >= MIN_VOTES ? Math.round(r.vote_average * 10) / 10 : null,
                    votes: r.vote_count || 0,
                    genres: (r.genre_ids || []).map(id => genres[id]).filter(Boolean),
                    overview: r.overview || '',
                    poster: r.poster_path ? IMG + r.poster_path : null,
                    url: `https://www.themoviedb.org/${rkind === 'series' ? 'tv' : 'movie'}/${r.id}`
                };
            }
        } catch (e) {
            log(`TMDB: «${title}»: ${e.message}`);
            return hit ? hit.data : null;   // сеть отвалилась — лучше просроченный кеш, чем пусто
        }
        cache.items[key] = { t: Date.now(), data };
        saveSoon();
        return data;
    }

    return { enabled, enrich, MIN_SCORE };
}

module.exports = { createTmdb };
