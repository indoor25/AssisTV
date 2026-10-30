/**
 * Экран привязки к аддону (#pairing-view): аддон не знает этот телевизор (или привязку сбросили) — показываем
 * код из 6 цифр, его подтверждают на странице IPTV в Home Assistant. Опрос аддона и что делать потом — в app.js
 * (waitForPairing). OK — Настройки (неверный адрес аддона), RETURN — диалог выхода.
 */
const PairingUI = (() => {
    let container = null;
    let codeEl = null;

    function init(el) {
        container = el;
        container.innerHTML = '';
        const box = document.createElement('div');
        box.className = 'pairing-box';
        const add = (cls, text) => {
            const d = document.createElement('div');
            d.className = cls;
            d.textContent = text;
            box.appendChild(d);
            return d;
        };
        add('pairing-title', I18n.t('pair.title'));
        add('pairing-step', '1. ' + I18n.t('pair.step1'));
        add('pairing-step', '2. ' + I18n.t('pair.step2'));
        codeEl = add('pairing-code', '');
        add('pairing-keys', I18n.t('pair.keys'));
        container.appendChild(box);
    }

    function show(code) {
        if (!container) return;
        codeEl.textContent = String(code || '').replace(/^(\d{3})(\d{3})$/, '$1 $2');
        container.classList.remove('hidden');
    }

    function hide() {
        if (container) container.classList.add('hidden');
    }

    function isOpen() {
        return !!container && !container.classList.contains('hidden');
    }

    return { init, show, hide, isOpen };
})();

if (typeof module !== 'undefined') module.exports = { PairingUI };
