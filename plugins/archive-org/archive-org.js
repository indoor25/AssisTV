/**
 * Плагин-источник AssisTV: фильмы Internet Archive (archive.org) — полнометражные фильмы, перешедшие
 * в общественное достояние (коллекция feature_films и её разделы: нуар, фантастика и ужасы, комедии,
 * немое кино, вестерны, мультфильмы). Ключ и регистрация не нужны.
 *
 * Установка: страница AssisTV в Home Assistant → «Плагины» → по ссылке или файлом; в настройках —
 * адрес https://archive.org, «Включён», «Сохранить».
 *
 * API архива (открытое, CORS *):
 *   поиск     — /advancedsearch.php?q=<lucene>&fl[]=…&sort[]=…&rows=&page=&output=json
 *   карточка  — /metadata/<id> → {metadata, files: [{name, format, height, length, source}], d1, dir}
 *   постер    — /services/img/<id>
 *   видео     — https://<d1><dir>/<файл> (то же, что /download/<id>/<файл>, но без перенаправления)
 *
 * Загружают в архив сами пользователи, поэтому берутся только кураторские коллекции, а в лентах —
 * сначала самое скачиваемое: там почти всегда аккуратные записи с годом и описанием.
 */
VodSources.register('archiveorg', {
    meta: {
        name: 'Internet Archive', version: '1.0.0', author: 'AssisTV', api: 1,
        homepage: 'https://archive.org/details/feature_films',
        settings: [
            { key: 'url', label: 'URL: https://archive.org', required: true },
            { key: 'lang', label: 'Language of rows: ru, en, uk, de (empty — en)' }
        ]
    },
    create(url, params) {
        const base = String(url || 'https://archive.org').replace(/\/+$/, '');
        const ROWS = 30;
        const FIELDS = ['identifier', 'title', 'year', 'runtime', 'description'];

        const WORDS = {
            ru: { popular: 'Популярное', noir: 'Нуар', scifi: 'Фантастика и ужасы', comedy: 'Комедии',
                silent: 'Немое кино', western: 'Вестерны', cartoons: 'Мультфильмы', newest: 'Недавно добавленные',
                genre: 'Жанр', decade: 'Годы', s: '-е' },
            en: { popular: 'Popular', noir: 'Film noir', scifi: 'Sci-fi & horror', comedy: 'Comedy',
                silent: 'Silent films', western: 'Westerns', cartoons: 'Cartoons', newest: 'Recently added',
                genre: 'Genre', decade: 'Years', s: 's' },
            uk: { popular: 'Популярне', noir: 'Нуар', scifi: 'Фантастика і жахи', comedy: 'Комедії',
                silent: 'Німе кіно', western: 'Вестерни', cartoons: 'Мультфільми', newest: 'Нещодавно додані',
                genre: 'Жанр', decade: 'Роки', s: '-ті' },
            de: { popular: 'Beliebt', noir: 'Film noir', scifi: 'Science-Fiction & Horror', comedy: 'Komödien',
                silent: 'Stummfilme', western: 'Western', cartoons: 'Zeichentrick', newest: 'Neu hinzugefügt',
                genre: 'Genre', decade: 'Jahre', s: 'er' }
        };
        const w = WORDS[String(params.lang || '').trim().toLowerCase()] || WORDS.en;

        // разделы: что искать (lucene) и как сортировать
        // эксплуатационное кино 30-х и «санитарные» ролики — в архиве они в самом верху скачиваемого
        const MOVIES = 'mediatype:movies AND NOT subject:(exploitation OR sexploitation OR "sex hygiene" OR "social guidance")'
            + ' AND NOT title:(sex OR molester)';
        const GENRES = [
            { key: 'noir', q: 'collection:Film_Noir' },
            { key: 'scifi', q: 'collection:SciFi_Horror' },
            { key: 'comedy', q: 'collection:Comedy_Films' },
            { key: 'silent', q: 'collection:silent_films' },
            { key: 'western', q: 'collection:feature_films AND subject:western' },
            { key: 'cartoons', q: 'collection:classic_cartoons' }
        ];
        const DECADES = [1910, 1920, 1930, 1940, 1950, 1960, 1970];

        const api = async (path) => {
            const res = await fetch(base + path);
            if (!res.ok) throw new Error('archive.org: HTTP ' + res.status);
            return res.json();
        };

        // одно значение поля: архив отдаёт и строку, и массив
        const one = v => (Array.isArray(v) ? v[0] : v);
        const year = v => { const m = String(one(v) || '').match(/\b(1[89]\d\d|20\d\d)\b/); return m ? Number(m[1]) : null; };

        // «95 min», «1:35:00», «20:33», «5752.8» (секунды у файлов) → минуты
        function minutes(v) {
            const s = String(one(v) || '').trim();
            if (!s) return 0;
            let m = s.match(/^(\d+):(\d\d):(\d\d)/);
            if (m) return Number(m[1]) * 60 + Number(m[2]);
            m = s.match(/^(\d+):(\d\d)$/);
            if (m) return Number(m[1]) + (Number(m[2]) >= 30 ? 1 : 0);
            m = s.match(/(\d+)\s*min/i);
            if (m) return Number(m[1]);
            m = s.match(/^\d+(\.\d+)?$/);
            return m ? Math.round(Number(s) / 60) : 0;
        }

        // описание в архиве — HTML: теги убрать, абзацы сохранить
        function plain(v) {
            return String(one(v) || '')
                .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
                .replace(/<[^>]*>/g, '')
                .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
                .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
                .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
        }

        const poster = id => base + '/services/img/' + encodeURIComponent(id);

        const toItem = d => ({
            type: 'stream',
            fid: String(d.identifier),
            title: String(one(d.title) || d.identifier),
            year: year(d.year) || year(d.title),   // у части записей год только в названии
            poster: poster(d.identifier),
            duration: minutes(d.runtime),
            description: plain(d.description),
            request: { id: String(d.identifier) }
        });

        // символы, которые lucene считает своими, из текста поиска убираются
        const words = text => String(text || '').replace(/[+\-&|!(){}\[\]^"~*?:\\\/]/g, ' ').trim().split(/\s+/).filter(Boolean);

        // качество по высоте кадра → ключ variants плеера
        function quality(h) {
            h = Number(h) || 0;
            if (h >= 2000) return '2160';
            if (h >= 1300) return '1440';
            if (h >= 1000) return '1080';
            if (h >= 700) return '720';
            return '480';
        }

        // видео, которое играет телевизор: .mp4 с h.264 (mkv и m2ts — оригиналы на гигабайты, ogv AVPlay не играет)
        function streamsOf(m) {
            const files = (m.files || []).filter(f => /\.mp4$/i.test(f.name) && /h\.264|mpeg4/i.test(f.format || ''));
            if (!files.length) return [];
            const host = m.d1 || m.server;
            const link = f => (host && m.dir
                ? 'https://' + host + m.dir + '/' + f.name.split('/').map(encodeURIComponent).join('/')
                : base + '/download/' + encodeURIComponent(m.metadata.identifier) + '/' + f.name.split('/').map(encodeURIComponent).join('/'));
            // на каждое качество — файл с самым большим кадром, при равном — самый крупный
            // (у одной записи бывает несколько версий: DVD, PS3, iPod…)
            const better = (a, b) => (Number(a.height) || 0) - (Number(b.height) || 0) || Number(a.size || 0) - Number(b.size || 0);
            const byQ = {};
            files.forEach(f => {
                const q = quality(f.height);
                if (!byQ[q] || better(f, byQ[q]) > 0) byQ[q] = f;
            });
            const keys = Object.keys(byQ).sort((a, b) => Number(b) - Number(a));
            const best = byQ[keys[0]];
            let variants = null;
            if (keys.length > 1) {
                variants = { auto: link(best) };
                keys.forEach(q => { variants[q] = link(byQ[q]); });
            }
            return [{ id: null, name: '', url: link(best), variants }];
        }

        async function search(q, sort, page) {
            const p = ['q=' + encodeURIComponent(q), 'rows=' + ROWS, 'page=' + page, 'output=json']
                .concat(FIELDS.map(f => 'fl[]=' + f))
                .concat(sort ? ['sort[]=' + encodeURIComponent(sort)] : []);
            const r = await api('/advancedsearch.php?' + p.join('&'));
            return (r && r.response) || { numFound: 0, docs: [] };
        }

        return {
            async root() {
                const cat = (title, q, sort) => ({ title, request: { q, sort: sort || 'downloads desc', page: 1 } });
                return {
                    categories: [cat(w.popular, 'collection:feature_films')]
                        .concat(GENRES.map(g => cat(w[g.key], g.q)))
                        .concat([cat(w.newest, 'collection:feature_films', 'addeddate desc')]),
                    search: { request: { text: '{USERINPUT}' } },
                    filters: [
                        { title: w.genre, items: GENRES.map(g => ({ title: w[g.key], request: { genre: g.q } })) },
                        { title: w.decade, items: DECADES.map(d => ({ title: d + w.s, request: { decade: d } })) }
                    ]
                };
            },

            async page(request) {
                const page = request.page || 1;
                let q = request.q;
                let sort = request.sort || 'downloads desc';
                if (request.text != null) {
                    const ws = words(request.text);
                    if (!ws.length) return { items: [], count: 0, nextRequest: null };
                    q = 'collection:(feature_films OR silent_films OR classic_cartoons) AND title:(' + ws.join(' AND ') + ')';
                } else if (!q) {
                    // фильтры: жанр и/или десятилетие
                    q = request.genre || 'collection:feature_films';
                    if (request.decade) q += ' AND year:[' + request.decade + ' TO ' + (request.decade + 9) + ']';
                }
                const r = await search('(' + q + ') AND ' + MOVIES, sort, page);
                const items = (r.docs || []).map(toItem);
                const more = page * ROWS < (r.numFound || 0) && items.length > 0;
                return {
                    items,
                    count: r.numFound || 0,
                    nextRequest: more ? Object.assign({}, request, { page: page + 1 }) : null
                };
            },

            async details(item) {
                const id = (item && item.request && item.request.id) || (item && item.fid);
                if (!id) throw new Error('archive.org: нет id');
                const m = await api('/metadata/' + encodeURIComponent(id));
                if (!m || !m.metadata) throw new Error('archive.org: запись не найдена');
                const d = m.metadata;
                const full = toItem(d);
                full.posterHi = full.poster;
                // длительность: из метаданных, иначе по самому длинному видеофайлу
                if (!full.duration) {
                    const len = Math.max.apply(null, [0].concat((m.files || []).map(f => Number(f.length) || 0)));
                    full.duration = Math.round(len / 60);
                }
                return { item: full, episodes: [], streams: streamsOf(m) };
            },

            searchRequest(root, text) { return { text, page: 1 }; },

            filterRequest(requests) { return Object.assign({ page: 1 }, ...requests); },

            itemById(localId) { return { type: 'stream', fid: String(localId), request: { id: String(localId) } }; }
        };
    }
});
