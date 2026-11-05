/**
 * «Посмотреть позже» — фильмы, которые прислали с телефона (кнопка «На TV» в меню выделенного текста
 * или «Поделиться»). Список общий на все телевизоры и живёт в аддоне (ha-addon/epg_builder/watchlist.js):
 *
 *   GET  {addonUrl}/watchlist.json → {items: [{key, title, year, kind, kpId, kpRating, genres, description,
 *                                              posterLocal, found: {id, src, title, …} | null, source}]}
 *   POST {addonUrl}/watchlist      ← {action: remove, key} | {action: recheck, key} → {ok, items}
 *
 * found — где фильм нашёлся (составной id источника); null — его пока нет ни у одного источника, плитка
 * серая, а карточка показывает то, что известно от Кинопоиска. Копия в localStorage — чтобы лента не
 * пропадала, пока аддон недоступен (как у избранного, js/vod-favorites.js).
 */
const VodWatchlist = (() => {
    const KEY = 'tizeniptv.vodwatch.v1';
    const TIMEOUT_MS = 20000;   // «поискать снова» опрашивает все источники

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
            console.warn('[VodWatchlist] кеш не записался', e);
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

    function take(b) {
        if (b && Array.isArray(b.items)) {
            items = b.items;
            writeCache();
        }
    }

    /** Перечитать список. Аддон молчит — остаётся прежний. */
    async function refresh() {
        try { take(await request('/watchlist.json')); } catch (e) {
            console.warn('[VodWatchlist] список не обновился', e);
        }
        return items;
    }

    function post(body) {
        return request('/watchlist', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
    }

    /** Убрать запись. Аддон недоступен — исключение. */
    async function remove(key) {
        const b = await post({ action: 'remove', key });
        if (!b || !b.ok) throw new Error((b && b.error) || 'failed');
        take(b);
    }

    /** Поискать у источников заново → запись после поиска (found заполнен, если нашёлся). */
    async function recheck(key) {
        const b = await post({ action: 'recheck', key });
        if (!b || !b.ok) throw new Error((b && b.error) || 'failed');
        take(b);
        return b.item;
    }

    function find(key) { return items.find(i => i.key === key) || null; }

    /** Запись, в которой фильм с этим составным id (кнопка «Убрать» в обычной карточке). */
    function findById(id) {
        return id == null ? null : items.find(i => i.found && VodSources.sameId(i.found.id, id)) || null;
    }

    /** Постер: «/local/…» открывается только внутри HA — телевизору его раздаёт сам аддон. */
    function posterOf(p) {
        if (!p) return null;
        const m = /^\/local\/tizen-iptv\/posters\/([\w-]+\.jpg)$/.exec(p);
        return m ? AddonClient.base(addonUrl) + '/posters/' + m[1] : p;
    }

    /** Запись → элемент плитки. Ненайденное — missing: открывается своей карточкой, без источника. */
    function asItem(w) {
        const kp = { kpId: w.kpId || null, kpRating: w.kpRating || null, kpReviews: w.kpReviews || 0, genres: w.genres || [] };
        const base = {
            wl: w.key, title: w.title, year: w.year || null, poster: posterOf(w.posterLocal),
            type: w.kind === 'series' ? 'multistream' : 'stream', description: w.description || '', kp
        };
        if (!w.found) return Object.assign(base, { missing: true, id: null, src: null, fid: null });
        const { type, localId } = VodSources.splitId(w.found.id);
        const q = String(w.found.quality || '');
        return Object.assign(base, {
            id: w.found.id, src: type, fid: localId,
            // у источника название бывает своим («Дюна [4K]») — по нему источник и ищет запасным путём
            sourceTitle: w.found.title,
            type: w.found.kind === 'series' ? 'multistream' : base.type,
            uhd: /4K/i.test(q), hdr: /HDR/i.test(q)
        });
    }

    function asItems() { return items.map(asItem); }

    function list() { return items.slice(); }

    return { setAddonUrl, refresh, remove, recheck, find, findById, asItem, asItems, list };
})();

if (typeof module !== 'undefined') module.exports = { VodWatchlist };
