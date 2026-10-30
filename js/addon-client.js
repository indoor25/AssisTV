/**
 * Связь с аддоном Home Assistant (ha-addon/epg_builder): плейлисты настраиваются там, телевизор их
 * только выбирает.
 *
 *   POST {addonUrl}/tvs/register       ← {duid, model, pairing: 1, token?} → {tv_id, name, area, topics, mqtt, playlists,
 *                                         token?}; телевизор аддону незнаком — 202 {pairing: {code}}: код показывают на
 *                                         экране (js/pairing-ui.js) и подтверждают на странице IPTV в HA
 *   Все остальные запросы — с Authorization: Bearer <токен> (токен выдаётся один раз и хранится здесь).
 *   GET  {addonUrl}/playlists.json      → [{id, name, kind: 'tv'|'vod', url?}]
 *   GET  {addonUrl}/playlists/<id>.json → M3U: {channels, match, channels_epg, programmes} — готово к
 *                                         ChannelStore.load(), телевизор сам ничего не разбирает
 *   GET  {addonUrl}/playlists/<id>/archive.json?name=<канал> → передачи за дни архива канала
 *   GET  {addonUrl}/vod-sources.json    → [{type, sha1}] — какие источники фильмов установлены,
 *   GET  {addonUrl}/vod-sources/<тип>.js → их код: телевизор выполняет его у себя (loadVodSources)
 *   POST {addonUrl}/parental/check      ← {tv_id, pin} → {ok} — PIN родительского контроля
 *
 * Кеш (localStorage): ответ регистрации и каналы последнего открытого M3U-плейлиста (без EPG — он
 * мегабайты). Аддон недоступен (Pi перезагружается, сеть легла) — приложение стартует с кеша, а app.js
 * предупреждает об этом всплывающим сообщением.
 */
const AddonClient = (() => {
    const REG_KEY = 'tizeniptv.addon.v1';
    const CHANNELS_KEY = 'tizeniptv.addon.channels.v1';
    const DEVICE_KEY = 'tizeniptv.device.v1';
    const SOURCES_KEY = 'tizeniptv.addon.sources.v1';
    const TOKEN_KEY = 'tizeniptv.addon.token.v1';   // {<адрес аддона>: токен} — у каждого аддона свой
    const TIMEOUT_MS = 15000;

    function readCache(key) {
        try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
    }

    function writeCache(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { console.warn('[Addon] кеш не записался', e); }
    }

    function base(addonUrl) {
        let u = String(addonUrl || '').trim().replace(/\/+$/, '');
        if (u && !/^https?:\/\//i.test(u)) u = 'http://' + u;
        return u;
    }

    function tokenFor(url) {
        const all = readCache(TOKEN_KEY) || {};
        return all[url] || '';
    }

    function saveToken(url, token) {
        const all = readCache(TOKEN_KEY) || {};
        all[url] = token;
        writeCache(TOKEN_KEY, all);
    }

    /** Заголовки запроса к аддону с токеном этого телевизора (адрес — любой адрес аддона). */
    function authHeaders(url, headers) {
        const out = Object.assign({}, headers);
        const m = /^https?:\/\/[^/]+/i.exec(String(url || ''));
        const token = m ? tokenFor(m[0]) : '';
        if (token) out.Authorization = 'Bearer ' + token;
        return out;
    }

    /** fetch с таймаутом: без него при лежащем Pi запрос висит минутами, а приложение ждёт. */
    function request(url, opts) {
        opts = Object.assign({}, opts, { headers: authHeaders(url, opts && opts.headers) });
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(I18n.t('addon.timeout', { s: TIMEOUT_MS / 1000 }))), TIMEOUT_MS);
            fetch(url, opts).then(res => {
                clearTimeout(timer);
                if (!res.ok) {
                    return res.json().catch(() => ({})).then(body => {
                        throw new Error('HTTP ' + res.status + (body && body.message ? ' — ' + body.message : ''));
                    });
                }
                return res.json();
            }).then(resolve, err => { clearTimeout(timer); reject(err); });
        });
    }

    /**
     * DUID и модель телевизора (webapis.productinfo). Если API недоступен — постоянный случайный id
     * в localStorage, а модель и DUID аддон попробует узнать сам через REST телевизора (:8001).
     */
    function deviceInfo() {
        const info = { duid: '', model: '' };
        try {
            if (typeof webapis !== 'undefined' && webapis.productinfo) {
                info.duid = webapis.productinfo.getDuid() || '';
                info.model = (webapis.productinfo.getRealModel && webapis.productinfo.getRealModel()) ||
                    webapis.productinfo.getModel() || '';
            }
        } catch (e) { console.warn('[Addon] productinfo недоступен', e); }
        if (!info.duid) {
            let id = null;
            try { id = localStorage.getItem(DEVICE_KEY); } catch (e) { /* нет хранилища */ }
            if (!id) {
                id = 'app' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
                try { localStorage.setItem(DEVICE_KEY, id); } catch (e) { /* ничего */ }
            }
            info.installId = id;
        }
        return info;
    }

    /**
     * Регистрация. → {tv_id, name, area, topics, mqtt, playlists, fromCache, error?} или {pairing: {code}} —
     * аддон этот телевизор не знает (или привязку сбросили): показать код и повторять, пока не подтвердят.
     * Аддон не ответил — кеш прошлой регистрации с fromCache: true; кеша нет — исключение.
     */
    async function register(addonUrl) {
        const url = base(addonUrl);
        try {
            if (!url) throw new Error(I18n.t('addon.noUrl'));
            const reg = await request(url + '/tvs/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(Object.assign(deviceInfo(), { pairing: 1, token: tokenFor(url) || undefined }))
            });
            if (reg && reg.pairing) return { pairing: reg.pairing, fromCache: false };
            if (!reg || !reg.tv_id) throw new Error(I18n.t('addon.noTvId'));
            if (reg.token) saveToken(url, reg.token);
            delete reg.token;
            writeCache(REG_KEY, { addonUrl: url, reg, savedAt: Date.now() });
            return Object.assign({}, reg, { fromCache: false });
        } catch (err) {
            const cached = readCache(REG_KEY);
            const message = (err && err.message) || String(err);
            if (cached && cached.reg) return Object.assign({}, cached.reg, { fromCache: true, error: message, savedAt: cached.savedAt });
            throw new Error(message);
        }
    }

    /** То же, что request, но ответ — текст (код плагина, а не JSON). */
    function requestText(url) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(I18n.t('addon.timeout', { s: TIMEOUT_MS / 1000 }))), TIMEOUT_MS);
            fetch(url, { headers: authHeaders(url) }).then(res => {
                clearTimeout(timer);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.text();
            }).then(resolve, err => { clearTimeout(timer); reject(err); });
        });
    }

    /**
     * Источники фильмов (плагины) — их код лежит у аддона, телевизор скачивает и выполняет его у себя.
     * Поэтому новый источник не требует пересборки приложения: достаточно положить файл в папку плагинов
     * аддона, перезапустить аддон и перезапустить плеер.
     *
     * Код кешируется в localStorage по sha1: аддон недоступен — работаем на том, что скачали раньше
     * (как и с плейлистом). Сломанный плагин не мешает остальным.
     *
     * → {loaded: [тип…], failed: [{type, error}…], fromCache, error?}
     */
    async function loadVodSources(addonUrl) {
        const url = base(addonUrl);
        const cache = readCache(SOURCES_KEY) || { sources: {} };
        const out = { loaded: [], failed: [], fromCache: false };
        let list = null;
        let offline = cache.offline || [];
        try {
            if (!url) throw new Error(I18n.t('addon.noUrl'));
            const b = await request(url + '/vod-sources.json');
            list = (b && b.sources) || [];
            // адреса источников (с ключами) для работы без аддона — только у разрешённых на странице аддона
            offline = (b && b.offline) || [];
        } catch (err) {
            out.fromCache = true;
            out.error = (err && err.message) || String(err);
            list = Object.keys(cache.sources).map(type => ({ type, sha1: cache.sources[type].sha1 }));
        }

        const fresh = {};
        for (const s of list) {
            const known = cache.sources[s.type];
            let code = known && known.sha1 === s.sha1 ? known.code : null;
            if (!code && !out.fromCache) {
                try {
                    code = await requestText(url + '/vod-sources/' + encodeURIComponent(s.type) + '.js');
                } catch (err) {
                    code = known ? known.code : null;   // не скачался — играем тем, что было
                    if (!code) { out.failed.push({ type: s.type, error: (err && err.message) || String(err) }); continue; }
                }
            }
            if (!code) continue;
            fresh[s.type] = { sha1: s.sha1, code };
            try {
                // тем же способом плагин выполняет аддон: файл ничего не импортирует, реестр — параметром
                new Function('VodSources', code)(VodSources);
                if (!VodSources.has(s.type)) throw new Error('VodSources.register(' + s.type + ') не вызван');
                out.loaded.push(s.type);
            } catch (err) {
                out.failed.push({ type: s.type, error: (err && err.message) || String(err) });
            }
        }
        // ответ аддона — вся правда: выключили «без аддона» — копия плагина и его ключ с телевизора уходят
        if (!out.fromCache) writeCache(SOURCES_KEY, { sources: fresh, offline, savedAt: Date.now() });
        return out;
    }

    /** Копия источника для работы без аддона: {id, src, url} или null. */
    function offlineSource(playlistId) {
        const cache = readCache(SOURCES_KEY) || {};
        return (cache.offline || []).find(s => s.id === playlistId) || null;
    }

    const VOD_TIMEOUT_MS = 8000;

    /**
     * Метод источника фильмов, выполненный аддоном (плагин работает там). → result; ошибка плагина —
     * исключение как есть, недоступный аддон — исключение с network: true (тогда js/vod-client.js
     * переходит на копию плагина на телевизоре, если она есть).
     */
    function vodCall(playlistId, method, args) {
        const url = base(currentUrl) + '/vod/call';
        const netError = message => Object.assign(new Error(message), { network: true });
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(netError(I18n.t('addon.timeout', { s: VOD_TIMEOUT_MS / 1000 }))), VOD_TIMEOUT_MS);
            fetch(url, {
                method: 'POST',
                headers: authHeaders(url, { 'Content-Type': 'application/json' }),
                body: JSON.stringify({ playlist: playlistId, method, args })
            }).then(res => {
                if (!res.ok) throw netError('HTTP ' + res.status);
                return res.json();
            }, err => { throw netError((err && err.message) || String(err)); }).then(b => {
                clearTimeout(timer);
                if (b && b.ok) resolve(b.result); else reject(new Error((b && b.error) || 'vod_error'));
            }, err => { clearTimeout(timer); reject(err.network ? err : netError(err.message)); });
        });
    }

    // адрес аддона для vodCall: экран фильмов знает только id источника
    let currentUrl = '';
    function setAddonUrl(url) { currentUrl = url || ''; }

    async function fetchPlaylists(addonUrl) {
        const list = await request(base(addonUrl) + '/playlists.json');
        const cached = readCache(REG_KEY);
        if (cached && cached.reg) {
            cached.reg.playlists = list;
            writeCache(REG_KEY, cached);
        }
        return list;
    }

    /**
     * Готовый M3U-плейлист. → {channels, epg, fromCache, error?}; epg — {match, channels, programmes}
     * в форме ChannelStore.load(). Не загрузился — каналы из кеша (если это тот же плейлист), epg: null.
     */
    async function loadTvPlaylist(addonUrl, playlist) {
        try {
            const b = await request(base(addonUrl) + '/playlists/' + encodeURIComponent(playlist.id) + '.json');
            if (!b || !Array.isArray(b.channels)) throw new Error(I18n.t('addon.notPlaylist'));
            writeCache(CHANNELS_KEY, { id: playlist.id, name: playlist.name, channels: b.channels, savedAt: Date.now() });
            return {
                channels: b.channels,
                epg: { match: b.match || {}, channels: b.channels_epg || {}, programmes: b.programmes || {} },
                fromCache: false
            };
        } catch (err) {
            const cached = readCache(CHANNELS_KEY);
            const message = (err && err.message) || String(err);
            if (cached && cached.name === playlist.name && Array.isArray(cached.channels)) {
                return { channels: cached.channels, epg: null, fromCache: true, error: message };
            }
            throw new Error(message);
        }
    }

    /**
     * Программа канала за дни архива (в JSON плейлиста только окно в несколько часов назад).
     * → [{start: Date, stop: Date, title}]
     */
    async function loadArchiveGuide(addonUrl, playlist, channelName) {
        const b = await request(base(addonUrl) + '/playlists/' + encodeURIComponent(playlist.id) +
            '/archive.json?name=' + encodeURIComponent(channelName));
        return (b && b.programmes || []).map(p => ({ start: new Date(p[0] * 1000), stop: new Date(p[1] * 1000), title: p[2] }));
    }

    /**
     * Передача канала в момент atSec (unix-сек) с описанием и следующая за ней (для ▲ при просмотре).
     * → {programme: {start, stop, title, category, rating, desc} | null, next: {start, stop, title} | null}
     */
    async function loadProgrammeInfo(addonUrl, playlist, channelName, atSec) {
        return request(base(addonUrl) + '/playlists/' + encodeURIComponent(playlist.id) +
            '/programme.json?name=' + encodeURIComponent(channelName) + '&at=' + Math.floor(atSec));
    }

    /**
     * Рейтинг, жанры и (если у портала своего нет) описание фильма — аддон спрашивает их у TMDB.
     * Карточку фильма телевизор берёт прямо у портала, поэтому это отдельный запрос уже после показа:
     * ключа TMDB может не быть, аддон может лежать — карточка от этого не страдает.
     * → {ok, enabled, meta: {rating, votes, genres, tmdbId, tmdbKind, tmdbUrl, description?}}
     */
    async function loadVodMeta(addonUrl, { title, year, kind, hasDescription }) {
        return request(base(addonUrl) + '/vod/meta?title=' + encodeURIComponent(title) +
            '&kind=' + (kind === 'series' ? 'series' : 'movie') +
            (year ? '&year=' + encodeURIComponent(year) : '') +
            (hasDescription ? '&desc=1' : ''));
    }

    /**
     * Рецензии зрителей Кинопоиска по kpId из loadVodMeta → {ok, enabled, reviews:{total, pages, items}}.
     * Страница — 20 штук; порядок по умолчанию (самые полезные сверху) задаёт аддон.
     */
    async function loadVodReviews(addonUrl, { id, page = 1 }) {
        return request(base(addonUrl) + '/vod/reviews?id=' + encodeURIComponent(id) +
            '&page=' + encodeURIComponent(page));
    }

    /** PIN родительского контроля (js/parental.js) проверяет аддон. → {ok, error?, message?, retry_in?} */
    async function checkPin(addonUrl, tvId, pin) {
        return request(base(addonUrl) + '/parental/check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tv_id: tvId, pin })
        });
    }

    /** Защита поменялась по MQTT — поправить и копию регистрации: без аддона приложение стартует с неё. */
    function cacheParental(parental) {
        const cached = readCache(REG_KEY);
        if (!cached || !cached.reg) return;
        cached.reg.parental = parental;
        writeCache(REG_KEY, cached);
    }

    return { register, fetchPlaylists, loadVodSources, loadTvPlaylist, loadArchiveGuide, loadProgrammeInfo, loadVodMeta, loadVodReviews, checkPin, cacheParental, base, authHeaders,
        offlineSource, vodCall, setAddonUrl };
})();

if (typeof module !== 'undefined') module.exports = { AddonClient };
