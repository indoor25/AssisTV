/**
 * Пример плагина-источника фильмов. Ставится со страницы аддона в Home Assistant: панель IPTV →
 * «Плагины» → «загрузить файл»; потом в карточке плагина — адрес (любой), «Включён», «Сохранить».
 * Пересобирать и перезапускать приложение телевизора не нужно.
 *
 * Файл выполняется в песочнице аддона (Node.js), а с отметкой «Работать на телевизоре без аддона» —
 * ещё и в браузере телевизора, поэтому:
 *   — никакого DOM, никаких переводов: плагин отдаёт только данные, рисует их плеер;
 *   — из внешнего мира доступен только fetch;
 *   — request в элементах — непрозрачный для плеера токен: что в нём лежит, знает только плагин.
 *
 * ВНИМАНИЕ: у плагина будут ключи и пароли от источника — ставьте только код, которому доверяете.
 *
 * Этот пример ничего не скачивает — он отдаёт несколько придуманных фильмов. На нём удобно смотреть,
 * как выглядит фильм с несколькими озвучками (у «Интерстеллара» их три).
 */
VodSources.register('example', {
    // манифест: раздел «Плагины» показывает его и рисует по settings форму настроек
    meta: {
        name: 'Пример источника', version: '1.0.0', author: 'AssisTV', api: 1,
        settings: [
            { key: 'url', label: 'Адрес сервиса', required: true },
            { key: 'key', label: 'Ключ', type: 'password' }
        ]
    },
    create(url, params) {
        const FILMS = [
            {
                fid: '1', type: 'stream', title: 'Интерстеллар', year: 2014, duration: 169,
                description: 'Фильм с тремя озвучками — на нём видно выбор перевода.',
                poster: null,
                streams: [
                    { id: 56, name: 'Дубляж', url: 'http://example.invalid/1-dub.m3u8', variants: null },
                    { id: 111, name: 'Netflix', url: 'http://example.invalid/1-netflix.m3u8', variants: null },
                    { id: 232, name: '1+1studio', url: 'http://example.invalid/1-1plus1.m3u8', variants: null }
                ]
            },
            {
                fid: '2', type: 'stream', title: 'Обычный фильм', year: 2001, duration: 92,
                description: 'Одна ссылка — кнопка «Смотреть», как у портала.',
                url: 'http://example.invalid/2.m3u8',
                variants: { auto: 'http://example.invalid/2.m3u8', 1080: 'http://example.invalid/2-1080.m3u8' }
            },
            {
                fid: '3', type: 'multistream', title: 'Сериал, сезон 1', year: 2019,
                description: 'Сериал из двух серий.',
                episodes: [
                    { fid: '3-1', type: 'stream', title: 'Серия 1', url: 'http://example.invalid/3-1.m3u8' },
                    { fid: '3-2', type: 'stream', title: 'Серия 2', url: 'http://example.invalid/3-2.m3u8' }
                ]
            }
        ];

        const find = id => FILMS.find(f => String(f.fid) === String(id)) || null;
        const brief = f => ({
            type: f.type, fid: f.fid, title: f.title, year: f.year || null, duration: f.duration || 0,
            description: f.description || '', poster: f.poster || null, url: f.url || null,
            variants: f.variants || null, request: { id: f.fid }
        });

        return {
            /** Главная: категории, поиск, фильтры. */
            async root() {
                return {
                    categories: [{ title: 'Все фильмы', request: { all: true } }],
                    search: { request: { query: '{USERINPUT}' } },
                    filters: []
                };
            },

            /** Страница списка. request — то, что отдали в categories/search/filterRequest. */
            async page(request) {
                const q = String((request && request.query) || '').toLowerCase();
                const items = FILMS.filter(f => !q || f.title.toLowerCase().includes(q));
                return { items: items.map(brief), count: items.length, nextRequest: null, request };
            },

            /** Карточка: сам фильм, серии сериала и список озвучек. */
            async details(item) {
                const f = find(item.fid || (item.request && item.request.id));
                if (!f) throw new Error('не найдено');
                return {
                    item: brief(f),
                    episodes: (f.episodes || []).map(brief),
                    // одна озвучка — плеер покажет обычную кнопку «Смотреть»; несколько — кнопку на каждую
                    streams: f.streams || [{ id: null, name: '', url: f.url || null, variants: f.variants || null }]
                };
            },

            /** Запрос поиска: плеер отдаёт root и введённый текст. */
            searchRequest(root, text) { return { query: text }; },

            /** Выбранные пункты фильтров накладываются друг на друга. */
            filterRequest(requests) { return Object.assign({}, ...requests); },

            /** id (без имени источника) → элемент, с которым можно звать details. Нужен избранному. */
            itemById(localId) { return { type: 'stream', fid: String(localId), request: { id: String(localId) } }; }
        };
    }
});
