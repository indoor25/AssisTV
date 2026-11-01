/**
 * «О программе» (#about-view): версия, лицензия, где код, QR-код «Поддержать проект» (Ko-fi).
 * Открывается кнопкой в Настройках; OK или RETURN — закрыть (назад в Настройки).
 * QR — готовая картинка images/support-qr.png: адрес постоянный, библиотека на TV не нужна.
 */
const AboutUI = (() => {
    const PROJECT_URL = 'github.com/indoor25/AssisTV';
    const SUPPORT_URL = 'ko-fi.com/indoor25';
    let container = null;

    function init(el) {
        container = el;
    }

    function open(version) {
        if (!container) return;
        container.innerHTML = '';
        const box = document.createElement('div');
        box.className = 'about-box';
        const add = (tag, cls, text, parent) => {
            const e = document.createElement(tag);
            e.className = cls;
            if (text !== undefined) e.textContent = text;
            (parent || box).appendChild(e);
            return e;
        };

        const left = add('div', 'about-main');
        const logo = add('img', 'about-logo', undefined, left);
        logo.src = 'icon.png';
        add('div', 'about-title', 'AssisTV', left);
        add('div', 'about-version', I18n.t('about.version', { version: version || '—' }), left);
        add('div', 'about-text', I18n.t('about.text'), left);
        add('div', 'about-label', I18n.t('about.source'), left);
        add('div', 'about-link', PROJECT_URL, left);

        const right = add('div', 'about-support');
        add('div', 'about-support-title', I18n.t('about.support'), right);
        add('div', 'about-support-text', I18n.t('about.supportText'), right);
        const qr = add('img', 'about-qr', undefined, right);
        qr.src = 'images/support-qr.png';
        add('div', 'about-link', SUPPORT_URL, right);

        add('div', 'about-keys', I18n.t('about.keys'));
        container.appendChild(box);
        container.classList.remove('hidden');
    }

    function close() {
        if (container) container.classList.add('hidden');
    }

    function isOpen() {
        return !!container && !container.classList.contains('hidden');
    }

    return { init, open, close, isOpen };
})();

if (typeof module !== 'undefined') module.exports = { AboutUI };
