/**
 * Программа передач одного канала (#channel-epg) — панель справа от списка каналов.
 *
 * Открывается кнопкой ► на выбранном в списке канале (см. onRight в app.js) — вместо прежней
 * сетки EPG на жёлтой кнопке: на новых пультах Samsung цветных кнопок нет вовсе, а с крестовиной
 * программа оказывается «в одном шаге» от канала, как в ottplayer.
 *
 * ▲▼ листают передачи (фокус при открытии — на той, что идёт сейчас), RETURN — закрыть программу.
 * OK: прошедшая передача канала с архивом (метка «архив») — запись с её начала, остальные — канал в эфире.
 *
 * ◄ отдаёт управление списку, а программа остаётся открытой (setActive(false), схема пользователя 16.09.2026):
 * ▲▼ по каналам показывают программу выбранного канала (app.js moveListFocus), ► — снова в программу,
 * ◄ — группы (программа закрывается).
 *
 * В JSON плейлиста у передач окно всего несколько часов назад, поэтому у канала с архивом программа за
 * прошлые дни догружается из аддона при открытии (opts.loadGuide, см. app.js archiveGuide) и список
 * перерисовывается с фокусом на той же передаче. Передач за 7 дней ~200 строк — без виртуализации.
 */
const ChannelEpgUI = (() => {
    let container = null;
    let headerEl = null;
    let listEl = null;
    let onSelect = () => {};
    let loadGuide = null;     // (channel) => Promise<[{start, stop, title}]> — программа с днями архива
    let hintEl = null;
    let openSeq = 0;
    let guideTimer = null;
    let active = true;         // false — программа видна, но кнопки у списка каналов

    let channel = null;
    let programmes = [];
    let rowEls = [];
    let focused = -1;

    function init(el, opts = {}) {
        container = el;
        onSelect = opts.onSelect || onSelect;
        loadGuide = opts.loadGuide || null;
        container.innerHTML = '';

        headerEl = document.createElement('div');
        headerEl.className = 'channel-epg-header';
        listEl = document.createElement('div');
        listEl.className = 'channel-epg-list';
        hintEl = document.createElement('div');
        hintEl.className = 'channel-epg-hint';

        container.appendChild(headerEl);
        container.appendChild(listEl);
        container.appendChild(hintEl);
    }

    function pad(n) { return n < 10 ? '0' + n : String(n); }

    function timeLabel(moment, now) {
        const date = AppClock.local(moment);   // часы и день — с пользовательским смещением
        const hm = pad(date.getHours()) + ':' + pad(date.getMinutes());
        const sameDay = date.toDateString() === AppClock.local(now).toDateString();
        return sameDay ? hm : I18n.t('common.weekdays').split(',')[date.getDay()] + ' ' + hm;
    }

    /** Передачу можно смотреть из архива: уже закончилась и началась не раньше глубины архива канала. */
    function inArchive(p, now) {
        const days = ChannelStore.archiveDays(channel);
        return days > 0 && p.stop <= now && p.start.getTime() >= now.getTime() - days * 86400000;
    }

    function renderHint() {
        const days = channel ? ChannelStore.archiveDays(channel) : 0;
        if (!active) hintEl.textContent = I18n.t('epg.hintInactive');
        else if (days) hintEl.textContent = I18n.t('epg.hintArchive', { days });
        else hintEl.textContent = I18n.t('epg.hint');
    }

    function render(status) {
        const now = AppClock.now();
        renderHint();
        headerEl.innerHTML = '';
        if (channel.logo) {
            const img = document.createElement('img');
            img.src = channel.logo;
            img.alt = '';
            img.onerror = () => { img.style.visibility = 'hidden'; };
            headerEl.appendChild(img);
        }
        const name = document.createElement('span');
        name.textContent = channel.name;
        headerEl.appendChild(name);
        if (status) {
            const st = document.createElement('span');
            st.className = 'channel-epg-status';
            st.textContent = status;
            headerEl.appendChild(st);
        }
        const watchingAt = Player.isArchive() && Player.getCurrentChannel() && Player.getCurrentChannel().key === channel.key
            ? Player.getArchiveTime() * 1000 : null;

        listEl.innerHTML = '';
        rowEls = [];
        if (!programmes.length) {
            const empty = document.createElement('div');
            empty.className = 'channel-epg-empty';
            empty.textContent = I18n.t('epg.empty');
            listEl.appendChild(empty);
            return;
        }

        programmes.forEach((p, i) => {
            const row = document.createElement('div');
            row.className = 'channel-epg-row';
            const isNow = p.start <= now && now < p.stop;
            const archived = !isNow && inArchive(p, now);
            if (isNow) row.classList.add('now');
            else if (archived) row.classList.add('archived');
            else if (p.stop <= now) row.classList.add('past');
            const watching = watchingAt !== null && p.start.getTime() <= watchingAt && watchingAt < p.stop.getTime();
            if (watching) row.classList.add('watching');

            const time = document.createElement('div');
            time.className = 'channel-epg-time';
            time.textContent = timeLabel(p.start, now);
            row.appendChild(time);

            const title = document.createElement('div');
            title.className = 'channel-epg-title';
            title.textContent = p.title;
            if (isNow) {
                const bar = document.createElement('div');
                bar.className = 'channel-epg-progress';
                const fill = document.createElement('div');
                fill.style.width = Math.round((now - p.start) / (p.stop - p.start) * 100) + '%';
                bar.appendChild(fill);
                title.appendChild(bar);
            }
            row.appendChild(title);
            if (archived || watching) {
                const mark = document.createElement('div');
                mark.className = 'channel-epg-mark';
                mark.textContent = I18n.t(watching ? 'epg.watching' : 'epg.archive');
                row.appendChild(mark);
            }

            row.addEventListener('click', () => { setFocus(i); selectFocused(); });
            listEl.appendChild(row);
            rowEls.push(row);
        });
    }

    function setFocus(idx) {
        if (!rowEls.length) return;
        if (focused >= 0 && rowEls[focused]) rowEls[focused].classList.remove('focused');
        focused = Math.max(0, Math.min(idx, rowEls.length - 1));
        const row = rowEls[focused];
        row.classList.add('focused');

        // держим выбранную передачу в видимой области (с запасом в одну строку сверху)
        const top = row.offsetTop - row.offsetHeight;
        const bottom = row.offsetTop + row.offsetHeight * 2;
        if (top < listEl.scrollTop) listEl.scrollTop = Math.max(0, top);
        else if (bottom > listEl.scrollTop + listEl.clientHeight) listEl.scrollTop = bottom - listEl.clientHeight;
    }

    /** Индекс передачи, идущей в момент at (или ближайшей после него; нет — последней). */
    function indexAt(at) {
        let idx = programmes.findIndex(p => p.stop > at);
        return idx < 0 ? programmes.length - 1 : idx;
    }

    /**
     * opts.focusTime (Date) — на какой передаче встать; по умолчанию — на той, что идёт сейчас.
     * opts.active (по умолчанию true) — управление у программы; false — у списка каналов.
     * opts.guideDelayMs — отложить догрузку архива: при листании каналов не спрашивать аддон про каждый.
     */
    function open(ch, opts = {}) {
        if (!container || !ch) return;
        const seq = ++openSeq;
        clearTimeout(guideTimer);
        channel = ch;
        programmes = ChannelStore.getProgrammesFor(ch);
        focused = -1;
        container.classList.remove('hidden');
        setActive(opts.active !== false);
        const withArchive = ChannelStore.archiveDays(ch) > 0 && loadGuide;
        render(withArchive ? I18n.t('epg.loadingArchive') : '');
        listEl.scrollTop = 0;
        setFocus(indexAt(opts.focusTime || AppClock.now()));
        if (!withArchive) return;

        if (opts.guideDelayMs) guideTimer = setTimeout(() => fetchGuide(seq, opts), opts.guideDelayMs);
        else fetchGuide(seq, opts);
    }

    function fetchGuide(seq, opts) {
        const ch = channel;
        loadGuide(ch).then(list => {
            if (seq !== openSeq || !isOpen()) return;
            // остаёмся на той же передаче, на которой стоял фокус (пользователь мог уже полистать)
            const keep = programmes[focused] ? programmes[focused].start : (opts.focusTime || AppClock.now());
            programmes = list;
            focused = -1;
            render('');
            setFocus(indexAt(keep));
        }).catch(err => {
            if (seq !== openSeq || !isOpen()) return;
            console.warn('[EPG] архивная программа не загрузилась', err);
            const keep = focused;
            render(I18n.t('epg.archiveFailed'));
            focused = -1;
            setFocus(keep);
        });
    }

    function close() {
        clearTimeout(guideTimer);
        openSeq++;
        if (container) container.classList.add('hidden');
    }

    function isOpen() {
        return !!container && !container.classList.contains('hidden');
    }

    /** Кнопки у программы (true) или у списка каналов (false) — фокус тогда рисуется приглушённо. */
    function setActive(value) {
        active = !!value;
        if (container) container.classList.toggle('inactive', !active);
        if (hintEl) renderHint();
    }

    /** Программа открыта и кнопки у неё. */
    function isActive() {
        return isOpen() && active;
    }

    function getChannel() {
        return isOpen() ? channel : null;
    }

    function moveFocus(delta) { setFocus(focused + delta); }

    /** onSelect(channel, programme | null): programme — только если её смотреть из архива. */
    function selectFocused() {
        if (!channel) return;
        const p = programmes[focused];
        onSelect(channel, p && inArchive(p, AppClock.now()) ? p : null);
    }

    return { init, open, close, isOpen, isActive, setActive, getChannel, moveFocus, selectFocused };
})();

if (typeof module !== 'undefined') module.exports = { ChannelEpgUI };
