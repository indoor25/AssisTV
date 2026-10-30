/**
 * Окно выбора плейлиста (#playlist-dialog) — RETURN на ленте групп главного экрана и RETURN на
 * главной видеопортала. ▲▼ — выбор, OK — открыть, ► или последняя строка «⚙ Настройки» — Настройки
 * (поверх окна), RETURN — диалог «Закрыть программу?» (это в
 * app.js; окно остаётся под диалогом, «Нет» возвращает сюда).
 *
 * items: [{ name, kind: 'tv' | 'vod', state?: 'failed' | 'building' }], onPick(index); opts.onSettings — строка «Настройки».
 */
const PlaylistDialogUI = (() => {
    let container = null;
    let listEl = null;
    let hintEl = null;
    let items = [];
    let focused = 0;
    let current = -1;
    let onPick = () => {};
    let onSettings = () => {};

    function init(el, opts) {
        container = el;
        if (opts && opts.onSettings) onSettings = opts.onSettings;
        container.innerHTML = '';
        const box = document.createElement('div');
        box.className = 'playlist-dialog-box';
        const title = document.createElement('div');
        title.className = 'playlist-dialog-title';
        title.textContent = I18n.t('playlists.title');
        listEl = document.createElement('div');
        listEl.className = 'playlist-dialog-list';
        hintEl = document.createElement('div');
        hintEl.className = 'playlist-dialog-hint';
        box.appendChild(title);
        box.appendChild(listEl);
        box.appendChild(hintEl);
        container.appendChild(box);
    }

    function render() {
        listEl.innerHTML = '';
        hintEl.textContent = items.length
            ? I18n.t('playlists.hint')
            : I18n.t('playlists.hintEmpty');
        if (!items.length) {
            const empty = document.createElement('div');
            empty.className = 'playlist-dialog-empty';
            empty.textContent = I18n.t('playlists.empty');
            listEl.appendChild(empty);
        }
        items.forEach((it, i) => {
            const row = document.createElement('div');
            row.className = 'playlist-dialog-item' + (i === focused ? ' focused' : '') + (i === current ? ' current' : '');
            const kind = document.createElement('span');
            kind.className = 'playlist-dialog-kind ' + it.kind;
            kind.textContent = I18n.t(it.kind === 'vod' ? 'playlists.kindVod' : 'playlists.kindTv');
            const name = document.createElement('span');
            name.className = 'playlist-dialog-name';
            name.textContent = it.name;
            row.appendChild(kind);
            row.appendChild(name);
            // справа: «не загрузился» / «собирается…» (из аддона), иначе «открыт» у текущего
            const noteText = it.state === 'failed' ? I18n.t('playlists.failed')
                : it.state === 'building' ? I18n.t('playlists.building')
                : i === current ? I18n.t('playlists.open') : '';
            if (noteText) {
                const note = document.createElement('span');
                note.className = 'playlist-dialog-note' + (it.state === 'failed' ? ' failed' : '');
                note.textContent = noteText;
                row.appendChild(note);
            }
            row.addEventListener('click', () => { focused = i; activateFocused(); });
            listEl.appendChild(row);
        });
        // строка «Настройки» — всегда последней (индекс items.length), и когда плейлистов нет
        const settings = document.createElement('div');
        settings.className = 'playlist-dialog-item playlist-dialog-settings' + (focused === items.length ? ' focused' : '');
        settings.textContent = '⚙  ' + I18n.t('home.settings');
        settings.addEventListener('click', () => { focused = items.length; activateFocused(); });
        listEl.appendChild(settings);
    }

    function open(list, currentIndex, pick) {
        if (!container) return;
        items = list;
        current = currentIndex;
        focused = Math.max(0, Math.min(currentIndex, items.length));   // пусто — сразу на «Настройках»
        onPick = pick;
        container.classList.remove('hidden');
        render();
    }

    function close() { if (container) container.classList.add('hidden'); }
    function isOpen() { return !!container && !container.classList.contains('hidden'); }

    function moveFocus(delta) {
        focused = Math.max(0, Math.min(focused + delta, items.length));
        render();
    }

    function activateFocused() {
        if (items[focused]) onPick(focused);
        else onSettings();
    }

    function isEmpty() { return !items.length; }

    return { init, open, close, isOpen, isEmpty, moveFocus, activateFocused };
})();

if (typeof module !== 'undefined') module.exports = { PlaylistDialogUI };
