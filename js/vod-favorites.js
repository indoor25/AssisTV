/**
 * Избранное фильмов. Список ОБЩИЙ на все телевизоры и на карточку Home Assistant, поэтому живёт
 * не в localStorage, а в аддоне (ha-addon/epg_builder/favorites.js):
 *
 *   GET  {addonUrl}/favorites.json → {items: [{id, src, fid, title, year, kind, poster, quality, addedAt}]}
 *   POST {addonUrl}/favorites      ← {id, title, year, kind, poster, add?} → {ok, favorite, items}
 *
 * add не передан — переключить. Ответ сразу содержит новый список, отдельным запросом его не перечитываем.
 *
 * id — составной: «portal:48357» (источник и его собственный номер). Один и тот же фильм из двух
 * источников — две записи: у них разная озвучка и разные номера. Записи, сделанные до появления
 * плагинов, лежат без id — они читаются как portal (VodSources.splitId).
 *
 * Копия в localStorage — чтобы при недоступном аддоне лента «Избранное» не исчезала с экрана.
 * Править без аддона нельзя: toggle бросит исключение, VodUI покажет сообщение.
 *
 * Хранится не только id, но и название: идентификаторы источников не вечны, и аддон умеет включать
 * избранное запасным путём — поиском по названию в том же источнике.
 */
const VodFavorites = (() => {
    const KEY = 'tizeniptv.vodfav.v1';
    const TIMEOUT_MS = 10000;

    let addonUrl = '';
    let items = readCache();

    function readCache() {
        try {
            const d = JSON.parse(localStorage.getItem(KEY));
            if (d && Array.isArray(d.items)) return d.items;
        } catch (e) { /* пусто или битое */ }
        return [];
    }

    function writeCache() {
        try { localStorage.setItem(KEY, JSON.stringify({ items, savedAt: Date.now() })); } catch (e) {
            console.warn('[VodFavorites] кеш не записался', e);
        }
    }

    function request(path, opts) {
        const url = AddonClient.base(addonUrl);
        if (!url) return Promise.reject(new Error(I18n.t('addon.noUrl')));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(I18n.t('addon.timeout', { s: TIMEOUT_MS / 1000 }))), TIMEOUT_MS);
            fetch(url + path, Object.assign({}, opts, { headers: AddonClient.authHeaders(url, opts && opts.headers) })).then(res => {
                clearTimeout(timer);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            }).then(resolve, err => { clearTimeout(timer); reject(err); });
        });
    }

    function setAddonUrl(url) { addonUrl = url || ''; }

    /** id записи: новые лежат с id, старые — только с fid (значит portal). */
    function idOf(fav) {
        if (!fav) return null;
        if (fav.id != null && fav.id !== '') return String(fav.id);
        return fav.fid == null ? null : VodSources.makeId(fav.src, fav.fid);
    }

    /** Перечитать список. Аддон молчит — остаётся прежний (из кеша), ошибка не бросается. */
    async function refresh() {
        try {
            const b = await request('/favorites.json');
            if (b && Array.isArray(b.items)) {
                items = b.items;
                writeCache();
            }
        } catch (e) {
            console.warn('[VodFavorites] список не обновился', e);
        }
        return items;
    }

    function list() { return items.slice(); }

    function has(id) { return id != null && items.some(i => VodSources.sameId(idOf(i), id)); }

    /**
     * Добавить/убрать. item — {id, title, year, kind|type, poster, quality}; on не задан — переключить.
     * → в избранном ли фильм после вызова. Аддон недоступен — исключение (список не меняем).
     */
    async function toggle(item, on) {
        const id = idOf(item);
        if (id == null) throw new Error('no_fid');
        const b = await request('/favorites', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id,
                title: item.title || '',
                year: item.year || null,
                kind: item.kind || (item.type === 'multistream' ? 'series' : 'movie'),
                poster: item.poster || null,
                quality: item.quality || (item.uhd ? (item.hdr ? '4K HDR' : '4K') : item.hdr ? 'HDR' : ''),
                add: on
            })
        });
        if (!b || !b.ok) throw new Error((b && b.error) || 'failed');
        if (Array.isArray(b.items)) {
            items = b.items;
            writeCache();
        }
        return !!b.favorite;
    }

    /**
     * Источник сменил идентификатор — спросить аддон, что сейчас отвечает этому названию В ТОМ ЖЕ
     * источнике (у другого свои номера и своя озвучка). Ранжирование у аддона своё (ChannelMatch),
     * поэтому берём его best, а не первый ответ источника.
     * → собственный id источника | null
     */
    async function resolveId(title, src) {
        if (!title) return null;
        const b = await request('/vod/search?q=' + encodeURIComponent(title) +
            (src ? '&src=' + encodeURIComponent(src) : ''));
        return b && b.best ? b.best.fid : null;
    }

    /** Перенести запись избранного на новый id. */
    async function replaceId(oldId, item) {
        await toggle({ id: oldId, title: item.title }, false);
        return toggle(item, true);
    }

    /**
     * Запись избранного → элемент для плитки. Запроса к источнику здесь нет: его собирает сам источник
     * (client.itemById в VodUI), когда карточку открывают — формат запросов знает только плагин.
     */
    function asItem(fav) {
        const q = String(fav.quality || '');
        const id = idOf(fav);
        const { type, localId } = VodSources.splitId(id);
        // «/local/…» открывается только внутри Home Assistant — телевизору постер раздаёт сам аддон
        const p = fav.poster || fav.posterLocal || null;
        const poster = p && /^\/local\//.test(p)
            ? AddonClient.base(addonUrl) + '/posters/' + String(id).replace(/[^\w-]+/g, '_') + '.jpg'
            : p;
        return {
            id,
            src: type,
            fid: localId,
            title: fav.title,
            year: fav.year || null,
            poster,
            type: fav.kind === 'series' ? 'multistream' : 'stream',
            fav: true,
            uhd: /4K/i.test(q),
            hdr: /HDR/i.test(q)
        };
    }

    /** src задан — только избранное этого источника (его умеет открыть открытый экран). */
    function asItems(src) {
        return items.map(asItem).filter(i => !src || i.src === src);
    }

    return { setAddonUrl, refresh, list, has, toggle, resolveId, replaceId, asItem, asItems, idOf };
})();

if (typeof module !== 'undefined') module.exports = { VodFavorites };
