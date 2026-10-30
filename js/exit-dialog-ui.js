/**
 * Диалог «Закрыть программу?» (#exit-dialog) — RETURN на главном экране.
 * ◄► — выбор, OK — подтвердить, RETURN — отмена. По умолчанию выбрано «Нет»: случайное двойное
 * нажатие RETURN не должно закрывать приложение.
 */
const ExitDialogUI = (() => {
    let container = null;
    let buttons = [];
    let focused = 1;

    function init(el) {
        container = el;
        container.innerHTML = '';
        const box = document.createElement('div');
        box.className = 'exit-dialog-box';
        const text = document.createElement('div');
        text.className = 'exit-dialog-text';
        text.textContent = I18n.t('exit.question');
        const row = document.createElement('div');
        row.className = 'exit-dialog-buttons';

        buttons = [
            { label: I18n.t('common.yes'), action: exitApp },
            { label: I18n.t('common.no'), action: close }
        ].map((b, i) => {
            const el = document.createElement('div');
            el.className = 'exit-dialog-button';
            el.textContent = b.label;
            el.addEventListener('click', () => { focused = i; activateFocused(); });
            row.appendChild(el);
            return { el, action: b.action };
        });

        box.appendChild(text);
        box.appendChild(row);
        container.appendChild(box);
    }

    function exitApp() {
        try {
            tizen.application.getCurrentApplication().exit();
        } catch (e) {
            console.error('[ExitDialog] exit failed', e);
            close();
        }
    }

    function render() {
        buttons.forEach((b, i) => b.el.classList.toggle('focused', i === focused));
    }

    function open() {
        if (!container) return;
        focused = 1;
        container.classList.remove('hidden');
        render();
    }

    function close() {
        if (container) container.classList.add('hidden');
    }

    function isOpen() {
        return !!container && !container.classList.contains('hidden');
    }

    function moveFocus(delta) {
        focused = Math.max(0, Math.min(focused + delta, buttons.length - 1));
        render();
    }

    function activateFocused() { buttons[focused].action(); }

    return { init, open, close, isOpen, moveFocus, activateFocused };
})();

if (typeof module !== 'undefined') module.exports = { ExitDialogUI };
