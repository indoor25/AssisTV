/**
 * Мастер первого запуска (#wizard-view): адреса аддона ещё нет — ведём по шагам.
 *   1. Приветствие и язык (◄► — язык, OK на «Далее»; новый язык — перезапуск, мастер откроется снова на нём).
 *   2. Адрес аддона: поле (OK — клавиатура) и «Далее» — app.js проверяет адрес регистрацией в аддоне.
 *   3. Код привязки — обычный экран PairingUI с подписью «Шаг 3 из 3» (см. app.js, waitForPairing).
 *   4. «Готово»: какие кнопки что делают.
 * Как и в Настройках, стрелки только подсвечивают поле: системная клавиатура Samsung всплывает от фокуса <input>.
 */
const WizardUI = (() => {
    let container = null;
    let opts = {};
    let step = null;          // 'welcome' | 'address' | 'done'
    let items = [];           // элементы, по которым ходит фокус: {el, kind: 'choice'|'input'|'button', action?}
    let focus = 0;
    let langIdx = 0;
    let langs = [];
    let input = null;
    let errorEl = null;
    let busy = false;

    /** o: languages() → [{value, label}], language — текущее значение, onLanguage(value), onAddress(url) → Promise,
     *  onExit(), onDone(). */
    function init(el, o) {
        container = el;
        opts = o || {};
    }

    const STEPS = 3;

    function el(tag, cls, text, parent) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        if (parent) parent.appendChild(e);
        return e;
    }

    function frame(stepNo, title) {
        container.innerHTML = '';
        items = [];
        input = null;
        errorEl = null;
        const box = el('div', 'wizard-box', undefined, container);
        if (stepNo) el('div', 'wizard-step', I18n.t('wizard.step', { n: stepNo, total: STEPS }), box);
        el('div', 'wizard-title', title, box);
        return box;
    }

    function button(parent, text, action, primary) {
        const b = el('div', 'wizard-button' + (primary ? ' primary' : ''), text, parent);
        items.push({ el: b, kind: 'button', action });
        return b;
    }

    function renderWelcome() {
        const box = frame(1, I18n.t('wizard.welcomeTitle'));
        const logo = el('img', 'wizard-logo', undefined);
        logo.src = 'icon.png';
        box.insertBefore(logo, box.firstChild);
        el('div', 'wizard-text', I18n.t('wizard.welcomeText'), box);
        const row = el('div', 'wizard-row', undefined, box);
        el('div', 'wizard-label', I18n.t('settings.language'), row);
        langs = opts.languages ? opts.languages() : [];
        langIdx = Math.max(0, langs.findIndex(l => l.value === opts.language));
        const choice = el('div', 'wizard-choice', '', row);
        items.push({ el: choice, kind: 'choice' });
        renderChoice();
        const buttons = el('div', 'wizard-buttons', undefined, box);
        button(buttons, I18n.t('wizard.next'), () => {
            const lang = langs[langIdx] ? langs[langIdx].value : opts.language;
            if (lang !== opts.language && opts.onLanguage) opts.onLanguage(lang);
            else open('address');
        }, true);
        el('div', 'wizard-keys', I18n.t('wizard.keysWelcome'), box);
        setFocus(items.length - 1);
    }

    function renderChoice() {
        const c = items.find(i => i.kind === 'choice');
        if (c && langs[langIdx]) c.el.textContent = '◄  ' + langs[langIdx].label + '  ►';
    }

    function renderAddress(value) {
        const box = frame(2, I18n.t('wizard.addressTitle'));
        el('div', 'wizard-text', I18n.t('wizard.addressText'), box);
        input = el('input', 'wizard-input', undefined, box);
        input.type = 'text';
        input.placeholder = '192.168.1.10:8765';
        input.value = value || '';
        items.push({ el: input, kind: 'input' });
        errorEl = el('div', 'wizard-error hidden', '', box);
        const buttons = el('div', 'wizard-buttons', undefined, box);
        button(buttons, I18n.t('wizard.back'), () => open('welcome'));
        button(buttons, I18n.t('wizard.next'), checkAddress, true);
        el('div', 'wizard-keys', I18n.t('wizard.keysAddress'), box);
        setFocus(0);
    }

    function renderDone() {
        const box = frame(0, I18n.t('wizard.doneTitle'));
        el('div', 'wizard-text', I18n.t('wizard.doneText'), box);
        const list = el('div', 'wizard-hints', undefined, box);
        ['wizard.hintList', 'wizard.hintBar', 'wizard.hintInfo', 'wizard.hintHome', 'wizard.hintChannels', 'wizard.hintSettings']
            .forEach(k => el('div', 'wizard-hint', I18n.t(k), list));
        const buttons = el('div', 'wizard-buttons', undefined, box);
        button(buttons, I18n.t('wizard.watch'), close, true);
        setFocus(0);
    }

    async function checkAddress() {
        if (busy) return;
        stopEditing();
        const url = input.value.trim();
        if (!url) { showError(I18n.t('wizard.addressEmpty')); return; }
        busy = true;
        showError(I18n.t('wizard.checking'), true);
        let err = null;
        try { await opts.onAddress(url); } catch (e) { err = e && e.message ? e.message : String(e); }
        busy = false;
        if (err) showError(I18n.t('wizard.addressFailed', { error: err }));
    }

    function showError(text, info) {
        if (!errorEl) return;
        errorEl.textContent = text;
        errorEl.classList.toggle('info', !!info);
        errorEl.classList.remove('hidden');
    }

    function setFocus(i) {
        if (!items.length) return;
        stopEditing();
        focus = Math.max(0, Math.min(i, items.length - 1));
        items.forEach((it, n) => it.el.classList.toggle('focused', n === focus));
    }

    function stopEditing() {
        if (input && document.activeElement === input) input.blur();
    }

    function isEditing() {
        return !!input && document.activeElement === input;
    }

    function open(name, value) {
        if (!container) return;
        step = name;
        busy = false;
        if (name === 'welcome') renderWelcome();
        else if (name === 'address') renderAddress(value);
        else renderDone();
        container.classList.remove('hidden');
    }

    function close() {
        stopEditing();
        const wasDone = step === 'done';
        step = null;
        if (container) { container.classList.add('hidden'); container.innerHTML = ''; }
        if (wasDone && opts.onDone) opts.onDone();
    }

    function isOpen() {
        return !!container && !container.classList.contains('hidden');
    }

    /** Кнопки пульта, пока мастер открыт. name — как в remoteKeys app.js. */
    function handleKey(name) {
        if (isEditing()) {
            // идёт ввод: OK/RETURN/«Готово»/«Отмена» клавиатуры — закончить ввод, остальное — клавиатуре
            if (name === 'onEnter' || name === 'onBack' || name === 'onImeDone' || name === 'onImeCancel') stopEditing();
            return;
        }
        const cur = items[focus];
        switch (name) {
            case 'onUp': setFocus(focus - 1); break;
            case 'onDown': setFocus(focus + 1); break;
            case 'onLeft':
            case 'onRight':
                if (cur && cur.kind === 'choice') {
                    langIdx = Math.max(0, Math.min(langIdx + (name === 'onLeft' ? -1 : 1), langs.length - 1));
                    renderChoice();
                } else if (cur && cur.kind === 'button') {
                    const buttons = items.filter(i => i.kind === 'button');
                    const b = buttons.indexOf(cur) + (name === 'onLeft' ? -1 : 1);
                    if (buttons[b]) setFocus(items.indexOf(buttons[b]));
                }
                break;
            case 'onEnter':
                if (!cur) break;
                if (cur.kind === 'input') cur.el.focus();
                else if (cur.kind === 'button') cur.action();
                else setFocus(items.length - 1);
                break;
            case 'onBack':
                if (step === 'address') open('welcome');
                else if (step === 'done') close();
                else if (opts.onExit) opts.onExit();
                break;
        }
    }

    return { init, open, close, isOpen, handleKey, step: () => step };
})();

if (typeof module !== 'undefined') module.exports = { WizardUI };
