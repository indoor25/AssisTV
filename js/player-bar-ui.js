/**
 * Панель управления плеером (#player-bar) внизу экрана — открывается ▼ во время просмотра.
 *
 * Вверху — канал, текущая передача и полоска её прогресса; ниже — ряд кнопок-значков. У выбранной
 * кнопки над ней всплывает подсказка — что она делает. ◄► — выбор кнопки, OK — нажать, ▼/RETURN — закрыть.
 * Сама прячется через HIDE_MS без нажатий, как обычная панель плеера.
 *
 * Там, где перематывать можно (opts.timeline: фильм, архив, эфир канала с архивом), полоска — это линия
 * времени, как в YouTube: ◄► двигают бегунок (opts.onScrub), над бегунком — время, OK — перейти
 * (opts.onScrubCommit), ▼ — к кнопкам, ▲ с кнопок — на линию.
 *
 * Что делают кнопки, модуль не знает: app.js передаёт их списком при открытии.
 * buttons: [{ icon?: имя из ICONS | () => имя, text?: string | () => string (подпись рядом со значком),
 *             label: string | () => string (подсказка), action: () => void }]
 * Кнопка без icon — обычная текстовая (подменю настроек).
 */
const PlayerBarUI = (() => {
    const HIDE_MS = 10 * 1000;

    // Значки — контуры в сетке 24×24 (свои, а не символы шрифта: на телевизоре ⏮ ⏯ могут не нарисоваться)
    const ICONS = {
        play: 'M8 5v14l11-7z',
        pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
        prev: 'M6 6h2v12H6zm3.5 6l8.5 6V6z',
        next: 'M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z',
        restart: 'M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z',
        audio: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
        settings: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.488.488 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
        live: 'M12 7a5 5 0 100 10 5 5 0 000-10zm0-5C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z',
        guide: 'M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z',
        quality: 'M19 3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V5a2 2 0 00-2-2zm-8 12H9.5v-2h-2v2H6V9h1.5v2.5h2V9H11v6zm2-6h4c.55 0 1 .45 1 1v4c0 .55-.45 1-1 1h-4V9zm1.5 4.5h2v-3h-2v3z',
        details: 'M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z',
        back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
        sleep: 'M12 3a9 9 0 109 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 01-4.4 2.26 5.4 5.4 0 01-3.14-9.8c-.44-.06-.9-.1-1.36-.1z',
        scale: 'M19 12h-2v3h-3v2h5v-5zM7 9h3V7H5v5h2V9zm14-6H3a2 2 0 00-2 2v14a2 2 0 002 2h18a2 2 0 002-2V5a2 2 0 00-2-2zm0 16.01H3V4.99h18v14.02z',
        move: 'M16 17.01V10h-2v7.01h-3L15 21l4-3.99h-3zM9 3L5 6.99h3V14h2V6.99h3L9 3z',
        logo: 'M21 19V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z'
    };

    let container = null;
    let infoEl = null;
    let buttonsEl = null;
    let tipEl = null;
    let getInfo = () => null;
    let buttons = [];
    let focused = 0;
    let hideTimer = null;
    let infoTimer = null;   // позиция фильма и прогресс передачи идут, пока панель открыта
    let opts = {};
    let zone = 'buttons';   // 'timeline' | 'buttons'

    function init(el) {
        container = el;
        container.innerHTML = '';
        infoEl = document.createElement('div');
        infoEl.className = 'player-bar-info';
        buttonsEl = document.createElement('div');
        buttonsEl.className = 'player-bar-buttons';
        tipEl = document.createElement('div');
        tipEl.className = 'player-bar-tip hidden';
        container.appendChild(infoEl);
        container.appendChild(buttonsEl);
        container.appendChild(tipEl);
    }

    const value = v => (typeof v === 'function' ? v() : v);

    /**
     * info: { name, programme, progress (0..1), scrub (0..1 | null — куда ведут бегунок),
     *         timeLabel (время под бегунком) }
     */
    function renderInfo() {
        const info = getInfo();
        infoEl.innerHTML = '';
        if (!info) return;

        const name = document.createElement('div');
        name.className = 'player-bar-channel';
        name.textContent = info.name;
        infoEl.appendChild(name);

        const prog = document.createElement('div');
        prog.className = 'player-bar-programme';
        prog.textContent = info.programme || '';
        infoEl.appendChild(prog);

        const bar = document.createElement('div');
        bar.className = 'player-bar-progress' + (opts.timeline ? ' timeline' : '') +
            (opts.timeline && zone === 'timeline' ? ' focused' : '');
        if (typeof info.progress === 'number') {
            const fill = document.createElement('div');
            fill.className = 'player-bar-fill';
            fill.style.width = Math.round(info.progress * 1000) / 10 + '%';
            bar.appendChild(fill);
        }
        if (opts.timeline && typeof info.progress === 'number') {
            const at = typeof info.scrub === 'number' ? info.scrub : info.progress;
            if (typeof info.scrub === 'number') {
                // отрезок между текущим местом и бегунком — видно, куда и насколько мотаем
                const span = document.createElement('div');
                span.className = 'player-bar-scrub-span';
                span.style.left = Math.min(at, info.progress) * 100 + '%';
                span.style.width = Math.abs(at - info.progress) * 100 + '%';
                bar.appendChild(span);
            }
            const thumb = document.createElement('div');
            thumb.className = 'player-bar-thumb';
            thumb.style.left = at * 100 + '%';
            bar.appendChild(thumb);
            if (info.timeLabel && (zone === 'timeline' || typeof info.scrub === 'number')) {
                const bubble = document.createElement('div');
                bubble.className = 'player-bar-bubble';
                bubble.style.left = Math.max(3, Math.min(97, at * 100)) + '%';
                bubble.textContent = info.timeLabel;
                bar.appendChild(bubble);
            }
        }
        infoEl.appendChild(bar);
    }

    function iconSvg(name) {
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('class', 'player-bar-icon');
        const path = document.createElementNS(ns, 'path');
        path.setAttribute('d', ICONS[name] || '');
        svg.appendChild(path);
        return svg;
    }

    function renderButtons() {
        buttonsEl.innerHTML = '';
        buttonsEl.classList.toggle('text-only', buttons.length > 0 && buttons.every(b => !b.icon || b.wide));
        let focusedEl = null;
        buttons.forEach((b, i) => {
            const el = document.createElement('div');
            const icon = value(b.icon);
            const text = icon && !b.wide ? value(b.text) : value(b.text) || value(b.label);
            el.className = 'player-bar-button' + (icon ? ' with-icon' : '') + (b.main ? ' main' : '') +
                (i === focused && zone === 'buttons' ? ' focused' : '');
            if (icon) el.appendChild(iconSvg(icon));
            if (text) {
                const span = document.createElement('span');
                span.textContent = text;
                el.appendChild(span);
            }
            el.addEventListener('click', () => { zone = 'buttons'; focused = i; activate(); });
            buttonsEl.appendChild(el);
            if (i === focused && zone === 'buttons') focusedEl = el;
        });
        // подсказка над выбранной кнопкой-значком (у текстовой всё написано на ней самой)
        const b = buttons[focused];
        const tip = focusedEl && b && value(b.icon) && !b.wide ? value(b.label) : '';
        tipEl.classList.toggle('hidden', !tip);
        if (tip) {
            tipEl.textContent = tip;
            const box = container.getBoundingClientRect();
            const r = focusedEl.getBoundingClientRect();
            const half = tipEl.offsetWidth / 2;
            const center = r.left - box.left + r.width / 2;
            tipEl.style.left = Math.max(half + 20, Math.min(box.width - half - 20, center)) + 'px';
            tipEl.style.top = (r.top - box.top - tipEl.offsetHeight - 12) + 'px';
        }
    }

    function bumpHideTimer() {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(close, HIDE_MS);
    }

    /**
     * infoProvider() → см. renderInfo; options: { timeline, startZone: 'timeline' | 'buttons' (по умолчанию —
     * линия времени, если она есть), focus: индекс кнопки, выбранной при открытии, onScrub(dir), onScrubCommit() }.
     */
    function open(infoProvider, barButtons, options = {}) {
        if (!container) return;
        getInfo = infoProvider;
        buttons = barButtons;
        opts = options;
        zone = opts.timeline && opts.startZone !== 'buttons' ? 'timeline' : 'buttons';
        if (typeof opts.focus === 'number') focused = opts.focus;
        focused = Math.max(0, Math.min(focused, buttons.length - 1));
        container.classList.remove('hidden');
        renderInfo();
        renderButtons();
        bumpHideTimer();
        clearInterval(infoTimer);
        infoTimer = setInterval(renderInfo, 500);
    }

    function close() {
        if (container) container.classList.add('hidden');
        clearTimeout(hideTimer);
        clearInterval(infoTimer);
    }

    function isOpen() {
        return !!container && !container.classList.contains('hidden');
    }

    function moveFocus(delta) {
        if (zone === 'timeline') {
            if (opts.onScrub) opts.onScrub(delta);
            renderInfo();
        } else {
            focused = Math.max(0, Math.min(focused + delta, buttons.length - 1));
            renderButtons();
        }
        bumpHideTimer();
    }

    /** ▲▼: на линии времени ▼ — к кнопкам, с кнопок ▲ — на линию; иначе панель закрывается. */
    function moveVertical(delta) {
        if (opts.timeline && zone === 'timeline' && delta > 0) zone = 'buttons';
        else if (opts.timeline && zone === 'buttons' && delta < 0) zone = 'timeline';
        else return close();
        renderInfo();
        renderButtons();
        bumpHideTimer();
    }

    /** Кнопка может закрыть панель или открыть её заново с другими кнопками — тогда не перерисовываем. */
    function activate() {
        const before = buttons;
        if (zone === 'timeline') {
            if (opts.onScrubCommit) opts.onScrubCommit();
        } else {
            const b = buttons[focused];
            if (!b) return;
            b.action();
        }
        if (isOpen() && buttons === before) {
            renderInfo();
            renderButtons();
            bumpHideTimer();
        }
    }

    return { init, open, close, isOpen, moveFocus, moveVertical, activate, ICONS };
})();

if (typeof module !== 'undefined') module.exports = { PlayerBarUI };
