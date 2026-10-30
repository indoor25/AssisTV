/**
 * Окно ввода PIN родительского контроля (#pin-dialog), создаётся само в body.
 *
 * На новых пультах Samsung цифр нет (есть экранная «123», она шлёт те же коды 0–9), поэтому цифру можно
 * набрать и стрелками: ▲▼ — цифра в выбранной клетке, ► — следующая клетка, ◄ — стереть/назад.
 * Цифра с пульта сразу переходит к следующей клетке, после четвёртой PIN проверяется сам. OK — проверить,
 * RETURN — отмена. Набранные цифры показываются точками, цифра под ▲▼ — пока клетка выбрана.
 *
 * open({title, text, check(pin) → Promise<{ok, message?}>, onSuccess, onCancel})
 */
const PinDialogUI = (() => {
    const LEN = 4;
    let root = null;
    let titleEl, textEl, cellsEl, msgEl;
    let opts = null;
    let digits = [];
    let pos = 0;
    let busy = false;

    function init() {
        root = document.createElement('div');
        root.id = 'pin-dialog';
        root.className = 'hidden';
        root.innerHTML =
            '<div class="pin-box">' +
            '  <div class="pin-title"></div>' +
            '  <div class="pin-text"></div>' +
            '  <div class="pin-cells"></div>' +
            '  <div class="pin-msg"></div>' +
            '  <div class="pin-hint"></div>' +
            '</div>';
        document.body.appendChild(root);
        titleEl = root.querySelector('.pin-title');
        textEl = root.querySelector('.pin-text');
        cellsEl = root.querySelector('.pin-cells');
        msgEl = root.querySelector('.pin-msg');
        root.querySelector('.pin-hint').textContent = I18n.t('pin.hint');
        titleEl.parentNode.insertBefore(Parental.lockIcon(false), titleEl);
    }

    function render() {
        cellsEl.innerHTML = '';
        for (let i = 0; i < LEN; i++) {
            const cell = document.createElement('div');
            cell.className = 'pin-cell' + (i === pos && !busy ? ' focused' : '');
            const d = digits[i];
            // выбранную клетку показываем цифрой (её крутят ▲▼), остальные — точкой
            cell.textContent = d == null ? '' : (i === pos && root.classList.contains('arrows') ? String(d) : '●');
            cellsEl.appendChild(cell);
        }
    }

    function setMessage(text, kind) {
        msgEl.textContent = text || '';
        msgEl.className = 'pin-msg' + (kind ? ' ' + kind : '');
    }

    function open(o) {
        if (!root) init();
        opts = o || {};
        digits = [];
        pos = 0;
        busy = false;
        titleEl.textContent = opts.title || I18n.t('pin.enter');
        textEl.textContent = opts.text || '';
        root.classList.remove('arrows');
        setMessage('');
        root.classList.remove('hidden');
        render();
    }

    function close() {
        if (root) root.classList.add('hidden');
        opts = null;
    }

    function isOpen() { return !!root && !root.classList.contains('hidden'); }

    function cancel() {
        const o = opts;
        close();
        if (o && o.onCancel) o.onCancel();
    }

    function submit() {
        if (busy || !opts) return;
        if (digits.length < LEN || digits.some(d => d == null)) { setMessage(I18n.t('pin.need4'), 'error'); return; }
        const pin = digits.join('');
        const o = opts;
        busy = true;
        setMessage(I18n.t('pin.checking'));
        render();
        Promise.resolve().then(() => o.check(pin)).then(r => r, err => ({ ok: false, message: (err && err.message) || String(err) }))
            .then(r => {
                if (opts !== o) return;   // окно уже закрыли
                busy = false;
                if (r && r.ok) {
                    close();
                    if (o.onSuccess) o.onSuccess();
                    return;
                }
                digits = [];
                pos = 0;
                root.classList.remove('arrows');
                setMessage((r && r.message) || I18n.t('pin.wrong'), 'error');
                render();
            });
    }

    function typeDigit(d) {
        if (busy) return;
        root.classList.remove('arrows');
        digits[pos] = d;
        setMessage('');
        if (pos < LEN - 1) pos++;
        else pos = LEN;   // все клетки набраны
        render();
        if (digits.filter(x => x != null).length === LEN) submit();
    }

    function handleKey(key, value) {
        if (!isOpen()) return;
        if (key === 'back') return cancel();
        if (busy) return;
        if (key === 'digit') return typeDigit(value);
        if (key === 'enter') return submit();
        const at = Math.min(pos, LEN - 1);
        if (key === 'up' || key === 'down') {
            root.classList.add('arrows');
            pos = at;
            const cur = digits[at] == null ? (key === 'up' ? -1 : 10) : digits[at];
            digits[at] = (cur + (key === 'up' ? 1 : -1) + 10) % 10;
            setMessage('');
        } else if (key === 'right') {
            if (digits[at] == null) return;
            pos = Math.min(at + 1, LEN - 1);
        } else if (key === 'left') {
            if (pos >= LEN) pos = LEN - 1;
            if (digits[pos] != null) digits[pos] = null;
            else if (pos > 0) { pos--; digits[pos] = null; }
        }
        render();
    }

    return { open, close, isOpen, handleKey };
})();

if (typeof module !== 'undefined') module.exports = { PinDialogUI };
