/**
 * Вертикальное меню-панель (#side-menu) слева, поверх списка каналов. Сейчас в нём — список
 * групп каналов: открывается ◄ из бокового списка (см. openGroupsPanel в app.js).
 *
 * Модуль не знает, что делают пункты: app.js передаёт их списком при открытии.
 * items: [{ label: string | () => string, action: () => void, keepOpen?: boolean, lock?: 'locked'|'open' }]
 *   lock — значок замка у пункта (группа родительского контроля, js/parental.js).
 *   keepOpen — не закрывать меню после действия (для переключателей: видно новое значение).
 */
const SideMenuUI = (() => {
    const ITEM_H = 64;

    let container = null;
    let titleEl = null;
    let listEl = null;
    let items = [];
    let focused = 0;

    function init(el) {
        container = el;
        container.innerHTML = '';

        titleEl = document.createElement('div');
        titleEl.className = 'side-menu-title';
        listEl = document.createElement('div');
        listEl.className = 'side-menu-list';
        const hint = document.createElement('div');
        hint.className = 'side-menu-hint';
        hint.textContent = I18n.t('sideMenu.hint');

        container.appendChild(titleEl);
        container.appendChild(listEl);
        container.appendChild(hint);
    }

    function labelOf(item) {
        return typeof item.label === 'function' ? item.label() : item.label;
    }

    function render() {
        listEl.innerHTML = '';
        items.forEach((item, i) => {
            const row = document.createElement('div');
            row.className = 'side-menu-item' + (i === focused ? ' focused' : '');
            row.style.height = ITEM_H + 'px';
            if (item.lock) row.appendChild(Parental.lockIcon(item.lock === 'open'));
            row.appendChild(document.createTextNode(labelOf(item)));
            row.addEventListener('click', () => { focused = i; activateFocused(); });
            listEl.appendChild(row);
        });
        // пунктов может быть больше, чем влезает (групп у провайдера 14+) — держим выбранный в поле зрения
        const top = focused * ITEM_H;
        if (top < listEl.scrollTop) listEl.scrollTop = top;
        else if (top + ITEM_H > listEl.scrollTop + listEl.clientHeight) listEl.scrollTop = top + ITEM_H - listEl.clientHeight;
    }

    /** title — заголовок, menuItems — см. комментарий сверху, focusIndex — какой пункт выбран сразу. */
    function open(title, menuItems, focusIndex = 0) {
        if (!container) return;
        titleEl.textContent = title;
        items = menuItems;
        focused = Math.max(0, Math.min(focusIndex, items.length - 1));
        container.classList.remove('hidden');
        listEl.scrollTop = 0;
        render();
    }

    function close() {
        if (container) container.classList.add('hidden');
    }

    function isOpen() {
        return !!container && !container.classList.contains('hidden');
    }

    function moveFocus(delta) {
        if (!items.length) return;
        focused = Math.max(0, Math.min(focused + delta, items.length - 1));
        render();
    }

    function activateFocused() {
        const item = items[focused];
        if (!item) return;
        if (!item.keepOpen) close();
        item.action();
        if (item.keepOpen && isOpen()) render();
    }

    return { init, open, close, isOpen, moveFocus, activateFocused };
})();

if (typeof module !== 'undefined') module.exports = { SideMenuUI };
