/**
 * Подборка фильмов от ассистента (#suggest-view): полупрозрачная страница поверх того, что идёт на экране, —
 * постеры рядами по шесть и под ними описание выбранного с рейтингом. Рядов сколько угодно: страница
 * прокручивается вниз за выбором (следующий ряд выглядывает снизу).
 *
 * Приходит по MQTT iptv/<tv_id>/suggest от аддона: {title, seconds?, items: [{n, id, title, year, kind, quality,
 * poster, kpRating, rating, genres, description}]} («подбери что-нибудь по моему избранному»). Пустой items — убрать.
 * ◄► ▲▼ — выбор, OK или цифра (первые девять) — смотреть, RETURN — закрыть; выбрать можно и голосом («включи второй») — тогда фильм
 * включит аддон, а страница уберётся сама. Без нажатий закрывается через seconds.
 *
 * Тексты из сети ставятся только textContent.
 */
const SuggestUI = (function () {
    let root = null;
    const COLS = 6;
    const ROW_H = 508;    // высота ряда плиток вместе с отступом (см. .suggest-tile в style.css)
    const MAX = 30;
    let state = null;     // {items, focus, timer, seconds}
    let opts = { onPlay: null, posterUrl: null };

    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    function init(o) {
        opts = Object.assign(opts, o);
        root = document.getElementById('suggest-view');
    }

    function isOpen() { return !!state; }

    function arm() {
        clearTimeout(state.timer);
        state.timer = setTimeout(hide, state.seconds * 1000);
    }

    function show(msg) {
        const items = msg && Array.isArray(msg.items) ? msg.items.filter(i => i && i.id && i.title).slice(0, MAX) : [];
        if (!items.length) return hide();
        if (state) clearTimeout(state.timer);
        state = { items, focus: 0, timer: null, seconds: Math.max(20, Math.min(600, Number(msg.seconds) || 180)) };
        root.innerHTML = '';
        const head = el('div', 'suggest-title', String(msg.title || ''));
        head.appendChild(el('span', 'suggest-count'));
        root.appendChild(head);
        const rows = el('div', 'suggest-rows');
        const row = el('div', 'suggest-row');
        items.forEach((it, i) => {
            const tile = el('div', 'suggest-tile');
            const pic = el('div', 'suggest-poster');
            const url = it.poster && opts.posterUrl ? opts.posterUrl(it.id) : null;
            if (url) {
                const img = document.createElement('img');
                img.onerror = () => { img.remove(); };
                img.src = url;
                pic.appendChild(img);
            }
            pic.appendChild(el('div', 'suggest-num', String(i + 1)));
            if (it.quality) pic.appendChild(el('div', 'suggest-quality', String(it.quality)));
            tile.appendChild(pic);
            tile.appendChild(el('div', 'suggest-name', String(it.title)));
            const sub = el('div', 'suggest-sub');
            if (it.kpRating || it.rating) sub.appendChild(el('span', 'suggest-star', '★ ' + Number(it.kpRating || it.rating).toFixed(1)));
            if (it.year) sub.appendChild(el('span', null, String(it.year)));
            tile.appendChild(sub);
            row.appendChild(tile);
        });
        rows.appendChild(row);
        root.appendChild(rows);
        root.appendChild(el('div', 'suggest-info'));
        const hint = el('div', 'suggest-hint');
        hint.innerHTML = I18n.t('suggest.hint');
        root.appendChild(hint);
        root.classList.remove('hidden');
        render();
        arm();
    }

    function render() {
        const tiles = root.querySelectorAll('.suggest-tile');
        for (let i = 0; i < tiles.length; i++) tiles[i].classList.toggle('focused', i === state.focus);
        // страница едет за выбором: ряд с выбранным фильмом — верхний
        root.querySelector('.suggest-row').style.transform = 'translateY(' + (-Math.floor(state.focus / COLS) * ROW_H) + 'px)';
        root.querySelector('.suggest-count').textContent = state.items.length > COLS ? (state.focus + 1) + ' / ' + state.items.length : '';
        const it = state.items[state.focus];
        const info = root.querySelector('.suggest-info');
        info.innerHTML = '';
        info.appendChild(el('div', 'suggest-info-title', String(it.title) + (it.year ? ' (' + it.year + ')' : '')));
        const meta = el('div', 'suggest-info-meta');
        if (it.kpRating) meta.appendChild(el('span', 'suggest-star', '★ ' + Number(it.kpRating).toFixed(1) + ' ' + I18n.t('suggest.kp')));
        if (it.rating) meta.appendChild(el('span', 'suggest-star dim', '★ ' + Number(it.rating).toFixed(1) + ' TMDB'));
        if (it.kind === 'series') meta.appendChild(el('span', null, I18n.t('suggest.series')));
        if (Array.isArray(it.genres) && it.genres.length) meta.appendChild(el('span', null, it.genres.join(', ')));
        info.appendChild(meta);
        info.appendChild(el('div', 'suggest-info-desc', String(it.description || I18n.t('suggest.noDesc'))));
    }

    function hide() {
        if (!state) return;
        clearTimeout(state.timer);
        state = null;
        root.classList.add('hidden');
        root.innerHTML = '';
    }

    function pick(idx) {
        const it = state && state.items[idx];
        if (!it) return;
        hide();
        if (opts.onPlay) opts.onPlay(it);
    }

    /** Кнопка пульта; true — страница её забрала. */
    function handleKey(name, arg) {
        if (!state) return false;
        arm();
        const n = state.items.length;
        if (name === 'onLeft') { state.focus = (state.focus - 1 + n) % n; render(); return true; }
        if (name === 'onRight') { state.focus = (state.focus + 1) % n; render(); return true; }
        if (name === 'onEnter') { pick(state.focus); return true; }
        if (name === 'onBack') { hide(); return true; }
        if (name === 'onNumber') { if (arg >= 1 && arg <= n) pick(arg - 1); return true; }
        // ▲▼ — по рядам; в неполном последнем ряду — на последний фильм; за края не уходим
        if (name === 'onDown') {
            if (Math.floor(state.focus / COLS) < Math.floor((n - 1) / COLS)) { state.focus = Math.min(n - 1, state.focus + COLS); render(); }
            return true;
        }
        if (name === 'onUp') { if (state.focus >= COLS) { state.focus -= COLS; render(); } return true; }
        return false;
    }

    return { init, show, hide, isOpen, handleKey };
})();
