/**
 * Клиент источника фильмов для экрана фильмов (js/vod-ui.js). Плагин выполняется в аддоне (песочница,
 * ключи источника остаются там): методы root/page/details/… уходят запросом POST /vod/call.
 *
 * Аддон недоступен, а у плагина включено «работать на телевизоре без аддона» — тот же метод выполняет
 * копия плагина на телевизоре (код и адрес источника скачаны заранее, AddonClient.loadVodSources) и
 * LOCAL_MS дальше запросы идут сразу к ней, не дожидаясь таймаута аддона на каждом шаге.
 *
 * Старый аддон (до 2.20) отдаёт плейлист с url — тогда, как раньше, плагин целиком на телевизоре.
 * Все методы асинхронные; аргументы-промисы (запрос поиска сразу в page()) клиент дожидается сам.
 */
const VodClient = (() => {
    const METHODS = ['root', 'page', 'details', 'searchRequest', 'filterRequest', 'itemById', 'reviews'];
    const LOCAL_MS = 2 * 60 * 1000;

    /** Чем один источник отличается от другого — для «тот же уже открыт». */
    function keyOf(playlist) {
        return playlist ? (playlist.url || 'vod:' + playlist.id) : null;
    }

    function wrapLocal(client) {
        const c = { sourceType: client.sourceType, params: client.params };
        METHODS.forEach(m => {
            c[m] = async (...args) => {
                if (typeof client[m] !== 'function') throw new Error('not_supported');
                return client[m](...(await Promise.all(args)));
            };
        });
        return c;
    }

    function create(playlist) {
        if (playlist.url) return wrapLocal(VodSources.create(playlist.url));
        const src = playlist.src || VodSources.DEFAULT_TYPE;
        let local = null;
        let localUntil = 0;

        // копия плагина с адресом источника — только если её разрешили на странице аддона
        function localClient() {
            if (local) return local;
            const off = AddonClient.offlineSource(playlist.id);
            if (!off || !VodSources.has(off.src)) return null;
            try { local = VodSources.create(off.url); } catch (e) { return null; }
            return local;
        }

        const c = { sourceType: src, params: {} };
        METHODS.forEach(m => {
            c[m] = async (...args) => {
                args = await Promise.all(args);
                if (Date.now() < localUntil && localClient()) return local[m](...args);
                try {
                    return await AddonClient.vodCall(playlist.id, m, args);
                } catch (err) {
                    // аддон не ответил (а не плагин вернул ошибку) — работаем на копии, если она есть
                    if (!err.network || !localClient()) throw err;
                    console.warn('[VodClient] аддон недоступен — источник на телевизоре', err.message);
                    localUntil = Date.now() + LOCAL_MS;
                    return local[m](...args);
                }
            };
        });
        return c;
    }

    return { create, keyOf };
})();

if (typeof module !== 'undefined') module.exports = { VodClient };
