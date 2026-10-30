/**
 * Описание того, что смотрят (#info-panel) — ▲ при просмотре канала, архива или фильма.
 *
 * Панель внизу экрана: логотип/канал, название, время и прогресс, жанр и возраст, описание, что дальше.
 * Данные даёт app.js функцией provider() → {logo, channel, title, time, progress (0…1 | null), meta: [строки],
 * desc (строка | null — «Описание недоступно» | undefined — ещё грузится), next}. Панель перерисовывается раз в
 * секунду (идёт прогресс, догружается описание). ▲ / ▼ / RETURN — скрыть; сама прячется через HIDE_MS.
 */
const InfoPanelUI = (() => {
    const HIDE_MS = 30000;
    let root = null;
    let els = {};
    let provider = null;
    let tick = null;
    let hideTimer = null;
    let lastLogo = null;

    function init() {
        root = document.createElement('div');
        root.id = 'info-panel';
        root.className = 'hidden';
        root.innerHTML =
            '<div class="info-card">' +
            '  <div class="info-logo"><img alt=""></div>' +
            '  <div class="info-main">' +
            '    <div class="info-channel"></div>' +
            '    <div class="info-title"></div>' +
            '    <div class="info-time-row"><span class="info-time"></span><div class="info-progress"><div></div></div></div>' +
            '    <div class="info-meta"></div>' +
            '    <div class="info-desc"></div>' +
            '    <div class="info-next"></div>' +
            '  </div>' +
            '</div>' +
            '<div class="info-hint"></div>';
        document.body.appendChild(root);
        ['logo', 'channel', 'title', 'time', 'progress', 'meta', 'desc', 'next'].forEach(k => {
            els[k] = root.querySelector('.info-' + k);
        });
        root.querySelector('.info-hint').textContent = I18n.t('info.hint');
        els.img = els.logo.querySelector('img');
        els.img.onerror = () => { els.logo.classList.add('empty'); };
    }

    function render() {
        const d = provider && provider();
        if (!d) { close(); return; }
        if (d.logo !== lastLogo) {
            lastLogo = d.logo;
            els.logo.classList.toggle('empty', !d.logo);
            if (d.logo) els.img.src = d.logo; else els.img.removeAttribute('src');
        }
        els.channel.textContent = d.channel || '';
        els.title.textContent = d.title || I18n.t('info.noData');
        els.time.textContent = d.time || '';
        const hasProgress = typeof d.progress === 'number';
        els.progress.classList.toggle('hidden', !hasProgress);
        if (hasProgress) els.progress.firstChild.style.width = Math.round(Math.max(0, Math.min(1, d.progress)) * 100) + '%';
        els.meta.innerHTML = '';
        (d.meta || []).filter(Boolean).forEach(m => {
            const chip = document.createElement('span');
            chip.textContent = m;
            els.meta.appendChild(chip);
        });
        els.meta.classList.toggle('hidden', !els.meta.childNodes.length);
        const loading = d.desc === undefined;
        els.desc.classList.toggle('muted', loading || !d.desc);
        els.desc.textContent = loading ? I18n.t('info.loading') : (d.desc || I18n.t('info.noDesc'));
        els.next.textContent = d.next ? I18n.t('info.next', { title: d.next }) : '';
        els.next.classList.toggle('hidden', !d.next);
    }

    function open(dataProvider) {
        if (!root) init();
        provider = dataProvider;
        lastLogo = null;
        root.classList.remove('hidden');
        render();
        clearInterval(tick);
        tick = setInterval(render, 1000);
        clearTimeout(hideTimer);
        hideTimer = setTimeout(close, HIDE_MS);
    }

    /** Перерисовать сейчас (пришло описание). */
    function refresh() {
        if (isOpen()) render();
    }

    function close() {
        clearInterval(tick);
        clearTimeout(hideTimer);
        provider = null;
        if (root) root.classList.add('hidden');
    }

    function isOpen() {
        return !!root && !root.classList.contains('hidden');
    }

    return { open, refresh, close, isOpen };
})();

if (typeof module !== 'undefined') module.exports = { InfoPanelUI };
