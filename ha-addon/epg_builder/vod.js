/**
 * Поиск фильмов и сериалов у источников (плагинов) — для карточки HA и голосовых команд.
 *
 * Клиенты источников — те же файлы, что выполняет телевизор (js/vod-sources/*.js, в контейнере —
 * shared/vod-sources/ плюс доустановленные, см. plugins.js); здесь они берутся из реестра VodSources.
 * Портал ищет только подстрокой и без учёта словоформ («матрицу» ничего не находит), поэтому запрос
 * чистится от служебных слов («найди фильм …»), при малом числе результатов повторяется с отрезанными
 * окончаниями и по отдельным словам, а результаты ранжируются ChannelMatch.score (фонетика, опечатки)
 * по названию и году.
 *
 * Идентификатор фильма наружу — составной: «portal:48357» (источник и его собственный id), запись без
 * источника означает portal — так продолжают работать избранное, история и команды vod_play, записанные
 * до появления плагинов.
 *
 * search ищет в ОДНОМ источнике (по умолчанию — первом настроенном): в карточке и на телевизоре результаты
 * разных источников не смешиваются, у каждого свои идентификаторы и своя озвучка. Голосу всё равно, откуда
 * фильм, — для него searchAll обходит источники по очереди до первого уверенного совпадения.
 *
 * Постеры портал отдаёт только по http (https не отвечает), а HA открывают и по https — картинки с http там
 * заблокированы. Поэтому аддон кладёт постеры в /local/tizen-iptv/posters/<id>.jpg (не больше MAX_POSTERS).
 */
const fs = require('fs');
const path = require('path');

function requireShared(name) {
    const local = path.join(__dirname, 'shared', name);
    return require(fs.existsSync(local) ? local : path.join(__dirname, '..', '..', 'js', name));
}
const { VodSources } = requireShared('vod-sources.js');
const ChannelMatch = requireShared('channel-match.js');

const MAX_POSTERS = 600;
const MIN_SCORE = 0.55;   // ниже — «не нашёл», для голоса лучше переспросить, чем включить не то
const STRONG_SCORE = 0.9; // название совпало почти дословно — в остальных источниках можно не искать

// слова голосовой фразы, которые к названию не относятся (ru; ниже — uk, en, de; как добавить язык — docs/voice-search.md)
const STOP_WORDS = new Set(('найди найти поищи поиск включи включить поставь покажи запусти открой хочу посмотреть смотреть ' +
    'мне нам пожалуйста фильм фильмы фильма кино киношку сериал сериала сериалы мультфильм мультфильма мультик ' +
    'мультсериал аниме в на по из портале портала телевизоре телевизор тв и с про ' +
    'знайди увімкни покажи хочу подивитися дивитися будь ласка фільм фільми кіно серіал мультфільм телевізорі ' +
    'find search play watch show put on start open want to me please the a movie film series show cartoon tv ' +
    'finde suche spiele zeige starte öffne ich will mir bitte den die das einen film serie zeichentrickfilm fernseher im auf').split(' '));
// «сезон 3», «season 3», «Staffel 3»
const SEASON_RE = /^(сезон|season|staffel)/;

const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** «Матрица 2: Перезагрузка [HDR]» → «Матрица 2: Перезагрузка», «Игра престолов. Сезон 8.» → без сезона. */
function cleanTitle(title) {
    return String(title || '').replace(/\[[^\]]*\]/g, ' ').replace(/\b(4k|uhd|hdr|fhd)\b/gi, ' ')
        // \b в JS — только для латиницы, поэтому «сезон» ограничиваем пробелом или точкой
        .replace(/(^|[\s.])сезон\s*\d+\.?/gi, ' ')
        .replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim();
}

/** Грубое отрезание русских окончаний: «матрицу» → «матриц», «престолов» → «престол». */
function stem(word) {
    if (word.length <= 4 || !/[а-я]/.test(word)) return word;
    const cut = word.replace(/(ами|ями|ого|его|ому|ему|ыми|ими|ов|ев|ей|ой|ий|ый|ая|яя|ое|ее|ую|юю|ам|ям|ах|ях|ом|ем|а|я|у|ю|ы|и|е|о)$/, '');
    return cut.length >= 4 ? cut : word.slice(0, 4);
}

const ORDINALS = ['перв', 'втор', 'трет', 'четверт', 'пят', 'шест', 'седьм', 'восьм', 'девят', 'десят'];

// «в 4К», «1080p», «full hd» — качество, а не часть названия. Значение — высота кадра, как в variants источника.
const QUALITY_WORDS = {
    '4k': '2160', '4к': '2160', uhd: '2160', ultrahd: '2160', '2160p': '2160', '2160': '2160',
    '2k': '1440', '2к': '1440', '1440p': '1440',
    fhd: '1080', fullhd: '1080', '1080p': '1080', '1080': '1080',
    '720p': '720', '720': '720', '480p': '480'
};
const QUALITY_FULL = /^(full|фул|фулл)$/;
const QUALITY_HD = /^(hd|хд)$/;
const QUALITY_NOUN = /^(качеств|quality|qualität|якост)/;
const QUALITY_BEST = /^(лучш|наилучш|максимал|высок|высш|хорош|отличн|найкращ|найвищ|best|highest|high|max|top|beste|höchste)/;
const QUALITY_WORST = /^(низк|плох|минимал|худш|низьк|поган|lowest|low|worst|min|niedrig)/;

/**
 * Качество из слов: {words (без слов о качестве), quality: '2160'|'1440'|'1080'|'720'|'480'|'max'|'min'|null, hdr}.
 * loose — разбирается не фраза, а отдельное поле «качество»: там «hd» и «sd» тоже значат качество,
 * а в названии фильма одинокое «hd» трогать нельзя.
 */
function extractQuality(words, loose) {
    let quality = null;
    let hdr = false;
    const out = [];
    for (let i = 0; i < words.length; i++) {
        const w = words[i];
        const next = words[i + 1] || '';
        if (w === 'hdr') { hdr = true; continue; }
        if ((QUALITY_FULL.test(w) || w === 'ultra' || w === 'ультра') && QUALITY_HD.test(next)) {
            quality = QUALITY_FULL.test(w) ? '1080' : '2160';
            i++;
            continue;
        }
        if (QUALITY_WORDS[w]) { quality = QUALITY_WORDS[w]; continue; }
        // «в лучшем качестве», «в плохом качестве»; само слово «качестве» к названию не относится
        if ((QUALITY_BEST.test(w) || QUALITY_WORST.test(w)) && (loose || QUALITY_NOUN.test(next))) {
            quality = quality || (QUALITY_BEST.test(w) ? 'max' : 'min');
            continue;
        }
        if (QUALITY_NOUN.test(w)) continue;
        if (loose && QUALITY_HD.test(w)) { quality = quality || '720'; continue; }
        if (loose && (w === 'sd' || w === '480')) { quality = quality || '480'; continue; }
        out.push(w);
    }
    return { words: out, quality, hdr };
}

/** Поле «качество» из запроса (его заполняет ассистент: «4K», «1080p», «best») → {quality, hdr}. */
function parseQuality(value) {
    const r = extractQuality(norm(value).split(' ').filter(Boolean), true);
    return { quality: r.quality, hdr: r.hdr };
}

/** Запрос → {text, year, season, words, quality, hdr}: год, сезон и качество отдельно, служебные слова убраны. */
function parseQuery(query) {
    let words = norm(query).split(' ').filter(Boolean);
    let year = null;
    let season = null;
    // качество — первым: «2160» и «1080» иначе сошли бы за часть названия
    const ql = extractQuality(words, false);
    if (ql.words.length) words = ql.words;
    // «3 сезон», «сезон 3», «третий сезон»
    const si = words.findIndex(w => SEASON_RE.test(w));
    if (si >= 0) {
        const near = [words[si + 1], words[si - 1]];
        for (const w of near) {
            if (!w) continue;
            const n = /^\d{1,2}$/.test(w) ? +w : ORDINALS.findIndex(o => w.startsWith(o)) + 1;
            if (n > 0) { season = n; words = words.filter(x => x !== w); break; }
        }
        words = words.filter(w => !SEASON_RE.test(w));
    }
    words = words.filter(w => {
        if (/^(19|20)\d\d$/.test(w)) { year = +w; return false; }
        if (/^(года?|году)$/.test(w)) return false;
        return true;
    });
    const meaningful = words.filter(w => !STOP_WORDS.has(w));
    if (meaningful.length) words = meaningful;
    return { text: words.join(' '), year, season, words, quality: ql.quality, hdr: ql.hdr };
}

function seasonOf(title) {
    const m = /сезон\s*(\d+)/i.exec(title || '');
    return m ? +m[1] : null;
}

/**
 * getSourceUrls() → адреса настроенных источников (плейлисты kind: 'vod'), в порядке настроек;
 * clientFor(url, тип) → клиент источника из песочницы (sandbox.js): те же методы плагина, все асинхронные.
 * Источников может не быть вообще — тогда поиск отвечает no_portal, как и раньше при пустом портале.
 */
function createVod({ getSourceUrls, clientFor, wwwDir, log, tmdb, kp }) {
    const clients = {};   // тип источника -> {url, client, root}

    /** Клиент источника по его типу; без типа — первый настроенный. */
    async function source(type) {
        const urls = getSourceUrls() || [];
        const url = type
            ? urls.find(u => { const p = VodSources.parseUrl(u); return p && p.type === type; })
            : urls[0];
        if (!url) throw new Error('no_portal');
        const t = VodSources.parseUrl(url).type;
        let c = clients[t];
        if (!c || c.url !== url) {
            c = clients[t] = { url, client: clientFor(url, t), root: null };
        }
        if (!c.root) c.root = await c.client.root();
        return c;
    }

    async function sourceSearch(text, type) {
        const c = await source(type);
        const page = await c.client.page(await c.client.searchRequest(c.root, text));
        return { items: page.items, type: c.client.sourceType };
    }

    // ───────── постеры ─────────
    const postersDir = path.join(wwwDir, 'posters');
    const posterJobs = new Map();
    let pinnedPosters = new Set();

    /** Имя файла постера: «portal:48357» → portal_48357.jpg (в имени файла двоеточию не место). */
    const posterName = id => String(id).replace(/[^\w-]+/g, '_');

    /** Постеры избранного остаются в кеше, даже когда каталог заполнил его новыми картинками. */
    function setPinnedPosters(ids) {
        pinnedPosters = new Set((ids || []).filter(id => id != null).map(posterName));
    }

    /** Файл в кеше и адрес для него; старый /local-путь из favorites.json не доказывает наличие файла. */
    function cachedPoster(id) {
        if (id == null) return null;
        const name = posterName(id);
        return fs.existsSync(path.join(postersDir, `${name}.jpg`))
            ? `/local/tizen-iptv/posters/${name}.jpg`
            : null;
    }

    async function poster(id, url) {
        if (!url || id == null) return null;
        const fid = posterName(id);
        const file = path.join(postersDir, `${fid}.jpg`);
        const cached = cachedPoster(id);
        const local = `/local/tizen-iptv/posters/${fid}.jpg`;
        if (cached) return cached;
        if (!posterJobs.has(fid)) {
            posterJobs.set(fid, (async () => {
                try {
                    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    fs.mkdirSync(postersDir, { recursive: true });
                    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
                    return local;
                } catch (e) {
                    return null;
                } finally {
                    posterJobs.delete(fid);
                }
            })());
        }
        return posterJobs.get(fid);
    }

    function prunePosters() {
        try {
            const files = fs.readdirSync(postersDir).map(f => ({ f, t: fs.statSync(path.join(postersDir, f)).mtimeMs }));
            if (files.length <= MAX_POSTERS) return;
            const unpinned = files.filter(x => !pinnedPosters.has(x.f.replace(/\.jpg$/i, '')));
            unpinned.sort((a, b) => a.t - b.t).slice(0, Math.min(unpinned.length, files.length - MAX_POSTERS))
                .forEach(x => fs.unlinkSync(path.join(postersDir, x.f)));
        } catch (e) { /* папки ещё нет */ }
    }

    /** src — тип источника; fid оставлен рядом с id: его шлёт карточка HA и старые команды vod_play. */
    function itemPublic(i, localPoster, s, src) {
        const kind = i.type === 'multistream' ? 'series' : 'movie';
        return {
            id: VodSources.makeId(src, i.fid), src: src || VodSources.DEFAULT_TYPE, fid: i.fid,
            title: i.title, year: i.year || null, kind, season: seasonOf(i.title),
            quality: i.uhd ? (i.hdr ? '4K HDR' : '4K') : i.hdr ? 'HDR' : '',
            poster: localPoster, score: s == null ? undefined : Math.round(s * 100) / 100
        };
    }

    /**
     * → { query, text, year, results: [{fid, title, year, kind: movie|series, season, quality, poster, score}] }
     * results отсортированы по score; best — первый, если он уверенный.
     */
    async function search(query, { limit = 12, src, quality } = {}) {
        const q = parseQuery(query);
        // качество отдельным полем (его заполняет ассистент) важнее найденного во фразе
        const asked = quality ? parseQuality(quality) : {};
        const wanted = asked.quality || q.quality || null;
        const wantHdr = !!(asked.hdr || q.hdr);
        const wantUhd = wanted === '2160' || wanted === 'max';
        if (!q.text) return { query, text: '', year: q.year, season: q.season, quality: wanted, hdr: wantHdr, src: src || null, results: [], best: null };
        const found = new Map();   // fid -> item
        const add = items => items.forEach(i => { if (i.fid != null && !found.has(i.fid)) found.set(i.fid, i); });
        let type = src || null;

        // по порядку, пока результатов мало: вся фраза → без окончаний → самое длинное слово без окончания
        const attempts = [q.text];
        const stemmed = q.words.map(stem).join(' ');
        if (stemmed !== q.text) attempts.push(stemmed);
        const longest = q.words.slice().sort((a, b) => b.length - a.length)[0];
        if (q.words.length > 1 && longest && longest.length >= 4) attempts.push(stem(longest));
        for (const text of attempts) {
            if (found.size >= 5) break;
            try {
                const r = await sourceSearch(text, src);
                type = r.type;
                add(r.items);
            } catch (e) {
                if (e.message === 'no_portal') throw e;
                log(`источник ${src || ''}: поиск «${text}»: ${e.message}`);
            }
        }

        const qa = ChannelMatch.analyze(q.text, false);
        const nq = norm(q.text);
        const scored = [...found.values()].map((i, order) => {
            const t = cleanTitle(i.title);
            let s = ChannelMatch.score(qa, ChannelMatch.analyze(t, false));
            if (norm(t) === nq) s = Math.max(s, 1);
            else if (norm(t).startsWith(nq)) s = Math.max(s, 0.8);
            if (q.year) s += i.year === q.year ? 0.2 : -0.1;
            const season = seasonOf(i.title);
            if (q.season) s += season === q.season ? 0.2 : season ? -0.15 : 0;
            // 4K и HDR у портала — отдельные записи того же фильма: при прочих равных — обычная версия,
            // а если просили «в 4К» или «в HDR» — именно такая
            const uhd = !!i.uhd || /\b4k\b|\buhd\b/i.test(i.title);
            const hdr = !!i.hdr || /\bhdr\b/i.test(i.title);
            if (uhd || hdr) s += (uhd && wantUhd) || (hdr && wantHdr) ? 0.03 : -0.01;
            return { i, s, order, season };
        })
            // одинаково похожие сезоны одного сериала — по порядку сезонов, без номера сезона — первым
            .sort((a, b) => (Math.round(b.s * 100) - Math.round(a.s * 100)) ||
                ((a.season || 0) - (b.season || 0)) || a.order - b.order)
            .slice(0, limit);

        const results = await Promise.all(scored.map(async x =>
            itemPublic(x.i, await poster(VodSources.makeId(type, x.i.fid), x.i.poster), x.s, type)));
        prunePosters();
        return {
            query, text: q.text, year: q.year, season: q.season, quality: wanted, hdr: wantHdr, src: type, results,
            best: results[0] && results[0].score >= MIN_SCORE ? results[0] : null
        };
    }

    /** Типы настроенных источников в порядке настроек. */
    function sourceTypes() {
        const types = [];
        (getSourceUrls() || []).forEach(u => {
            const p = VodSources.parseUrl(u);
            if (p && types.indexOf(p.type) < 0) types.push(p.type);
        });
        return types;
    }

    /**
     * Поиск по всем источникам по очереди (голос: «включи фильм …»). Название совпало почти дословно
     * (STRONG_SCORE) — дальше не ищем; иначе опрашиваются все и берётся источник с лучшим совпадением.
     * Нигде не нашлось уверенно — похожие из всех источников вместе, лучшие первыми (у каждого свой src,
     * так что включить по id можно любой).
     * → то же, что search, плюс tried — где искали, all — похожие из всех опрошенных источников.
     */
    async function searchAll(query, o = {}) {
        const types = sourceTypes();
        if (!types.length) throw new Error('no_portal');
        const limit = o.limit || 12;
        const tried = [];
        let last = null;
        let chosen = null;
        let similar = [];
        for (const src of types) {
            const r = await search(query, Object.assign({}, o, { src, limit }));
            tried.push(src);
            last = r;
            similar = similar.concat(r.results);
            // слабое совпадение («абракадабра» → «Скуби-Ду! Абракадабра-Ду») — не повод не заглянуть дальше:
            // у следующего источника может быть фильм ровно с таким названием. При равенстве — более ранний.
            if (r.best && (!chosen || r.best.score > chosen.best.score)) chosen = r;
            if (chosen && chosen.best.score >= STRONG_SCORE) break;
        }
        // all — похожие из всех опрошенных источников, лучшие первыми (у каждого свой src)
        similar.sort((a, b) => (b.score || 0) - (a.score || 0));
        const all = similar.slice(0, limit);
        if (chosen) return Object.assign(chosen, { tried, all });
        return Object.assign(last, { src: null, results: all, best: null, tried, all });
    }

    /**
     * Метаданные TMDB по названию и году → {rating, votes, genres, tmdbId, tmdbUrl, description?} или {}.
     * Описание берётся только когда своего нет: у портала оно про эту озвучку и версию, оно ближе к делу.
     */
    async function meta({ title, year, kind, description }) {
        const q = { title: cleanTitle(title), year: year || null, kind };
        // оба источника спрашиваются разом: у советского и русского кино голосов на TMDB почти нет,
        // а Кинопоиск не знает части мирового каталога — что ответило, то и показываем
        const [k, m] = await Promise.all([
            kp && kp.enabled() ? kp.enrich(q).catch(() => null) : null,
            tmdb && tmdb.enabled() ? tmdb.enrich(q).catch(() => null) : null
        ]);
        if (!k && !m) return {};
        const out = {};
        if (m) Object.assign(out, {
            rating: m.rating, votes: m.votes, genres: m.genres,
            tmdbId: m.id, tmdbKind: m.kind, tmdbUrl: m.url
        });
        // жанры Кинопоиска важнее: они по-русски и единообразно строчными, а у TMDB русские жанры
        // сериалов приходят вразнобой («НФ и Фэнтези» рядом с «драма»)
        if (k) Object.assign(out, {
            kpRating: k.rating, kpVotes: k.votes, kpId: k.id, kpKind: k.kind,
            kpUrl: k.url, kpReviews: k.reviews
        }, k.genres && k.genres.length ? { genres: k.genres } : {});
        // описание портала важнее обоих — оно про эту версию и озвучку; дальше русское с КП, потом TMDB
        const extra = (k && k.description) || (m && m.overview) || '';
        if (!description && extra) out.description = extra;
        // как фильм называется в каталоге — для ответа голосом (info), карточке это не нужно
        out.metaTitle = (k && k.title) || (m && m.title) || '';
        out.metaYear = (k && k.year) || (m && m.year) || null;
        return out;
    }

    /**
     * Рейтинг и описание по названию, как его сказали («какой рейтинг у Матрицы», «о чём фильм …») →
     * {title, year, kind, kpRating, kpVotes, rating (TMDB), votes, genres, description, available, id} или null.
     * Фильм не обязан быть у источников: спрашиваются Кинопоиск и TMDB, а источники — только чтобы сказать,
     * можно ли его включить (available, id), и подсказать точное название, если каталоги сказанное не узнали.
     */
    async function info(query) {
        const q = parseQuery(query);
        if (!q.text) return null;
        let found = null;
        try {
            found = (await searchAll(query, { limit: 1 })).best;
        } catch (e) { /* источников нет или молчат — рейтинг это не отменяет */ }
        let m = await meta({ title: q.text, year: q.year, kind: found ? found.kind : 'movie' });
        if (!m.metaTitle && found) m = await meta({ title: found.title, year: found.year, kind: found.kind });
        if (!m.metaTitle) return null;
        return {
            title: m.metaTitle, year: m.metaYear, kind: m.kpKind || m.tmdbKind || (found && found.kind) || 'movie',
            kpRating: m.kpRating || null, kpVotes: m.kpVotes || 0, rating: m.rating || null, votes: m.votes || 0,
            genres: m.genres || [], description: m.description || '',
            available: !!found, id: found ? found.id : null, sourceTitle: found ? found.title : null
        };
    }

    /**
     * Фильм или сериал по составному id («portal:48357»; без источника — portal) →
     * {id, src, fid, title, year, kind, duration, description, quality, poster, rating, votes, genres,
     *  streams: [{id, name}], episodes: [{id, fid, title}]}
     *
     * streams — озвучки: у портала всегда одна (карточка рисует одну кнопку «Смотреть», как и раньше),
     * у источника с несколькими переводами — по кнопке на каждую.
     */
    async function details(id) {
        const { type, localId } = VodSources.splitId(id);
        const c = await source(type);
        const d = await c.client.details(await c.client.itemById(localId));
        const i = d.item;
        const src = c.client.sourceType;
        const kind = d.episodes.length ? 'series' : (i.type === 'multistream' ? 'series' : 'movie');
        const streams = d.streams || [];
        const out = Object.assign(itemPublic(Object.assign({}, i, { type: d.episodes.length ? 'multistream' : i.type }),
            await poster(VodSources.makeId(src, i.fid), i.poster), undefined, src), {
            duration: i.duration || 0,
            description: i.description || '',
            agelimit: i.agelimit || 0,
            // название озвучки есть только там, где их несколько — иначе показывать нечего
            streams: streams.length > 1 ? streams.map((s, n) => ({ id: s.id != null ? s.id : n, name: s.name || '' })) : [],
            episodes: d.episodes.map(e => ({ id: VodSources.makeId(src, e.fid), fid: e.fid, title: e.title }))
        });
        // рейтинг — украшение: не нашли или источники молчат — карточка открывается как прежде
        //
        // Рецензии сейчас всегда кинопоисковские (kpReviews в meta). Если у источника появятся свои,
        // он объявит метод reviews(localId) и параметр reviews:own в адресе
        // (portal::[key:…;reviews:own]http://…) — тогда здесь вместо kpReviews отдаётся их число,
        // а ручка /vod/reviews спрашивает источник, а не Кинопоиск. Пока такого источника нет.
        return Object.assign(out, await meta({ title: i.title, year: i.year, kind, description: out.description }));
    }

    return { search, searchAll, info, details, meta, poster, cachedPoster, setPinnedPosters, source, MIN_SCORE, STRONG_SCORE };
}

module.exports = { createVod, parseQuery, parseQuality, cleanTitle, stem };
