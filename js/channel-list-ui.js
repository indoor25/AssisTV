/**
 * Channel list UI: grouped, scrollable overlay list of channels.
 * Toggled by RETURN (see RemoteControl.onBack in app.js). While open, remote
 * Up/Down move focus and Enter picks the focused channel — app.js routes
 * those through here only when isOpen() is true, so the same keys keep their
 * normal meaning (menu navigation elsewhere) when the list is closed.
 * This module only renders + reports the pick; playback stays owned by
 * Player/app.js so there's one place that decides what "now playing" means.
 *
 * ВИРТУАЛИЗАЦИЯ: в реальном плейлисте ~1977 каналов. Раньше рендерились все строки сразу —
 * это почти две тысячи DOM-узлов и столько же <img> с логотипами, которые телевизор начинал
 * грузить одновременно; прокрутка и переключение каналов от этого жутко тормозили. Теперь в
 * DOM живёт только видимое окно строк (+буфер), а высота списка держится распоркой.
 * Строки фиксированной высоты ROW_H — это то, что позволяет считать позицию простым умножением.
 *
 * Открывается OK или ◄ во время просмотра и показывает ОДНУ группу — группу играющего канала;
 * ◄ в списке открывает список групп (SideMenuUI), ► — программу передач канала (ChannelEpgUI).
 * Два дополнительных режима включаются из панели плеера (▼ при просмотре) или цветной кнопкой,
 * если она есть на пульте (см. app.js), потому что drag&drop на пульте невозможен:
 *   - 'reorder' (долгое OK или синяя): Up/Down меняют канал местами с соседом ВНУТРИ группы,
 *     сохраняется через ChannelStore.setSortOrder.
 *   - 'logo-edit' (красная): поле ввода URL логотипа для выбранного канала,
 *     сохраняется через ChannelStore.setLogoOverride.
 */
const ChannelListUI = (() => {
    const ROW_H = 56;          // одинаковая высота у заголовка группы и у канала — см. коммент выше
    const BUFFER_ROWS = 6;     // запас строк сверху/снизу, чтобы при прокрутке не мелькало пустое

    let container = null;
    let viewport = null;       // прокручиваемая область
    let spacer = null;         // держит полную высоту списка, внутри позиционируются видимые строки
    let toolbarEl = null;
    let logoInput = null;
    let logoHint = null;
    let onSelect = () => {};

    let rows = [];             // [{type:'header'|'channel', group, channel}] — плоская модель списка
    let orderedChannels = [];  // полный список каналов в текущем порядке (для перестановки)
    let focusedRow = -1;       // индекс в rows, всегда строка типа 'channel'
    let currentChannelKey = null;
    let mode = 'browse';       // 'browse' | 'reorder' | 'logo-edit'
    let currentGroup = null;   // показывается только эта группа
    let numberByKey = {};      // номер канала = позиция в общей сортировке (как для ввода цифрами)


    function init(el, opts = {}) {
        container = el;
        onSelect = opts.onSelect || onSelect;

        container.innerHTML = '';

        viewport = document.createElement('div');
        viewport.className = 'channel-list-viewport';
        spacer = document.createElement('div');
        spacer.className = 'channel-list-spacer';
        viewport.appendChild(spacer);
        viewport.addEventListener('scroll', renderWindow);
        container.appendChild(viewport);

        toolbarEl = document.createElement('div');
        toolbarEl.className = 'channel-list-toolbar';
        logoHint = document.createElement('div');
        logoHint.className = 'channel-list-toolbar-hint';
        logoHint.textContent = I18n.t('list.hint');
        logoInput = document.createElement('input');
        logoInput.type = 'text';
        logoInput.className = 'channel-list-logo-input hidden';
        toolbarEl.appendChild(logoHint);
        toolbarEl.appendChild(logoInput);
        container.appendChild(toolbarEl);
    }

    /** Группа канала в списке групп (у плейлиста без групп — «Все каналы»), см. ChannelStore.groupsOf. */
    function groupOf(ch) { return ChannelStore.shownGroupOf(ch, getGroups()); }

    /** channels: ChannelStore.getAll() — already sorted. Показывается одна группа (currentGroup),
     *  другая выбирается через список групп (◄ в списке, см. app.js). */
    function render(channels) {
        if (!viewport) return;
        orderedChannels = channels;
        numberByKey = {};
        channels.forEach((ch, i) => { numberByKey[ch.key] = i + 1; });

        const groups = getGroups();
        if (!currentGroup || groups.indexOf(currentGroup) < 0 || Parental.isGroupLocked(currentGroup)) {
            const playing = channels.find(c => c.key === currentChannelKey);
            currentGroup = playing ? groupOf(playing) : null;
            currentGroup = openGroup(currentGroup, groups);
        }
        buildRows();
    }

    function buildRows() {
        rows = [{ type: 'header', group: currentGroup }];
        orderedChannels.forEach(channel => {
            if (ChannelStore.inGroup(channel, currentGroup)) rows.push({ type: 'channel', channel });
        });
        spacer.style.height = (rows.length * ROW_H) + 'px';

        const playingRow = rows.findIndex(r => r.type === 'channel' && r.channel.key === currentChannelKey);
        viewport.scrollTop = 0;
        setFocus(playingRow >= 0 ? playingRow : firstChannelRow());
    }

    /** Группы в порядке первого появления в текущей сортировке каналов; «Все каналы» — последней. */
    function getGroups() {
        return ChannelStore.groupsOf(orderedChannels);
    }

    function getCurrentGroup() { return currentGroup; }

    /** Группа под замком родительского контроля в списке не открывается — вместо неё первая открытая. */
    function openGroup(group, groups) {
        if (group && !Parental.isGroupLocked(group)) return group;
        return groups.find(g => !Parental.isGroupLocked(g)) || null;
    }

    function showGroup(name) {
        if (!viewport || !name) return;
        currentGroup = name;
        buildRows();
    }

    function firstChannelRow() {
        return rows.findIndex(r => r.type === 'channel');
    }

    /** Пересобирает только те строки, что попадают в видимое окно прокрутки. */
    function renderWindow() {
        if (!viewport || !rows.length) return;

        const first = Math.max(0, Math.floor(viewport.scrollTop / ROW_H) - BUFFER_ROWS);
        const visibleCount = Math.ceil(viewport.clientHeight / ROW_H) + BUFFER_ROWS * 2;
        const last = Math.min(rows.length, first + visibleCount);

        const fragment = document.createDocumentFragment();
        for (let i = first; i < last; i++) {
            fragment.appendChild(buildRowEl(rows[i], i));
        }
        spacer.innerHTML = '';
        spacer.appendChild(fragment);
    }

    function buildRowEl(row, index) {
        const el = document.createElement('div');
        el.style.position = 'absolute';
        el.style.top = (index * ROW_H) + 'px';
        el.style.left = '0';
        el.style.right = '0';
        el.style.height = ROW_H + 'px';

        if (row.type === 'header') {
            el.className = 'group-header';
            if (Parental.isProtectedGroup(row.group)) el.appendChild(Parental.lockIcon(true));
            el.appendChild(document.createTextNode(ChannelStore.groupLabel(row.group)));
            return el;
        }

        const channel = row.channel;
        el.className = 'channel-item';
        el.dataset.key = channel.key;
        if (channel.key === currentChannelKey) el.classList.add('playing');
        if (index === focusedRow) {
            el.classList.add('focused');
            if (mode === 'reorder') el.classList.add('reordering');
        }

        if (channel.logo) {
            const img = document.createElement('img');
            img.src = channel.logo;
            img.alt = '';
            // a broken/missing logo shouldn't leave a visible broken-image icon in the list
            img.onerror = () => { img.style.visibility = 'hidden'; };
            el.appendChild(img);
        }

        const num = document.createElement('span');
        num.className = 'channel-number';
        num.textContent = numberByKey[channel.key] || '';
        el.insertBefore(num, el.firstChild);

        const name = document.createElement('span');
        name.className = 'channel-name';
        name.textContent = channel.name;
        el.appendChild(name);
        const badge = ChannelStore.archiveBadge(channel);
        if (badge) { el.appendChild(badge); el.classList.add('has-archive'); }

        el.addEventListener('click', () => onSelect(channel));
        return el;
    }

    /** Прокручивает так, чтобы строка была видна, и перерисовывает окно. */
    function setFocus(rowIdx) {
        if (!rows.length || rowIdx < 0) return;
        focusedRow = rowIdx;

        const top = focusedRow * ROW_H;
        const viewTop = viewport.scrollTop;
        const viewBottom = viewTop + viewport.clientHeight;
        if (top < viewTop) viewport.scrollTop = top;
        else if (top + ROW_H > viewBottom) viewport.scrollTop = top + ROW_H - viewport.clientHeight;

        renderWindow();
    }

    /** Следующая строка-канал в направлении delta (заголовки групп пропускаются). */
    function nextChannelRow(from, delta) {
        for (let i = from + delta; i >= 0 && i < rows.length; i += delta) {
            if (rows[i].type === 'channel') return i;
        }
        return -1;
    }

    /** delta: +1/-1 от Down/Up. Упирается в края, а не заворачивается — с заголовками групп
     *  заворот дезориентирует. В режиме 'reorder' переставляет, в 'logo-edit' игнорируется. */
    function moveFocus(delta) {
        if (mode === 'reorder') { swapFocused(delta); return; }
        if (mode === 'logo-edit') return;
        const next = nextChannelRow(focusedRow, delta);
        if (next >= 0) setFocus(next);
    }

    /** Меняет выбранный канал местами с соседом, но только внутри одной группы — переносить
     *  между группами тут нельзя, принадлежность к группе это отдельная правка.
     *  Сохраняет через ChannelStore.setSortOrder и оставляет фокус на переставленном канале. */
    function swapFocused(delta) {
        const currentRow = rows[focusedRow];
        const neighborIdx = nextChannelRow(focusedRow, delta);
        if (!currentRow || neighborIdx < 0) return;

        const current = currentRow.channel;
        const neighbor = rows[neighborIdx].channel;
        if (neighbor.group !== current.group) return;

        const idxA = orderedChannels.indexOf(current);
        const idxB = orderedChannels.indexOf(neighbor);
        if (idxA < 0 || idxB < 0) return;

        const newOrder = orderedChannels.slice();
        [newOrder[idxA], newOrder[idxB]] = [newOrder[idxB], newOrder[idxA]];
        ChannelStore.setSortOrder(newOrder.map(c => c.key));

        render(ChannelStore.getAll());
        const movedIdx = rows.findIndex(r => r.type === 'channel' && r.channel.key === current.key);
        if (movedIdx >= 0) setFocus(movedIdx);
    }

    function toggleReorderMode() {
        if (mode === 'reorder') exitReorderMode(); else enterReorderMode();
    }
    function enterReorderMode() {
        if (mode === 'logo-edit' || focusedRow < 0) return;
        mode = 'reorder';
        logoHint.textContent = I18n.t('list.reorderHint');
        renderWindow();
    }
    function exitReorderMode() {
        if (mode !== 'reorder') return;
        mode = 'browse';
        logoHint.textContent = I18n.t('list.hint');
        renderWindow();
    }
    function isReordering() { return mode === 'reorder'; }

    function toggleLogoEdit() {
        if (mode === 'logo-edit') confirmLogoEdit(); else enterLogoEdit();
    }
    function enterLogoEdit() {
        if (mode === 'reorder' || focusedRow < 0) return;
        const channel = rows[focusedRow].channel;
        mode = 'logo-edit';
        logoInput.classList.remove('hidden');
        logoHint.textContent = I18n.t('list.logoHint', { name: channel.name });
        logoInput.value = channel.logo || '';
        logoInput.focus();
    }
    /** Пустое поле очищает правку и возвращает логотип из плейлиста/EPG. */
    function confirmLogoEdit() {
        if (mode !== 'logo-edit') return;
        const channel = rows[focusedRow].channel;
        ChannelStore.setLogoOverride(channel.key, logoInput.value.trim() || null);
        cancelLogoEdit();

        render(ChannelStore.getAll());
        const idx = rows.findIndex(r => r.type === 'channel' && r.channel.key === channel.key);
        if (idx >= 0) setFocus(idx);
    }
    function cancelLogoEdit() {
        if (mode !== 'logo-edit') return;
        mode = 'browse';
        logoInput.classList.add('hidden');
        logoInput.blur();
        logoHint.textContent = I18n.t('list.hint');
    }
    function isEditingLogo() { return mode === 'logo-edit'; }

    function selectFocused() {
        if (focusedRow >= 0 && rows[focusedRow]) onSelect(rows[focusedRow].channel);
    }

    function getFocusedChannel() {
        const row = rows[focusedRow];
        return row && row.type === 'channel' ? row.channel : null;
    }

    /** Список виден, но управление у панели программы или меню — фокус рисуется приглушённо. */
    function setActive(active) {
        if (container) container.classList.toggle('inactive', !active);
    }

    /** Call this from Player.onChannelChanged so the list's "now playing" marker stays correct
     *  regardless of whether the channel change came from the list, Ch+/Ch-, or MQTT. */
    function setCurrentPlaying(channel) {
        currentChannelKey = channel ? channel.key : null;
        if (isOpen()) renderWindow();
    }

    /** Открывается на группе играющего канала, с фокусом на нём. */
    function open() {
        if (!container) return;
        container.classList.remove('hidden');
        const playing = orderedChannels.find(c => c.key === currentChannelKey);
        if (playing) currentGroup = groupOf(playing);
        currentGroup = openGroup(currentGroup, getGroups());
        if (currentGroup) buildRows();
    }

    function close() {
        if (!container) return;
        if (mode !== 'browse') { mode = 'browse'; logoInput.classList.add('hidden'); logoHint.textContent = I18n.t('list.hint'); }
        container.classList.add('hidden');
    }

    function toggle() {
        if (isOpen()) close(); else open();
    }

    function isOpen() {
        return !!container && !container.classList.contains('hidden');
    }

    return {
        init, render, open, close, toggle, isOpen, moveFocus, selectFocused, setCurrentPlaying,
        getFocusedChannel, setActive, getGroups, getCurrentGroup, showGroup,
        toggleReorderMode, enterReorderMode, exitReorderMode, isReordering,
        toggleLogoEdit, enterLogoEdit, confirmLogoEdit, cancelLogoEdit, isEditingLogo
    };
})();

if (typeof module !== 'undefined') module.exports = { ChannelListUI };
