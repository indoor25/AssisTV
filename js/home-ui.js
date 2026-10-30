/**
 * Главный экран (#home-view): плитки каналов выбранной группы, до 6 в ряд (по размеру TV); группы — лентой внизу;
 * вверху — значок настроек. Открывается RETURN во время просмотра (см. onBack в app.js),
 * воспроизведение на это время останавливается (это делает app.js, не модуль).
 *
 * Плитка: номер канала в левом верхнем углу (позиция в общей сортировке — тот же номер, что для
 * ввода цифрами и в боковом списке), логотип по центру, крупное название, под ним — текущая
 * передача, внизу — полоска, сколько передачи уже прошло (0% слева … 100% на всю ширину).
 *
 * Навигация — три зоны сверху вниз: 'header' (настройки) → 'grid' (плитки) → 'groups' (группы).
 * Открывается СРАЗУ на ленте групп (пользователю было тяжело до неё долистывать): RETURN из
 * плиток/настроек возвращает на ленту групп, RETURN на ленте — диалог выхода (это в app.js),
 * CH+ — прыжок наверх к «Настройкам», CH− — на ленту групп.
 *   grid:   ◄► — соседняя плитка, ▲▼ — ряд выше/ниже ПО КРУГУ (с первого ряда — в последний);
 *           OK — смотреть канал.
 *   groups: ◄► — соседняя группа (плитки меняются сразу), ▲ — к плиткам.
 *   header: ▼ — к плиткам, OK — настройки.
 *
 * Рисуются только видимые ряды (rowsVisible): в группе бывают сотни каналов, а у каждой
 * плитки — картинка; весь набор разом телевизор бы не потянул (см. историю со списком каналов).
 */
const HomeUI = (() => {
    // Сетка подстраивается под телевизор (layoutFor): плитки квадратные, ряд — на всю ширину, но не больше
    // MAX_COLS в ряд. Приложение на любом TV рисуется в 1920×1080, поэтому физический размер плитки считается по
    // диагонали из модели (QE55… → 55"): меньше MIN_TILE_CM — колонок 5, потом 4. Пример: 48"+ — 6 в ряд,
    // 40–47" — 5, 32" — 4. Ряды — сколько влезает по высоте (не меньше 2); содержимое плитки масштабируется.
    const MAX_COLS = 6;
    const MIN_COLS = 4;
    const GAP = 12;
    const MAX_WIDTH = 1872;          // почти весь экран: по 24 px с боков (приложение 1920 px)
    const MIN_TILE_CM = 16;          // на 55" плитка 285 px ≈ 18 см — «чуть меньше, чем сейчас»
    const BASE_TILE = 285;           // размер плитки, под который подобраны шрифты и логотип (--tile-scale 1)
    const DEFAULT_DIAGONAL = 55;     // модель не узнали — как у TV разработки
    let cols = MAX_COLS;
    let rowsVisible = 3;
    const REFRESH_MS = 30 * 1000;   // перерисовка «что идёт» и полосок прогресса

    let container = null;
    let innerEl = null;
    let gridEl = null;
    let groupsEl = null;
    let groupsTrackEl = null;
    let groupsPillEl = null;
    let groupEls = [];
    let settingsEl = null;
    let groupTitleEl = null;
    let onSelect = () => {};
    let onSettings = () => {};
    let onLockedGroup = () => {};

    let allChannels = [];
    let numberByKey = {};
    let groups = [];
    let groupIdx = 0;
    let groupChannels = [];
    let focusIdx = 0;        // индекс плитки внутри группы
    let firstRow = 0;        // верхний видимый ряд
    let zone = 'grid';       // 'header' | 'grid' | 'groups'
    let refreshTimer = null;

    function init(el, opts = {}) {
        container = el;
        onSelect = opts.onSelect || onSelect;
        onSettings = opts.onSettings || onSettings;
        onLockedGroup = opts.onLockedGroup || onLockedGroup;   // OK на группе под PIN (родительский контроль)
        container.innerHTML = '';

        const header = document.createElement('div');
        header.className = 'home-header';
        settingsEl = document.createElement('div');
        settingsEl.className = 'home-settings';
        settingsEl.innerHTML = '<span class="home-gear">&#9881;</span><span>' + I18n.t('home.settings') + '</span>';
        settingsEl.addEventListener('click', () => onSettings());
        groupTitleEl = document.createElement('div');
        groupTitleEl.className = 'home-group-title';
        header.appendChild(settingsEl);
        header.appendChild(groupTitleEl);

        gridEl = document.createElement('div');
        gridEl.className = 'home-grid';
        groupsEl = document.createElement('div');
        groupsEl.className = 'home-groups';
        groupsTrackEl = document.createElement('div');
        groupsTrackEl.className = 'home-groups-track';
        groupsPillEl = document.createElement('div');
        groupsPillEl.className = 'home-groups-pill instant';
        groupsTrackEl.appendChild(groupsPillEl);
        groupsEl.appendChild(groupsTrackEl);

        // шапка, плитки и группы — в одном контейнере шириной ровно в сетку плиток (applyLayout): края совпадают
        innerEl = document.createElement('div');
        innerEl.className = 'home-inner';
        innerEl.appendChild(header);
        innerEl.appendChild(gridEl);
        innerEl.appendChild(groupsEl);
        container.appendChild(innerEl);
    }

    function groupOf(ch) { return ChannelStore.shownGroupOf(ch, groups); }

    /** channels — ChannelStore.getAll(); вызывать при открытии и после перезагрузки плейлиста/EPG. */
    function setChannels(channels) {
        const keepGroup = groups[groupIdx];
        const keepKey = groupChannels[focusIdx] && groupChannels[focusIdx].key;
        allChannels = channels;
        numberByKey = {};
        channels.forEach((ch, i) => { numberByKey[ch.key] = i + 1; });
        groups = ChannelStore.groupsOf(channels);   // «Все каналы» — последней
        buildGroups();
        if (isOpen()) selectGroup(Math.max(0, groups.indexOf(keepGroup)), keepKey);
    }

    function selectGroup(idx, focusKey) {
        groupIdx = Math.max(0, Math.min(idx, groups.length - 1));
        // группа под замком родительского контроля — плиток нет, пока не введут PIN (OK на ленте групп)
        groupChannels = Parental.isGroupLocked(groups[groupIdx]) ? []
            : allChannels.filter(ch => ChannelStore.inGroup(ch, groups[groupIdx]));
        const found = focusKey ? groupChannels.findIndex(c => c.key === focusKey) : -1;
        focusIdx = found >= 0 ? found : 0;
        firstRow = 0;
        renderAll();
    }

    function renderAll() {
        groupTitleEl.textContent = (groups[groupIdx] ? ChannelStore.groupLabel(groups[groupIdx]) : '') + (Parental.isGroupLocked(groups[groupIdx]) ? '' : ' · ' + groupChannels.length);
        settingsEl.classList.toggle('focused', zone === 'header');
        renderGroups();
        renderGrid();
    }

    /**
     * Надписи групп создаются только при смене списка групп: параллелограмм выбранной группы — отдельный элемент поверх
     * общей подложки, и при переключении она переезжает (CSS transition), а не перерисовывается заново.
     */
    function buildGroups() {
        if (!groupsTrackEl) return;
        groupEls.forEach(el => el.remove());
        groupEls = groups.map((g, i) => {
            const el = document.createElement('div');
            el.className = 'home-group';
            if (Parental.isProtectedGroup(g)) el.appendChild(Parental.lockIcon(Parental.isUnlocked()));
            el.appendChild(document.createTextNode(ChannelStore.groupLabel(g)));
            el.addEventListener('click', () => { zone = 'grid'; selectGroup(i); });
            groupsTrackEl.appendChild(el);
            return el;
        });
        groupsPillEl.classList.add('instant');   // новый список — выделение встаёт на место без анимации
    }

    function renderGroups() {
        groupEls.forEach((el, i) => el.classList.toggle('current', i === groupIdx));
        groupsEl.classList.toggle('focused', zone === 'groups');
        const cur = groupEls[groupIdx];
        if (!cur || !cur.offsetWidth) return;   // экран ещё скрыт — размеров нет, встанет при открытии
        // лента групп шире экрана — прокручиваем так, чтобы выбранная была видна
        const left = cur.offsetLeft - 40;
        const right = cur.offsetLeft + cur.offsetWidth + 40;
        if (left < groupsTrackEl.scrollLeft) groupsTrackEl.scrollLeft = left;
        else if (right > groupsTrackEl.scrollLeft + groupsTrackEl.clientWidth) groupsTrackEl.scrollLeft = right - groupsTrackEl.clientWidth;
        groupsPillEl.style.width = cur.offsetWidth + 'px';
        groupsPillEl.style.transform = 'translateX(' + cur.offsetLeft + 'px) skewX(-20deg)';   // параллелограмм
        if (groupsPillEl.classList.contains('instant')) {
            void groupsPillEl.offsetWidth;   // применить положение без анимации, дальше — с ней
            groupsPillEl.classList.remove('instant');
        }
    }

    function renderGrid() {
        const focusRow = Math.floor(focusIdx / cols);
        if (focusRow < firstRow) firstRow = focusRow;
        else if (focusRow >= firstRow + rowsVisible) firstRow = focusRow - rowsVisible + 1;

        const now = AppClock.now();
        gridEl.innerHTML = '';
        if (Parental.isGroupLocked(groups[groupIdx])) {
            const box = document.createElement('div');
            box.className = 'home-locked';
            box.appendChild(Parental.lockIcon(false));
            box.appendChild(Object.assign(document.createElement('div'), { textContent: I18n.t('home.groupLocked') }));
            box.appendChild(Object.assign(document.createElement('small'), { textContent: I18n.t('home.groupLockedHint') }));
            gridEl.appendChild(box);
            return;
        }
        if (!groupChannels.length) {
            gridEl.textContent = I18n.t('home.groupEmpty');
            return;
        }
        const from = firstRow * cols;
        const to = Math.min(groupChannels.length, from + rowsVisible * cols);
        const fragment = document.createDocumentFragment();
        for (let i = from; i < to; i++) {
            fragment.appendChild(buildTile(groupChannels[i], i, now));
        }
        gridEl.appendChild(fragment);
    }

    function buildTile(channel, idx, now) {
        const tile = document.createElement('div');
        tile.className = 'home-tile' + (zone === 'grid' && idx === focusIdx ? ' focused' : '');

        const num = document.createElement('div');
        num.className = 'home-tile-number';
        num.textContent = numberByKey[channel.key] || '';
        tile.appendChild(num);
        const badge = ChannelStore.archiveBadge(channel);
        if (badge) tile.appendChild(badge);

        const logoBox = document.createElement('div');
        logoBox.className = 'home-tile-logo';
        if (channel.logo) {
            const img = document.createElement('img');
            img.src = channel.logo;
            img.alt = '';
            img.onerror = () => { img.style.visibility = 'hidden'; };
            logoBox.appendChild(img);
        }
        tile.appendChild(logoBox);

        const name = document.createElement('div');
        name.className = 'home-tile-name';
        name.textContent = channel.name;
        tile.appendChild(name);

        const prog = ChannelStore.getCurrentProgrammeFor(channel);
        const nowEl = document.createElement('div');
        nowEl.className = 'home-tile-now';
        nowEl.textContent = prog ? prog.title : '';
        tile.appendChild(nowEl);

        const bar = document.createElement('div');
        bar.className = 'home-tile-progress';
        if (prog) {
            const fill = document.createElement('div');
            fill.style.width = Math.max(0, Math.min(100, (now - prog.start) / (prog.stop - prog.start) * 100)) + '%';
            bar.appendChild(fill);
        }
        tile.appendChild(bar);

        tile.addEventListener('click', () => onSelect(channel));
        return tile;
    }

    /** currentChannel — открыть на его группе и с фокусом на нём. */
    /** Диагональ в дюймах из модели Samsung: QE55QN85C, UE43AU7100, QN65…, GQ75… → 55, 43, 65, 75. */
    function screenDiagonal() {
        try {
            const pi = webapis.productinfo;
            const model = (pi.getRealModel && pi.getRealModel()) || pi.getModel() || '';
            const m = /^[A-Z]{2}(\d{2,3})(?!\d)/.exec(model);
            if (m && +m[1] >= 19 && +m[1] <= 120) return +m[1];
        } catch (e) { /* не TV или API недоступен */ }
        return DEFAULT_DIAGONAL;
    }

    /**
     * Раскладка плиток для области width×height (px) на экране diagonal дюймов (16:9, приложение — 1920 px в ширину):
     * {cols, rows, tile (px), cm — сторона плитки на экране}.
     */
    function layoutFor(width, height, diagonal) {
        const cmPerPx = diagonal * 2.54 * 16 / Math.sqrt(16 * 16 + 9 * 9) / 1920;
        let c = MAX_COLS;
        let tile = Math.floor((width - (c - 1) * GAP) / c);
        while (c > MIN_COLS && tile * cmPerPx < MIN_TILE_CM) {
            c--;
            tile = Math.floor((width - (c - 1) * GAP) / c);
        }
        // рядов — сколько ближе всего по высоте; плитка ужимается, чтобы они влезли целиком (сетка по центру)
        const rows = Math.max(2, Math.round((height + GAP) / (tile + GAP)));
        tile = Math.min(tile, Math.floor((height - (rows - 1) * GAP) / rows));
        return { cols: c, rows, tile, cm: Math.round(tile * cmPerPx * 10) / 10 };
    }

    function applyLayout() {
        const l = layoutFor(MAX_WIDTH, gridEl.clientHeight || 912, screenDiagonal());
        cols = l.cols;
        rowsVisible = l.rows;
        gridEl.style.gridTemplateColumns = 'repeat(' + l.cols + ', ' + l.tile + 'px)';
        gridEl.style.gridAutoRows = l.tile + 'px';
        container.style.setProperty('--tile-scale', String(l.tile / BASE_TILE));
        const width = l.cols * l.tile + (l.cols - 1) * GAP;
        innerEl.style.width = width + 'px';
        // часы на главном экране — справа, вровень с краем плиток (style.css body.home-open #clock)
        document.body.style.setProperty('--home-side', Math.round((1920 - width) / 2) + 'px');
    }

    function open(currentChannel) {
        if (!container) return;
        container.classList.remove('hidden');
        document.body.classList.add('home-open');
        applyLayout();
        zone = 'groups';
        const g = currentChannel ? groups.indexOf(groupOf(currentChannel)) : 0;
        selectGroup(g < 0 ? 0 : g, currentChannel && currentChannel.key);
        clearInterval(refreshTimer);
        refreshTimer = setInterval(renderGrid, REFRESH_MS);
    }

    function close() {
        if (!container) return;
        container.classList.add('hidden');
        document.body.classList.remove('home-open');
        clearInterval(refreshTimer);
    }

    function isOpen() {
        return !!container && !container.classList.contains('hidden');
    }

    function setZone(z) {
        zone = z;
        renderAll();
    }

    function getZone() { return zone; }

    function moveHorizontal(delta) {
        if (zone === 'grid') {
            focusIdx = Math.max(0, Math.min(focusIdx + delta, groupChannels.length - 1));
            renderGrid();
        } else if (zone === 'groups') {
            if (groupIdx + delta >= 0 && groupIdx + delta < groups.length) selectGroup(groupIdx + delta);
        }
    }

    function moveVertical(delta) {
        if (zone === 'header') {
            if (delta > 0) setZone(groupChannels.length ? 'grid' : 'groups');
        } else if (zone === 'grid') {
            // Ряды листаются ПО КРУГУ: ▲ с первого ряда — в последний ряд группы, ▼ с последнего —
            // в первый (колонка сохраняется; если в неполном последнем ряду её нет — на последний
            // канал). Из плиток к «Настройкам» и группам — CH+/CH− и RETURN (см. app.js).
            if (!groupChannels.length) return;
            const col = focusIdx % cols;
            const row = Math.floor(focusIdx / cols);
            const lastRow = Math.floor((groupChannels.length - 1) / cols);
            let nextRow = row + delta;
            if (nextRow < 0) nextRow = lastRow;
            else if (nextRow > lastRow) nextRow = 0;
            focusIdx = Math.min(nextRow * cols + col, groupChannels.length - 1);
            renderGrid();
        } else if (zone === 'groups') {
            if (delta < 0) setZone(groupChannels.length ? 'grid' : 'header');
        }
    }

    function activate() {
        if (zone === 'header') onSettings();
        else if (zone === 'grid' && groupChannels[focusIdx]) onSelect(groupChannels[focusIdx]);
        else if (zone === 'groups' && Parental.isGroupLocked(groups[groupIdx])) onLockedGroup(groups[groupIdx]);
        else if (zone === 'groups') setZone(groupChannels.length ? 'grid' : 'groups');
    }

    /** Замок открыли или закрыли — перерисовать группы и плитки на том же месте. */
    function refresh() {
        setChannels(allChannels);
    }

    return { init, setChannels, refresh, open, close, isOpen, moveHorizontal, moveVertical, activate, getZone, setZone, layoutFor };
})();

if (typeof module !== 'undefined') module.exports = { HomeUI };
