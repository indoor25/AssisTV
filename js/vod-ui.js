/**
 * Экран фильмов и сериалов (#vod-view) — для плейлиста вида <источник>::[параметры]<url>. Клиент
 * источника берётся из реестра плагинов (js/vod-sources.js): сам код источника телевизор скачивает
 * у аддона, здесь он используется через общий интерфейс и что там внутри — неважно.
 * Открывается из окна выбора плейлиста; воспроизведение в это время остановлено (как на главном
 * экране каналов), запускает его app.js через opts.onPlay.
 *
 * Экран работает с ОДНИМ источником — тем, чей плейлист открыт: поиск, ленты и карточка не смешивают
 * разные источники. Наружу (избранное, история, MQTT) идентификатор уходит составным — «portal:48357»,
 * см. idOf().
 *
 * Экраны:
 *   main    — вверху кнопки «Поиск», «Жанр», «Год»; ниже ленты: первая — «Избранное» (общее на все
 *             телевизоры, js/vod-favorites.js), дальше категории портала. У каждой ленты название и
 *             первые постеры, в конце — плитка «Все». ▲▼ — лента, ◄► — постер, OK — карточка.
 *   list    — всё содержимое категории / результаты поиска / фильтра сеткой, догружается
 *             страницами по мере листания. RETURN — назад на main (поиск и фильтр сбрасываются).
 *   details — карточка поверх экрана: постер, год, длительность, качество, описание, «Смотреть»
 *             (или «Продолжить с …» и «С начала»), выбор качества, у сериала — серии.
 *   picker  — список вариантов фильтра (жанр/год) поверх экрана.
 * RETURN на main — opts.onExit (app.js открывает окно выбора плейлиста).
 *
 * Постеры 400×600: разом рисуются только видимые плитки (и одна обрезанная для подсказки, что
 * дальше есть ещё) — сотни картинок разом телевизор бы не потянул. Созданные плитки кешируются,
 * чтобы при листании картинки не пересоздавались и не мигали.
 */
const VodUI = (() => {
    const ROW_TILES = 6;          // полностью видимых плиток в ленте и в ряду сетки
    // Постеры крупные (читаются с дивана), поэтому целиком видна одна лента / один ряд сетки, а
    // следующая выглядывает снизу — видно, что дальше есть ещё.
    const MAIN_ROWS = 1;          // полностью видимых лент на главной
    const LIST_ROWS = 1;          // полностью видимых рядов сетки
    const EP_COLS = 6;
    const EP_ROWS = 3;
    const QUALITY_ORDER = ['auto', '2160', '1440', '1080', '720', '480'];

    let container = null;
    let headerEl = null;
    let recentEl = null;
    let titleEl = null;
    let searchInput = null;
    let bodyEl = null;
    let detailsEl = null;
    let pickerEl = null;
    let opts = { onPlay: () => {}, onExit: () => {} };

    let portalUrl = null;
    let client = null;
    let root = null;
    let rootError = null;
    let token = 0;                // смена портала — ответы старых запросов игнорируются

    let rows = [];                // ленты главной: {title, request, items, count, loading, error, focusCol, firstCol}
    let screen = 'main';          // 'main' | 'list'
    let zone = 'body';            // 'header' | 'body'
    let headerIdx = 0;
    let recentIdx = 0;
    let rowIdx = 0;
    let firstRow = 0;
    let list = null;              // {kind, title, request, items, count, nextRequest, loading, error, focusIdx, firstRow, gen}
    let listGen = 0;
    let filterSel = {};           // индекс фильтра → индекс выбранного пункта
    let details = null;           // {item, full, episodes, loading, error, zone, btnIdx, epIdx, epFirstRow, quality}
    let picker = null;            // {title, options:[label], focus, onPick}
    let favGen = 0;               // избранное поменялось — новый ключ кеша плиток ленты
    let addonUrl = '';            // рейтинги TMDB спрашиваются у аддона (портал их не отдаёт)
    let recentSearches = [];

    const tileCache = new Map();

    /**
     * Составной id фильма или серии для истории просмотра, избранного и HA: у каждого источника свои
     * номера, и «48357» у двух источников — разные фильмы. Внутри экрана по-прежнему ходит fid —
     * собственный идентификатор открытого источника.
     */
    const idOf = fid => VodSources.makeId(client && client.sourceType, fid);

    function init(el, options = {}) {
        container = el;
        Object.assign(opts, options);
        container.innerHTML = '';

        headerEl = document.createElement('div');
        headerEl.className = 'vod-header';
        recentEl = document.createElement('div');
        recentEl.className = 'vod-recent-searches hidden';
        titleEl = document.createElement('div');
        titleEl.className = 'vod-title';
        searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.className = 'vod-search-input hidden';
        searchInput.placeholder = I18n.t('vod.searchPlaceholder');

        bodyEl = document.createElement('div');
        bodyEl.className = 'vod-body';
        detailsEl = document.createElement('div');
        detailsEl.className = 'vod-details hidden';
        pickerEl = document.createElement('div');
        pickerEl.className = 'vod-picker hidden';

        container.appendChild(headerEl);
        container.appendChild(recentEl);
        container.appendChild(bodyEl);
        container.appendChild(detailsEl);
        container.appendChild(pickerEl);
    }

    // ───────────────────────── открытие / данные ─────────────────────────

    /**
     * playlist: {id, name, src} (новый аддон: источник в аддоне) или {name, url} (старый) — если это тот же
     * источник, что уже загружен, состояние сохраняется. Методы клиента (js/vod-client.js) — асинхронные:
     * запросы поиска и фильтра уходят в page() промисом, клиент сам его дождётся.
     */
    function open(playlist) {
        if (!container) return;
        container.classList.remove('hidden');
        document.body.classList.add('vod-open');
        if (portalUrl !== VodClient.keyOf(playlist)) {
            portalUrl = VodClient.keyOf(playlist);
            reset();
            try {
                // источник не установлен (плагин не скачался) — скажем об этом на экране, как об ошибке портала
                client = VodClient.create(playlist);
                loadRoot();
            } catch (e) {
                client = null;
                rootError = e.message || String(e);
            }
        }
        titleEl.textContent = playlist.name || I18n.t('playlists.kindVod');
        loadRecentSearches();
        render();
        // список общий на все телевизоры — на втором его могли поменять, пока портал был закрыт
        VodFavorites.refresh().then(refreshFavRow);
    }

    /** Показать снова (после просмотра) — на том же месте, с открытой карточкой. */
    function show() {
        if (!container || !portalUrl) return;
        container.classList.remove('hidden');
        document.body.classList.add('vod-open');
        // пока смотрели, серии могли переключиться сами (CH+/CH−, конец серии) — фокус на последней
        if (details && details.episodes.length) {
            const last = VodHistory.getLastEpisode(idOf(details.item.fid));
            const idx = details.episodes.findIndex(e => idOf(e.fid) === last);
            if (idx >= 0) details.epIdx = idx;
        }
        render();
    }

    function hide() {
        if (!container) return;
        stopEditing(false);
        container.classList.add('hidden');
        document.body.classList.remove('vod-open');
    }

    function isOpen() { return !!container && !container.classList.contains('hidden'); }
    function getPortalUrl() { return portalUrl; }

    function reset() {
        token++;
        tileCache.clear();
        client = null; root = null; rootError = null;
        rows = []; screen = 'main'; zone = 'body'; headerIdx = 0; rowIdx = 0; firstRow = 0;
        list = null; filterSel = {}; details = null; picker = null;
        searchInput.value = '';
    }

    async function loadRoot() {
        const my = token;
        try {
            const r = await client.root();
            if (my !== token) return;
            root = r;
            // избранное — всегда первой лентой, даже пустое: иначе о нём никто не узнает
            rows = [favRow()].concat(r.categories.map((c, i) => ({
                title: c.title, request: c.request, cacheKey: 'r' + i, items: [], count: null,
                previewLimit: c.previewLimit || 0, nextRequest: null,
                loading: true, error: null, focusCol: 0, firstCol: 0
            })));
            render();
            rows.filter(row => !row.favorites).forEach(row => loadRow(row, my));
        } catch (e) {
            if (my !== token) return;
            rootError = e.message || String(e);
            render();
        }
    }

    async function loadRow(row, my) {
        try {
            const p = await client.page(row.request);
            if (my !== token) return;
            row.items = p.items;
            row.count = p.count;
            row.nextRequest = p.nextRequest;
        } catch (e) {
            if (my !== token) return;
            row.error = e.message || String(e);
        }
        row.loading = false;
        if (isOpen() && screen === 'main') renderBody();
    }

    /** localItems — список уже на руках (избранное), тогда портал не опрашиваем и не догружаем. */
    function openList(kind, title, request, localItems) {
        list = {
            kind, title, request: localItems ? null : request,
            items: localItems || [], count: localItems ? localItems.length : null,
            nextRequest: localItems ? null : request,
            loading: false, error: null, focusIdx: 0, firstRow: 0, gen: ++listGen
        };
        screen = 'list';
        zone = 'body';
        if (!localItems) loadMore();
        render();
    }

    /** Плитка «Все» в конце ленты. */
    function openRowAll(row) {
        if (row.favorites) return openList('favorites', row.title, null, VodFavorites.asItems());
        if (row.items.length) {
            list = {
                kind: 'category', title: row.title, request: null, items: row.items.slice(),
                count: row.count, nextRequest: row.nextRequest, loading: false, error: null,
                focusIdx: 0, firstRow: 0, gen: ++listGen
            };
            screen = 'list'; zone = 'body';
            if (!list.items.length && list.nextRequest) loadMore();
            render();
            return;
        }
        return openList('category', row.title, row.request);
    }

    function rowItems(row) {
        return row.previewLimit ? row.items.slice(0, row.previewLimit) : row.items;
    }

    // ───────────────────────── избранное ─────────────────────────

    function favRow() {
        return {
            title: I18n.t('vod.favorites'), request: null, favorites: true, cacheKey: 'fav' + favGen,
            // избранное общее на все источники: чужую запись откроет её источник (openItem)
            items: VodFavorites.asItems(), count: null, loading: false, error: null, focusCol: 0, firstCol: 0
        };
    }

    /** Список поменялся — перерисовать ленту. Ключ кеша плиток меняем, иначе останутся старые постеры. */
    function refreshFavRow() {
        const row = rows.find(r => r.favorites);
        if (!row) return;
        row.items = VodFavorites.asItems();
        row.cacheKey = 'fav' + (++favGen);
        row.focusCol = Math.max(0, Math.min(row.focusCol, row.items.length));
        if (isOpen() && screen === 'main') renderBody();
    }

    /** Кнопка «В избранное» на карточке. Список живёт в аддоне — без него не изменить. */
    async function toggleFavorite(d, id) {
        if (d.favBusy) return;
        d.favBusy = true;
        d.favError = null;
        renderDetails();
        try {
            await VodFavorites.toggle({
                id,
                title: d.full.title || d.item.title,
                year: d.full.year || d.item.year || null,
                poster: d.full.poster || d.item.poster || null,
                type: isSeries(d) ? 'multistream' : 'stream',
                uhd: d.full.uhd || d.item.uhd,
                hdr: d.full.hdr || d.item.hdr
            });
            refreshFavRow();
        } catch (e) {
            d.favError = e.message || String(e);
        }
        d.favBusy = false;
        if (details === d) renderDetails();
    }

    async function loadMore() {
        const l = list;
        if (!l || l.loading || !l.nextRequest) return;
        const my = token;
        l.loading = true;
        try {
            const p = await client.page(l.nextRequest);
            if (my !== token || list !== l) return;
            l.items = l.items.concat(p.items);
            if (p.count != null) l.count = p.count;
            l.nextRequest = p.items.length ? p.nextRequest : null;
        } catch (e) {
            if (my !== token || list !== l) return;
            l.error = e.message || String(e);
            l.nextRequest = null;
        }
        l.loading = false;
        if (isOpen() && screen === 'list' && list === l) render();
    }

    function backToMain() {
        screen = 'main';
        list = null;
        filterSel = {};
        searchInput.value = '';
        searchInput.classList.add('hidden');
        zone = 'body';
        render();
    }

    // ───────────────────────── рендер ─────────────────────────

    function render() {
        if (!container) return;
        renderHeader();
        renderBody();
        renderDetails();
        renderPicker();
    }

    function headerButtons() {
        const buttons = [{ id: 'search', label: I18n.t('vod.search') }];
        (root ? root.filters : []).forEach((f, i) => {
            const sel = filterSel[i];
            buttons.push({ id: 'filter', fi: i, label: f.title + ': ' + (sel != null ? f.items[sel].title : I18n.t('vod.filterAll')) });
        });
        if (Object.keys(filterSel).length) buttons.push({ id: 'reset', label: I18n.t('vod.filterReset') });
        return buttons;
    }

    function renderHeader() {
        headerEl.innerHTML = '';
        const buttons = headerButtons();
        headerIdx = Math.min(headerIdx, buttons.length - 1);
        buttons.forEach((b, i) => {
            const el = document.createElement('div');
            el.className = 'vod-header-btn' + (b.id === 'search' ? ' search' : '') +
                (zone === 'header' && i === headerIdx && !details && !picker ? ' focused' : '') +
                (b.id === 'filter' && filterSel[b.fi] != null ? ' active' : '');
            el.textContent = b.label;
            el.addEventListener('click', () => { zone = 'header'; headerIdx = i; activateHeader(); });
            headerEl.appendChild(el);
            if (b.id === 'search') headerEl.appendChild(searchInput);
        });
        headerEl.appendChild(titleEl);
        renderRecentSearches();
    }

    const RECENT_SEARCH_KEY = 'vod.recentSearches';
    function loadRecentSearches() {
        try {
            const saved = JSON.parse(localStorage.getItem(RECENT_SEARCH_KEY) || '[]');
            recentSearches = Array.isArray(saved) ? saved.filter(x => typeof x === 'string' && x.trim()).slice(0, 5) : [];
        } catch (e) { recentSearches = []; }
    }

    function rememberSearch(text) {
        const q = String(text || '').trim();
        if (!q) return;
        recentSearches = [q].concat(recentSearches.filter(x => x.toLocaleLowerCase() !== q.toLocaleLowerCase())).slice(0, 5);
        try { localStorage.setItem(RECENT_SEARCH_KEY, JSON.stringify(recentSearches)); } catch (e) { /* storage недоступен */ }
    }

    function renderRecentSearches() {
        if (!recentEl) return;
        recentEl.innerHTML = '';
        recentEl.classList.toggle('hidden', !recentSearches.length);
        recentSearches.forEach((q, i) => {
            const el = document.createElement('div');
            el.className = 'vod-recent-search' + (zone === 'recent' && i === recentIdx ? ' focused' : '');
            el.textContent = q;
            el.title = q;
            el.addEventListener('click', () => runRecentSearch(i));
            recentEl.appendChild(el);
        });
    }

    function runRecentSearch(index) {
        const q = recentSearches[index];
        if (!q || !client || !root) return;
        searchInput.value = q;
        filterSel = {};
        rememberSearch(q);
        openList('search', I18n.t('vod.searchTitle', { text: q }), client.searchRequest(root, q));
    }

    function renderBody() {
        bodyEl.innerHTML = '';
        if (rootError) return message(bodyEl, I18n.t('vod.portalDown', { error: rootError }));
        if (!root) return message(bodyEl, I18n.t('vod.portalLoading'));
        if (screen === 'list') renderList();
        else renderMain();
    }

    function message(parent, text) {
        const el = document.createElement('div');
        el.className = 'vod-message';
        el.textContent = text;
        parent.appendChild(el);
    }

    function renderMain() {
        if (!rows.length) return message(bodyEl, I18n.t('vod.noCategories'));
        rowIdx = Math.max(0, Math.min(rowIdx, rows.length - 1));
        if (rowIdx < firstRow) firstRow = rowIdx;
        else if (rowIdx >= firstRow + MAIN_ROWS) firstRow = rowIdx - MAIN_ROWS + 1;

        const frag = document.createDocumentFragment();
        for (let r = firstRow; r < Math.min(rows.length, firstRow + MAIN_ROWS + 1); r++) {
            const row = rows[r];
            const rowEl = document.createElement('div');
            rowEl.className = 'vod-row';

            const title = document.createElement('div');
            title.className = 'vod-row-title';
            title.textContent = row.title + (row.count != null ? '  ·  ' + row.count : '');
            rowEl.appendChild(title);

            const strip = document.createElement('div');
            strip.className = 'vod-strip';
            if (row.loading) message(strip, I18n.t('common.loading'));
            else if (row.error) message(strip, I18n.t('common.loadFailed', { error: row.error }));
            else if (!row.items.length) message(strip, I18n.t(row.favorites ? 'vod.favEmpty' : 'vod.empty'));
            else {
                const items = rowItems(row);
                const total = items.length + 1;   // + плитка «Все»
                row.focusCol = Math.max(0, Math.min(row.focusCol, total - 1));
                if (row.focusCol < row.firstCol) row.firstCol = row.focusCol;
                else if (row.focusCol >= row.firstCol + ROW_TILES) row.firstCol = row.focusCol - ROW_TILES + 1;
                const focusedHere = zone === 'body' && r === rowIdx && !details && !picker;
                const key = row.cacheKey || ('r' + r);
                for (let c = row.firstCol; c < Math.min(total, row.firstCol + ROW_TILES + 1); c++) {
                    const tile = c < items.length
                        ? posterTile(key + ':' + c, items[c])
                        : allTile(key + ':all', row);
                    tile.classList.toggle('focused', focusedHere && c === row.focusCol);
                    strip.appendChild(tile);
                }
            }
            rowEl.appendChild(strip);
            frag.appendChild(rowEl);
        }
        bodyEl.appendChild(frag);
    }

    function renderList() {
        const l = list;
        const title = document.createElement('div');
        title.className = 'vod-list-title';
        title.textContent = l.title + (l.count != null ? '  ·  ' + l.count : (l.items.length ? '  ·  ' + l.items.length : ''));
        bodyEl.appendChild(title);

        const grid = document.createElement('div');
        grid.className = 'vod-grid';
        bodyEl.appendChild(grid);

        if (!l.items.length) {
            if (l.loading || l.nextRequest) message(grid, I18n.t('common.loading'));
            else message(grid, l.error ? I18n.t('common.loadFailed', { error: l.error }) : I18n.t('vod.nothingFound'));
            return;
        }
        l.focusIdx = Math.max(0, Math.min(l.focusIdx, l.items.length - 1));
        const focusRow = Math.floor(l.focusIdx / ROW_TILES);
        if (focusRow < l.firstRow) l.firstRow = focusRow;
        else if (focusRow >= l.firstRow + LIST_ROWS) l.firstRow = focusRow - LIST_ROWS + 1;

        const from = l.firstRow * ROW_TILES;
        const to = Math.min(l.items.length, from + (LIST_ROWS + 1) * ROW_TILES);
        const focusedHere = zone === 'body' && !details && !picker;
        for (let i = from; i < to; i++) {
            const tile = posterTile('l' + l.gen + ':' + i, l.items[i]);
            tile.classList.toggle('focused', focusedHere && i === l.focusIdx);
            grid.appendChild(tile);
        }
        // догружаем следующую страницу заранее, за пару рядов до конца
        if (l.nextRequest && !l.loading && (l.items.length - l.focusIdx) <= ROW_TILES * 2) loadMore();
    }

    function cached(key, build) {
        let el = tileCache.get(key);
        if (!el) {
            if (tileCache.size > 400) tileCache.clear();
            el = build();
            tileCache.set(key, el);
        }
        return el;
    }

    function posterTile(key, item) {
        const tile = cached(key, () => {
            const t = document.createElement('div');
            t.className = 'vod-tile';
            const box = document.createElement('div');
            box.className = 'vod-poster';
            if (item.poster) {
                const img = document.createElement('img');
                img.src = item.poster;
                img.alt = '';
                img.onerror = () => { img.style.visibility = 'hidden'; };
                box.appendChild(img);
            }
            const badge = badgeText(item);
            if (badge) {
                const b = document.createElement('div');
                b.className = 'vod-badge';
                b.textContent = badge;
                box.appendChild(b);
            }
            const bar = document.createElement('div');
            bar.className = 'vod-progress';
            bar.appendChild(document.createElement('div'));
            box.appendChild(bar);
            t.appendChild(box);

            const name = document.createElement('div');
            name.className = 'vod-tile-title';
            name.textContent = item.title;
            t.appendChild(name);
            const meta = document.createElement('div');
            meta.className = 'vod-tile-meta';
            meta.textContent = [item.year, item.type === 'multistream' ? I18n.t('vod.seriesLower') : ''].filter(Boolean).join(' · ');
            t.appendChild(meta);
            t.addEventListener('click', () => openItem(item));
            return t;
        });
        // просмотренность меняется после просмотра — обновляем на каждой отрисовке
        const progress = item.fid != null ? VodHistory.getProgress(idOf(item.fid)) : 0;
        const bar = tile.querySelector('.vod-progress');
        bar.classList.toggle('hidden', !progress);
        bar.firstChild.style.width = Math.round(progress * 100) + '%';
        return tile;
    }

    function allTile(key, row) {
        return cached(key, () => {
            const t = document.createElement('div');
            t.className = 'vod-tile vod-all';
            const box = document.createElement('div');
            box.className = 'vod-poster';
            box.innerHTML = '<div class="vod-all-text">' + I18n.t('vod.all') + '<br>›</div>';
            t.appendChild(box);
            const name = document.createElement('div');
            name.className = 'vod-tile-title';
            name.textContent = row.title;
            t.appendChild(name);
            t.addEventListener('click', () => openRowAll(row));
            return t;
        });
    }

    function badgeText(item) {
        if (item.uhd) return item.hdr ? '4K HDR' : '4K';
        if (item.hdr) return 'HDR';
        return '';
    }

    // ───────────────────────── карточка ─────────────────────────

    /**
     * Рейтинг, жанры и (когда у портала своего нет) описание — их аддон берёт у TMDB. Запрашиваются
     * уже после показа карточки и своим темпом: ключа TMDB может не быть, аддон может лежать — карточка
     * от этого не меняется, просто остаётся без рейтинга.
     */
    function loadMeta(d) {
        if (!addonUrl || d.meta || d.metaLoading || !d.full.title) return;
        d.metaLoading = true;
        AddonClient.loadVodMeta(addonUrl, {
            title: d.full.title,
            year: d.full.year,
            kind: isSeries(d) ? 'series' : 'movie',
            hasDescription: !!d.full.description
        }).then(r => {
            if (details !== d || !r || !r.meta) return;
            d.meta = r.meta;
            // в full — чтобы рейтинг и жанры доехали до mediaFrom, а оттуда в описание по ▲ при просмотре
            d.full = Object.assign({}, d.full, {
                // в панель по ▲ едет одна цифра — Кинопоиск, если он ответил
                rating: r.meta.kpRating || r.meta.rating || null,
                ratingSrc: r.meta.kpRating ? I18n.t('vod.kpShort') : 'TMDB',
                genres: r.meta.genres || null,
                description: d.full.description || r.meta.description || ''
            });
            renderDetails();
        }).catch(() => { /* карточка уже показана — молча без рейтинга */ });
    }

    /**
     * Нажали плитку. Запись избранного из другого источника этот экран открыть не может (у каждого
     * источника свои идентификаторы) — приложение переключает источник и открывает карточку уже в нём.
     */
    function openItem(item) {
        if (item.fav && item.src && client && item.src !== client.sourceType && opts.onOtherSource) {
            return opts.onOtherSource(item);
        }
        return openDetails(item);
    }

    function openDetails(item) {
        // у записи избранного своего запроса нет — его собирает источник по своему id (источник — в аддоне,
        // поэтому ответ приходит позже; карточка рисуется сразу, по тому, что есть в записи)
        const full = !item.request && item.fid != null && client
            ? Promise.resolve(client.itemById(item.fid)).then(r => Object.assign({}, r, item))
            : Promise.resolve(item);
        const d = {
            item, full: item, episodes: [], loading: true, error: null,
            zone: 'buttons', btnIdx: 0, epIdx: 0, epFirstRow: 0, quality: VodHistory.getQuality()
        };
        details = d;
        render();
        // промис — для playId (запуск из HA): дождаться деталей и сразу включить
        return full.then(it => client.details(it)).then(res => {
            if (details !== d) return d;
            d.full = res.item;
            d.episodes = res.episodes;
            // озвучки: у портала одна (кнопка «Смотреть», как раньше), у других источников — на выбор
            d.streams = res.streams && res.streams.length ? res.streams :
                (res.item.url || res.item.variants ? [{ id: null, name: '', url: res.item.url, variants: res.item.variants }] : []);
            d.streamIdx = 0;
            d.loading = false;
            // сериал: фокус на последней просмотренной серии
            const lastId = VodHistory.getLastEpisode(idOf(item.fid));
            const idx = d.episodes.findIndex(e => idOf(e.fid) === lastId);
            d.epIdx = idx >= 0 ? idx : 0;
            renderDetails();
            loadMeta(d);
            return d;
        }).catch(async e => {
            if (details !== d) return d;
            // избранное живёт дольше идентификаторов источника: не открылось — ищем по названию
            // (ранжирует аддон, у него ChannelMatch) в ТОМ ЖЕ источнике и переносим запись на новый id
            if (item.fav && !d.retried && item.title) {
                d.retried = true;
                try {
                    const fid = await VodFavorites.resolveId(item.title, client.sourceType);
                    if (details === d && fid != null && String(fid) !== String(item.fid)) {
                        const moved = Object.assign({}, item, await client.itemById(fid), {
                            title: item.title, poster: item.poster, year: item.year, fav: true
                        });
                        await VodFavorites.replaceId(idOf(item.fid), Object.assign({}, moved, { id: idOf(fid) }));
                        refreshFavRow();
                        return openDetails(moved);
                    }
                } catch (err) { /* аддон недоступен — показываем исходную ошибку источника */ }
            }
            if (details !== d) return d;
            d.loading = false;
            d.error = e.message || String(e);
            renderDetails();
            return d;
        });
    }

    /**
     * Включить фильм или сериал по идентификатору (команда из HA: iptv/<tv_id>/vod/play). id — составной
     * («portal:48357») или просто номер: источником тогда считается открытый. Источник должен быть открыт
     * (open). Под фильмом остаётся его карточка — RETURN при просмотре вернёт на неё, как обычно.
     * opts: {episodeFid, fromStart, startMs — с этого места (перенос с другого TV), stream, quality}. Сериал без episodeFid — последняя просмотренная серия
     * (или первая), с того места, где остановились. → {title}; просили качество — ещё {quality — какое
     * включили (null — выбора нет), qualities — что было на выбор}
     */
    async function playId(id, o = {}) {
        if (!client) throw new Error('no_portal');
        const { type, localId } = VodSources.splitId(id);
        if (type !== client.sourceType) throw new Error('wrong_source');
        picker = null;
        const d = await openDetails(await client.itemById(localId));
        if (details !== d) throw new Error('cancelled');
        if (d.error) throw new Error(d.error);
        d.item = Object.assign({}, d.item, { title: d.full.title, poster: d.full.poster, posterHi: d.full.posterHi });
        if (d.episodes.length) {
            const epId = o.episodeFid != null ? VodSources.splitId(o.episodeFid).localId : null;
            let idx = epId != null ? d.episodes.findIndex(e => String(e.fid) === String(epId)) : d.epIdx;
            if (idx < 0) throw new Error('episode_not_found');
            d.epIdx = idx;
            const ep = d.episodes[idx];
            const media = await prepareEpisode(seriesOf(d), idx, d.quality);
            const asked = o.quality ? nearestQuality(media.variants, o.quality) : null;
            if (asked) {
                media.quality = asked;
                media.url = media.variants[asked];
            }
            opts.onPlay(media, o.startMs != null ? o.startMs : o.fromStart ? 0 : VodHistory.getResume(idOf(ep.fid)));
            return Object.assign({ title: media.title }, o.quality ? { quality: asked, qualities: numericQualities(media.variants) } : {});
        }
        // озвучку выбрали в карточке HA — включаем именно её
        if (o.stream != null && d.streams) {
            const i = d.streams.findIndex(s => String(s.id) === String(o.stream));
            if (i >= 0) d.streamIdx = i;
        }
        if (!d.full.url && !d.item.url && !(d.streams || []).some(s => s.url || s.variants)) throw new Error('no_url');
        // «включи в 4К» — на этот раз; сохранённый выбор качества (VodHistory) не трогаем
        const variants = streamOf(d).variants;
        const asked = o.quality ? nearestQuality(variants, o.quality) : null;
        if (asked) d.quality = asked;
        playMovie(d, o.startMs != null ? o.startMs : o.fromStart ? 0 : VodHistory.getResume(idOf(d.item.fid)));
        return Object.assign({ title: d.full.title }, o.quality ? { quality: asked, qualities: numericQualities(variants) } : {});
    }

    /** Варианты с известной высотой кадра, лучшие первыми: [{k: ключ в variants, n: 1080}]. */
    function numericQualities(variants) {
        return Object.keys(variants || {})
            .map(k => ({ k, n: +(/\d{3,4}/.exec(k) || [0])[0] }))
            .filter(x => x.n && variants[x.k])
            .sort((a, b) => b.n - a.n)
            .map(x => x.k);
    }

    /**
     * Качество по просьбе (голосом): wanted — высота кадра ('2160', '1080'…), 'max' или 'min'.
     * Есть такое — оно; нет — ближайшее ниже, а если ниже ничего нет — самое низкое из имеющихся.
     * → ключ в variants или null, когда выбирать не из чего (одна ссылка или только «авто»).
     */
    function nearestQuality(variants, wanted) {
        const keys = numericQualities(variants);
        if (!keys.length) return null;
        if (wanted === 'max') return keys[0];
        if (wanted === 'min') return keys[keys.length - 1];
        const w = +wanted;
        if (!w) return null;
        return keys.find(k => +/\d{3,4}/.exec(k)[0] <= w) || keys[keys.length - 1];
    }

    /** Экран рецензий поверх карточки; закроется — возвращаем карточку как была. */
    function openReviews(d) {
        const tm = d.meta || {};
        if (!tm.kpId) return;
        ReviewsUI.open({
            kpId: tm.kpId,
            title: d.full.title || d.item.title || '',
            onClose: () => { if (details === d) renderDetails(); }
        });
    }

    function closeDetails() {
        details = null;
        render();
    }

    function formatDuration(min) {
        if (!min) return '';
        const h = Math.floor(min / 60);
        const m = min % 60;
        return h ? I18n.t('common.hoursShort', { n: h }) + (m ? ' ' + I18n.t('common.minutes', { n: m }) : '') : I18n.t('common.minutes', { n: m });
    }

    function formatTime(ms) {
        const s = Math.floor(ms / 1000);
        const h = Math.floor(s / 3600);
        const mm = String(Math.floor(s / 60) % 60).padStart(2, '0');
        const ss = String(s % 60).padStart(2, '0');
        return h ? h + ':' + mm + ':' + ss : Math.floor(s / 60) + ':' + ss;
    }

    function qualityLabel(q) {
        return { auto: I18n.t('bar.scaleAuto'), '2160': '4K', '1440': '1440p', '1080': '1080p', '720': '720p', '480': '480p' }[q] || q;
    }

    /** Качества, которые есть у фильма, в порядке переключения. */
    function qualitiesOf(variants) {
        if (!variants) return [];
        const keys = Object.keys(variants);
        const known = QUALITY_ORDER.filter(q => keys.indexOf(q) >= 0);
        return known.concat(keys.filter(k => known.indexOf(k) < 0));
    }

    function isSeries(d) { return d.item.type === 'multistream' || d.episodes.length > 0; }

    function detailButtons(d) {
        const buttons = [];
        if (isSeries(d)) {
            if (d.episodes.length) {
                const ep = d.episodes[d.epIdx] || d.episodes[0];
                const resume = VodHistory.getResume(idOf(ep.fid));
                buttons.push({
                    label: '▶ ' + (resume ? I18n.t('vod.resumeEpisode', { title: ep.title, time: formatTime(resume) }) : I18n.t('vod.watchEpisode', { title: ep.title })),
                    action: () => playEpisode(d, d.episodes.indexOf(ep), resume)
                });
                if (resume) buttons.push({ label: I18n.t('vod.fromStart'), action: () => playEpisode(d, d.episodes.indexOf(ep), 0) });
            }
        } else if (d.full.url || d.item.url || (d.streams && d.streams.length)) {
            const resume = VodHistory.getResume(idOf(d.item.fid));
            const streams = d.streams || [];
            if (streams.length > 1) {
                // несколько озвучек одного фильма — кнопка на каждую, «▶ Дубляж», «▶ Netflix»…
                streams.forEach((s, i) => buttons.push({
                    label: '▶ ' + (s.name || I18n.t('vod.watch')),
                    action: () => { d.streamIdx = i; playMovie(d, resume); }
                }));
                if (resume) buttons.push({ label: I18n.t('vod.fromStart'), action: () => playMovie(d, 0) });
            } else if (resume) {
                buttons.push({ label: '▶ ' + I18n.t('vod.resumeFrom', { time: formatTime(resume) }), action: () => playMovie(d, resume) });
                buttons.push({ label: I18n.t('vod.fromStart'), action: () => playMovie(d, 0) });
            } else {
                buttons.push({ label: '▶ ' + I18n.t('vod.watch'), action: () => playMovie(d, 0) });
            }
            const qs = qualitiesOf(streamOf(d).variants);
            if (qs.length > 1) {
                if (qs.indexOf(d.quality) < 0) d.quality = 'auto';
                buttons.push({
                    label: I18n.t('bar.quality', { q: qualityLabel(d.quality) }),
                    keep: true,
                    action: () => {
                        d.quality = qs[(qs.indexOf(d.quality) + 1) % qs.length];
                        VodHistory.setQuality(d.quality);
                    }
                });
            }
        }
        // рецензии есть далеко не у всего: кнопку показываем, только когда их правда нашли
        const tm = d.meta || {};
        if (tm.kpId && tm.kpReviews) {
            buttons.push({
                label: I18n.t('vod.reviews', { n: tm.kpReviews }),
                keep: true,
                action: () => openReviews(d)
            });
        }
        const fid = d.item.fid != null ? d.item.fid : d.full.fid;
        if (fid != null) {
            const id = idOf(fid);
            const on = VodFavorites.has(id);
            buttons.push({
                label: d.favBusy ? I18n.t('common.loading') : (on ? '♥ ' : '♡ ') + I18n.t(on ? 'vod.favRemove' : 'vod.favAdd'),
                keep: true,
                action: () => toggleFavorite(d, id)
            });
        }
        return buttons;
    }

    function renderDetails() {
        const d = details;
        detailsEl.classList.toggle('hidden', !d);
        if (!d) return;
        detailsEl.innerHTML = '';
        const item = d.full;

        const poster = document.createElement('div');
        poster.className = 'vod-details-poster';
        const posterUrl = item.posterHi || item.poster;
        if (posterUrl) {
            const img = document.createElement('img');
            img.src = posterUrl;
            img.alt = '';
            img.onerror = () => { img.style.visibility = 'hidden'; };
            poster.appendChild(img);
        }
        detailsEl.appendChild(poster);

        const info = document.createElement('div');
        info.className = 'vod-details-info';
        detailsEl.appendChild(info);

        const title = document.createElement('div');
        title.className = 'vod-details-title';
        title.textContent = item.title;
        info.appendChild(title);

        const meta = document.createElement('div');
        meta.className = 'vod-details-meta';
        const tm = d.meta || {};
        // рейтинги — первыми: издалека это самое заметное в строке. Кинопоиск впереди и ярче — это
        // та оценка, на которую здесь смотрят; TMDB рядом приглушён, чтобы две цифры не спорили.
        const addRating = (value, label, dim) => {
            if (!value) return;
            const r = document.createElement('span');
            r.className = 'vod-rating' + (dim ? ' dim' : '');
            r.textContent = '★ ' + value.toFixed(1);
            const src = document.createElement('span');
            src.className = 'vod-rating-src';
            src.textContent = label;
            r.appendChild(src);
            meta.appendChild(r);
        };
        addRating(tm.kpRating, I18n.t('vod.kpShort'), false);
        addRating(tm.rating, 'TMDB', !!tm.kpRating);
        const parts = [
            item.year,
            isSeries(d) ? (d.episodes.length ? I18n.t('vod.seriesEpisodes', { n: d.episodes.length }) : I18n.t('vod.seriesLower')) : formatDuration(item.duration),
            // больше двух жанров строка не держит — она и так длинная
            (tm.genres || []).slice(0, 2).join(', '),
            item.uhd ? '4K' : (item.fhd ? 'Full HD' : ''),
            item.hdr ? 'HDR' : '',
            item.agelimit ? item.agelimit + '+' : ''
        ].filter(Boolean);
        parts.forEach(p => {
            const s = document.createElement('span');
            s.textContent = p;
            meta.appendChild(s);
        });
        info.appendChild(meta);

        const desc = document.createElement('div');
        desc.className = 'vod-details-desc' + (isSeries(d) ? ' short' : '');
        desc.textContent = item.description || '';
        info.appendChild(desc);

        const btnRow = document.createElement('div');
        btnRow.className = 'vod-details-buttons';
        const buttons = detailButtons(d);
        d.btnIdx = Math.max(0, Math.min(d.btnIdx, buttons.length - 1));
        if (d.zone === 'episodes' && !d.episodes.length) d.zone = 'buttons';
        buttons.forEach((b, i) => {
            const el = document.createElement('div');
            el.className = 'vod-details-btn' + (d.zone === 'buttons' && i === d.btnIdx && !picker ? ' focused' : '');
            el.textContent = b.label;
            el.addEventListener('click', () => { d.zone = 'buttons'; d.btnIdx = i; activateDetails(); });
            btnRow.appendChild(el);
        });
        if (d.loading) message(btnRow, I18n.t('common.loading'));
        else if (d.error) message(btnRow, I18n.t('common.loadFailed', { error: d.error }));
        else if (d.favError) message(btnRow, I18n.t('vod.favFailed', { error: d.favError }));
        info.appendChild(btnRow);

        if (d.episodes.length) renderEpisodes(d, info);

        const hint = document.createElement('div');
        hint.className = 'vod-details-hint';
        hint.textContent = d.episodes.length
            ? I18n.t('vod.hintSeries')
            : I18n.t('vod.hintMovie');
        detailsEl.appendChild(hint);
    }

    function renderEpisodes(d, parent) {
        const box = document.createElement('div');
        box.className = 'vod-episodes';
        const focusRow = Math.floor(d.epIdx / EP_COLS);
        if (focusRow < d.epFirstRow) d.epFirstRow = focusRow;
        else if (focusRow >= d.epFirstRow + EP_ROWS) d.epFirstRow = focusRow - EP_ROWS + 1;
        const from = d.epFirstRow * EP_COLS;
        const to = Math.min(d.episodes.length, from + EP_ROWS * EP_COLS);
        for (let i = from; i < to; i++) {
            const ep = d.episodes[i];
            const el = document.createElement('div');
            const watched = VodHistory.isWatched(idOf(ep.fid));
            const progress = VodHistory.getProgress(idOf(ep.fid));
            el.className = 'vod-episode' + (d.zone === 'episodes' && i === d.epIdx ? ' focused' : '') +
                (watched ? ' watched' : '');
            el.textContent = ep.title;
            if (progress && !watched) {
                const bar = document.createElement('div');
                bar.className = 'vod-episode-progress';
                const fill = document.createElement('div');
                fill.style.width = Math.round(progress * 100) + '%';
                bar.appendChild(fill);
                el.appendChild(bar);
            }
            el.addEventListener('click', () => playEpisode(d, i, VodHistory.getResume(idOf(ep.fid))));
            box.appendChild(el);
        }
        if (d.episodes.length > to || from > 0) {
            const more = document.createElement('div');
            more.className = 'vod-episodes-more';
            more.textContent = I18n.t('vod.episodesRange', { from: from + 1, to, n: d.episodes.length });
            box.appendChild(more);
        }
        parent.appendChild(box);
    }

    function activateDetails() {
        const d = details;
        if (!d) return;
        if (d.zone === 'episodes') {
            const ep = d.episodes[d.epIdx];
            if (ep) playEpisode(d, d.epIdx, VodHistory.getResume(idOf(ep.fid)));
            return;
        }
        const b = detailButtons(d)[d.btnIdx];
        if (!b) return;
        b.action();
        if (b.keep) renderDetails();
    }

    // ───────────────────────── запуск ─────────────────────────

    /** Выбранная озвучка карточки (у портала она одна). */
    function streamOf(d) {
        const streams = d.streams || [];
        return streams[d.streamIdx || 0] || { url: d.full.url || d.item.url, variants: d.full.variants };
    }

    /**
     * Готовый к воспроизведению объект для app.js / Player.playVod:
     * {vod:true, id, fid, title, url, variants, quality, series:{fid,title,episodes}|null, episodeIdx}
     * id — составной, по нему хранится позиция просмотра; stream — выбранная озвучка (если их несколько).
     */
    function mediaFrom(full, quality, series, episodeIdx, stream) {
        const variants = (stream && stream.variants) || full.variants;
        const qs = qualitiesOf(variants);
        const q = qs.indexOf(quality) >= 0 ? quality : 'auto';
        const url = (variants && variants[q]) || (stream && stream.url) || full.url;
        return {
            vod: true,
            id: idOf(full.fid),
            fid: full.fid,
            name: series ? series.title + ' · ' + full.title : full.title,
            title: series ? series.title + ' · ' + full.title : full.title,
            url,
            variants: variants || null,
            quality: variants && variants[q] ? q : 'auto',
            series: series || null,
            episodeIdx: series ? episodeIdx : -1,
            // для описания по ▲ при просмотре (InfoPanelUI в app.js); у серии своего описания часто нет
            description: full.description || (series && series.description) || '',
            year: full.year || (series && series.year) || null,
            duration: full.duration || 0,
            agelimit: full.agelimit || (series && series.agelimit) || 0,
            poster: full.poster || (series && series.poster) || null,
            rating: full.rating || (series && series.rating) || null,
            ratingSrc: full.ratingSrc || (series && series.ratingSrc) || null,
            genres: full.genres || (series && series.genres) || null
        };
    }

    function playMovie(d, startMs) {
        const stream = streamOf(d);
        if (!stream.url && !stream.variants && !d.full.url && !d.item.url) return;
        opts.onPlay(mediaFrom(Object.assign({}, d.item, d.full), d.quality, null, -1, stream), startMs);
    }

    function playEpisode(d, idx, startMs) {
        prepareEpisode(seriesOf(d), idx, d.quality)
            .then(media => opts.onPlay(media, startMs))
            .catch(e => { d.error = e.message || String(e); renderDetails(); });
    }

    /** Серия idx сериала series ({fid, title, episodes}) — с вариантами качества из её деталей. */
    /** Сериал из карточки — для prepareEpisode (описание и год — для серий без своих). */
    function seriesOf(d) {
        return {
            fid: d.item.fid, title: d.full.title, episodes: d.episodes,
            description: d.full.description || d.item.description || '',
            year: d.full.year || d.item.year || null,
            agelimit: d.full.agelimit || d.item.agelimit || 0,
            poster: d.full.poster || d.item.poster || null
        };
    }

    async function prepareEpisode(series, idx, quality) {
        const ep = series.episodes[idx];
        if (!ep) throw new Error(I18n.t('vod.noEpisode'));
        let full = ep;
        let stream = null;
        try {
            const d = await client.details(ep);
            full = Object.assign({}, ep, d.item);
            // у серии озвучки тоже могут быть свои; портал отдаёт одну
            stream = d.streams && d.streams.length ? d.streams[0] : null;
        } catch (e) { /* без вариантов качества */ }
        VodHistory.setLastEpisode(idOf(series.fid), idOf(ep.fid));
        return mediaFrom(full, quality || VodHistory.getQuality(), series, idx, stream);
    }

    // ───────────────────────── фильтры и поиск ─────────────────────────

    function openPicker(fi) {
        const f = root.filters[fi];
        const sel = filterSel[fi];
        picker = {
            title: f.title,
            options: [I18n.t('vod.all')].concat(f.items.map(i => i.title)),
            focus: sel != null ? sel + 1 : 0,
            onPick: (idx) => {
                if (idx === 0) delete filterSel[fi];
                else filterSel[fi] = idx - 1;
                applyFilter();
            }
        };
        render();
    }

    function applyFilter() {
        const keys = Object.keys(filterSel);
        if (!keys.length) { if (screen === 'list' && list.kind === 'filter') backToMain(); else render(); return; }
        searchInput.value = '';
        const labels = keys.map(fi => root.filters[fi].items[filterSel[fi]].title);
        const request = client.filterRequest(keys.map(fi => root.filters[fi].items[filterSel[fi]].request));
        openList('filter', I18n.t('vod.filterTitle', { list: labels.join(' · ') }), request);
    }

    function renderPicker() {
        pickerEl.classList.toggle('hidden', !picker);
        if (!picker) return;
        pickerEl.innerHTML = '';
        const title = document.createElement('div');
        title.className = 'vod-picker-title';
        title.textContent = picker.title;
        const listEl = document.createElement('div');
        listEl.className = 'vod-picker-list';
        picker.options.forEach((label, i) => {
            const el = document.createElement('div');
            el.className = 'vod-picker-item' + (i === picker.focus ? ' focused' : '');
            el.textContent = label;
            el.addEventListener('click', () => { picker.focus = i; pickFocused(); });
            listEl.appendChild(el);
        });
        pickerEl.appendChild(title);
        pickerEl.appendChild(listEl);
        const focused = listEl.children[picker.focus];
        if (focused) {
            const top = focused.offsetTop;
            if (top < listEl.scrollTop) listEl.scrollTop = top;
            else if (top + focused.offsetHeight > listEl.scrollTop + listEl.clientHeight) {
                listEl.scrollTop = top + focused.offsetHeight - listEl.clientHeight;
            }
        }
    }

    function pickFocused() {
        const p = picker;
        picker = null;
        p.onPick(p.focus);
        render();
    }

    function startSearch() {
        searchInput.classList.remove('hidden');
        searchInput.focus();
        try { searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length); } catch (e) { /* ignore */ }
    }

    function isEditing() {
        return !!searchInput && document.activeElement === searchInput;
    }

    /** submit — искать введённое (OK / «Готово»), иначе просто закрыть клавиатуру. */
    function stopEditing(submit) {
        if (!searchInput) return;
        if (document.activeElement === searchInput) searchInput.blur();
        const text = searchInput.value.trim();
        if (!text) searchInput.classList.add('hidden');
        if (submit && text && client && root) {
            rememberSearch(text);
            filterSel = {};
            openList('search', I18n.t('vod.searchTitle', { text }), client.searchRequest(root, text));
            renderRecentSearches();
        }
    }

    function activateHeader() {
        const b = headerButtons()[headerIdx];
        if (!b) return;
        if (b.id === 'search') startSearch();
        else if (b.id === 'filter') openPicker(b.fi);
        else if (b.id === 'reset') { filterSel = {}; applyFilter(); }
    }

    // ───────────────────────── пульт ─────────────────────────

    /**
     * key: 'up' | 'down' | 'left' | 'right' | 'enter' | 'back'. Всё, что пришло, пока экран открыт,
     * обрабатывается здесь (app.js кнопки дальше не передаёт).
     */
    function handleKey(key) {
        // рецензии лежат поверх карточки и внутри портала — кнопки их, пока экран открыт
        if (ReviewsUI.isOpen()) return ReviewsUI.handleKey(key);
        if (isEditing()) {
            if (key === 'enter') stopEditing(true);
            else if (key === 'back') stopEditing(false);
            return;
        }
        if (picker) return pickerKey(key);
        if (details) return detailsKey(key);
        if (key === 'back') {
            if (zone === 'header' && screen === 'main') { zone = 'body'; render(); }
            else if (screen === 'list') backToMain();
            else opts.onExit();
            return;
        }
        if (!root) return;
        if (zone === 'header') return headerKey(key);
        if (zone === 'recent') return recentKey(key);
        if (screen === 'list') return listKey(key);
        return mainKey(key);
    }

    function headerKey(key) {
        const count = headerButtons().length;
        if (key === 'left') headerIdx = Math.max(0, headerIdx - 1);
        else if (key === 'right') headerIdx = Math.min(count - 1, headerIdx + 1);
        else if (key === 'down') zone = recentSearches.length ? 'recent' : 'body';
        else if (key === 'enter') return activateHeader();
        render();
    }

    function recentKey(key) {
        if (key === 'left') recentIdx = Math.max(0, recentIdx - 1);
        else if (key === 'right') recentIdx = Math.min(recentSearches.length - 1, recentIdx + 1);
        else if (key === 'up') zone = 'header';
        else if (key === 'down') zone = 'body';
        else if (key === 'enter') return runRecentSearch(recentIdx);
        else if (key === 'back') { zone = 'body'; render(); return; }
        render();
    }

    function mainKey(key) {
        const row = rows[rowIdx];
        if (!row) { if (key === 'up') { zone = 'header'; render(); } return; }
        if (key === 'up') {
            if (rowIdx === 0) zone = recentSearches.length ? 'recent' : 'header';
            else rowIdx--;
        } else if (key === 'down') {
            rowIdx = Math.min(rows.length - 1, rowIdx + 1);
        } else if (key === 'left') {
            row.focusCol = Math.max(0, row.focusCol - 1);
        } else if (key === 'right') {
            const items = rowItems(row);
            if (items.length) row.focusCol = Math.min(items.length, row.focusCol + 1);
        } else if (key === 'enter') {
            const items = rowItems(row);
            if (!items.length) return;
            if (row.focusCol >= items.length) return openRowAll(row);
            return openItem(items[row.focusCol]);
        }
        render();
    }

    function listKey(key) {
        const l = list;
        const n = l.items.length;
        if (key === 'up') {
            if (l.focusIdx < ROW_TILES) zone = 'header';
            else l.focusIdx -= ROW_TILES;
        } else if (key === 'down') {
            if (n && Math.floor(l.focusIdx / ROW_TILES) < Math.floor((n - 1) / ROW_TILES)) {
                l.focusIdx = Math.min(n - 1, l.focusIdx + ROW_TILES);
            }
        } else if (key === 'left') {
            l.focusIdx = Math.max(0, l.focusIdx - 1);
        } else if (key === 'right') {
            l.focusIdx = Math.min(Math.max(0, n - 1), l.focusIdx + 1);
        } else if (key === 'enter') {
            if (l.items[l.focusIdx]) return openItem(l.items[l.focusIdx]);
            return;
        }
        render();
    }

    function detailsKey(key) {
        const d = details;
        if (key === 'back') return closeDetails();
        if (key === 'enter') return activateDetails();
        if (d.zone === 'buttons') {
            const count = detailButtons(d).length;
            if (key === 'left') d.btnIdx = Math.max(0, d.btnIdx - 1);
            else if (key === 'right') d.btnIdx = Math.min(count - 1, d.btnIdx + 1);
            else if (key === 'up') {
                const i = buttonInLine(focusedEl('.vod-details-btn', d.btnIdx), -1);
                if (i >= 0) d.btnIdx = i;
            } else if (key === 'down') {
                const i = buttonInLine(focusedEl('.vod-details-btn', d.btnIdx), 1);
                if (i >= 0) d.btnIdx = i;
                else if (d.episodes.length) d.zone = 'episodes';
            }
        } else {
            const n = d.episodes.length;
            if (key === 'left') d.epIdx = Math.max(0, d.epIdx - 1);
            else if (key === 'right') d.epIdx = Math.min(n - 1, d.epIdx + 1);
            else if (key === 'down') d.epIdx = Math.min(n - 1, d.epIdx + EP_COLS);
            else if (key === 'up') {
                if (d.epIdx < EP_COLS) {
                    // в нижнюю строку кнопок — на ту, что над серией
                    const i = buttonInLine(focusedEl('.vod-episode.focused', 0), -1);
                    d.zone = 'buttons';
                    d.btnIdx = i >= 0 ? i : 0;
                } else d.epIdx -= EP_COLS;
            }
        }
        renderDetails();
    }

    function focusedEl(selector, idx) {
        return detailsEl.querySelectorAll(selector)[idx] || null;
    }

    /**
     * Кнопок карточки бывает много (озвучки, качество, рецензии, избранное) — они переносятся на
     * несколько строк. ▲▼ ходят по строкам: индекс кнопки в соседней строке выше (dir −1) или ниже (+1),
     * ближайшей к from по горизонтали; −1 — строки там нет. Строки берутся из раскладки на экране.
     * from может быть и серией — для неё «строка выше» как раз последняя строка кнопок.
     */
    function buttonInLine(from, dir) {
        if (!from || !from.getBoundingClientRect) return -1;
        const fr = from.getBoundingClientRect();
        const cx = fr.left + fr.width / 2;
        const rects = Array.prototype.map.call(detailsEl.querySelectorAll('.vod-details-btn'), el => el.getBoundingClientRect());
        let lineTop = null;
        rects.forEach(r => {
            const beyond = dir > 0 ? r.top > fr.top + 4 : r.top < fr.top - 4;
            if (beyond && (lineTop === null || (dir > 0 ? r.top < lineTop : r.top > lineTop))) lineTop = r.top;
        });
        if (lineTop === null) return -1;
        let best = -1, bestDx = Infinity;
        rects.forEach((r, i) => {
            if (Math.abs(r.top - lineTop) > 4) return;
            const dx = Math.abs(r.left + r.width / 2 - cx);
            if (dx < bestDx) { bestDx = dx; best = i; }
        });
        return best;
    }

    function pickerKey(key) {
        if (key === 'back') { picker = null; render(); return; }
        if (key === 'enter' || key === 'right') return pickFocused();
        if (key === 'up') picker.focus = Math.max(0, picker.focus - 1);
        else if (key === 'down') picker.focus = Math.min(picker.options.length - 1, picker.focus + 1);
        renderPicker();
    }

    function setAddonUrl(url) {
        addonUrl = url || '';
        ReviewsUI.setAddonUrl(addonUrl);   // рецензии он спрашивает у того же аддона
    }

    return {
        init, open, show, hide, isOpen, getPortalUrl, handleKey, isEditing, stopEditing,
        prepareEpisode, playId, openItem, qualitiesOf, qualityLabel, formatTime, setAddonUrl
    };
})();

if (typeof module !== 'undefined') module.exports = { VodUI };
