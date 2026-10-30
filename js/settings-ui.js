/**
 * Settings screen: адрес аддона Home Assistant, MQTT и часы. Persisted to localStorage; app.js calls
 * getEffectiveConfig() at startup (and again after a save) to merge stored overrides onto
 * the hardcoded defaults, so an empty field just falls back rather than blanking a setting.
 *
 * Плейлисты на телевизоре больше не правятся: они настраиваются в аддоне (ha-addon/epg_builder),
 * телевизор получает их при регистрации (js/addon-client.js) и только выбирает. Поля MQTT можно
 * оставить пустыми — тогда адрес брокера и логин берутся из ответа аддона.
 *
 * Язык интерфейса — переключатель вверху (js/i18n.js); после смены app.js перезапускает приложение.
 *
 * Внизу — справка «что это за телевизор»: его tv_id и топики MQTT (app.js передаёт getInfo в init).
 *
 * Fields are plain <input> elements. Up/Down only highlight a field; OK puts real DOM focus
 * into it, which is what brings up Samsung's system keyboard (confirmed on the TV: focusing
 * an input opens it). OK / RETURN / IME "Done" while editing just blur the field again —
 * see isEditing()/stopEditing() and their routing in app.js.
 */
const SettingsUI = (() => {
    const STORAGE_KEY = 'tizeniptv.settings.v1';

    // Подписи — на языке интерфейса, поэтому список собирается при каждом открытии (build)
    function fields() {
        return [
            // Переключатели ◄► — без экранной клавиатуры
            { key: 'language', label: I18n.t('settings.language'), type: 'choice', section: I18n.t('settings.sectionLanguage'), options: languageOptions() },
            { key: 'addonUrl', label: I18n.t('settings.addonUrl'), section: I18n.t('settings.sectionPlaylists') },
            { key: 'mqttHost', label: I18n.t('settings.mqttHost'), section: 'Home Assistant (MQTT)' },
            { key: 'mqttPort', label: 'MQTT port (WebSocket)' },
            { key: 'mqttUsername', label: 'MQTT username' },
            { key: 'mqttPassword', label: 'MQTT password' },
            { key: 'clockPosition', label: I18n.t('settings.clockPosition'), type: 'choice', section: I18n.t('settings.sectionClock'), options: [
                { value: 'right', label: I18n.t('settings.clockRight') }, { value: 'left', label: I18n.t('settings.clockLeft') },
                { value: 'off', label: I18n.t('settings.clockOff') }
            ] },
            { key: 'timeOffset', label: I18n.t('settings.timeOffset'), type: 'choice', options: offsetOptions() }
        ];
    }
    let FIELDS = [];

    const CHOICE_DEFAULTS = { language: 'auto', clockPosition: 'right', timeOffset: '0' };

    function offsetOptions() {
        const list = [];
        for (let h = -12; h <= 14; h++) {
            list.push({ value: String(h), label: h === 0 ? I18n.t('settings.offsetNone') : I18n.t('settings.offsetHours', { h: (h > 0 ? '+' : '−') + Math.abs(h) }) });
        }
        return list;
    }

    /** «Как у телевизора (English)», затем языки — каждый своим названием. */
    function languageOptions() {
        return [{ value: 'auto', label: I18n.t('settings.languageAuto', { name: I18n.languageName(I18n.systemLanguage()) }) }]
            .concat(I18n.languages().map(l => ({ value: l.code, label: l.name })));
    }

    let container = null;
    let onSave = () => {};
    let getInfo = () => [];
    let inputs = {};       // key -> <input> или, для переключателей, <div class="settings-choice">
    let choiceValues = {}; // key -> текущее значение переключателя
    let focusables = [];   // поля и кнопки в порядке на экране
    let focusIndex = 0;

    function loadStored() {
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
        catch (e) { return {}; }
    }

    function saveStored(values) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
    }

    /**
     * Merges stored overrides onto hardcoded defaults. Call at startup and again after a
     * save; `defaults` is CONFIG_DEFAULTS from app.js so this module doesn't need to know
     * the fallback values itself. mqtt — только заполненные поля: остальное app.js берёт из аддона.
     */
    function getEffectiveConfig(defaults) {
        const stored = loadStored();
        const mqtt = {};
        if (stored.mqttHost) mqtt.host = stored.mqttHost;
        if (stored.mqttPort) mqtt.port = parseInt(stored.mqttPort, 10);
        if (stored.mqttUsername) mqtt.username = stored.mqttUsername;
        if (stored.mqttPassword) mqtt.password = stored.mqttPassword;
        return {
            language: stored.language || CHOICE_DEFAULTS.language,
            addonUrl: stored.addonUrl || defaults.addonUrl,
            mqtt,
            clock: {
                position: stored.clockPosition || CHOICE_DEFAULTS.clockPosition,
                offsetHours: parseInt(stored.timeOffset || CHOICE_DEFAULTS.timeOffset, 10) || 0
            }
        };
    }

    /** opts: onSave(values, sourcesChanged, error), getInfo() → [[подпись, значение]] для справки. */
    function init(el, opts = {}) {
        container = el;
        onSave = opts.onSave || onSave;
        getInfo = opts.getInfo || getInfo;
    }

    function section(text) {
        const el = document.createElement('div');
        el.className = 'settings-section';
        el.textContent = text;
        container.appendChild(el);
    }

    function addRow(labelText, input) {
        const row = document.createElement('div');
        row.className = 'settings-row';
        const label = document.createElement('label');
        label.textContent = labelText;
        row.appendChild(label);
        row.appendChild(input);
        container.appendChild(row);
        focusables.push(input);
        return row;
    }

    function button(text, onClick) {
        const btn = document.createElement('div');
        btn.className = 'settings-btn';
        btn.textContent = text;
        btn.addEventListener('click', onClick);
        return btn;
    }

    function build() {
        container.innerHTML = '';
        inputs = {};
        focusables = [];
        FIELDS = fields();

        FIELDS.forEach(f => {
            if (f.section) section(f.section);
            let input;
            if (f.type === 'choice') {
                input = document.createElement('div');
                input.className = 'settings-choice';
            } else {
                input = document.createElement('input');
                input.type = f.key === 'mqttPassword' ? 'password' : 'text';
                input.className = 'settings-input';
            }
            addRow(f.label, input);
            inputs[f.key] = input;
        });

        const actions = document.createElement('div');
        actions.className = 'settings-actions';
        const saveBtn = button(I18n.t('settings.save'), doSave);
        const cancelBtn = button(I18n.t('settings.cancel'), close);
        actions.appendChild(saveBtn);
        actions.appendChild(cancelBtn);
        container.appendChild(actions);
        focusables.push(saveBtn, cancelBtn);

        // справка — без фокуса, просто текст под кнопками
        const info = getInfo();
        if (info.length) {
            section(I18n.t('settings.thisTv'));
            info.forEach(([label, value]) => {
                const row = document.createElement('div');
                row.className = 'settings-info';
                const l = document.createElement('span');
                l.className = 'settings-info-label';
                l.textContent = label;
                const v = document.createElement('span');
                v.className = 'settings-info-value';
                v.textContent = value;
                row.appendChild(l);
                row.appendChild(v);
                container.appendChild(row);
            });
        }
    }

    function populate(defaults) {
        const stored = loadStored();
        build();
        inputs.addonUrl.value = stored.addonUrl || defaults.addonUrl || '';
        inputs.mqttHost.value = stored.mqttHost || '';
        inputs.mqttPort.value = stored.mqttPort || '';
        inputs.mqttUsername.value = stored.mqttUsername || '';
        inputs.mqttPassword.value = stored.mqttPassword || '';
        FIELDS.filter(f => f.type === 'choice').forEach(f => {
            choiceValues[f.key] = stored[f.key] || CHOICE_DEFAULTS[f.key];
            renderChoice(f);
        });
    }

    function renderChoice(f) {
        const opt = f.options.find(o => o.value === choiceValues[f.key]) || f.options[0];
        inputs[f.key].textContent = '◄  ' + opt.label + '  ►';
    }

    /** ◄► на переключателе. Возвращает true, если нажатие обработано (фокус на переключателе). */
    function changeValue(delta) {
        const f = FIELDS.find(field => inputs[field.key] === focusables[focusIndex]);
        if (!f || f.type !== 'choice') return false;
        const idx = f.options.findIndex(o => o.value === choiceValues[f.key]);
        const next = Math.max(0, Math.min(idx + delta, f.options.length - 1));
        choiceValues[f.key] = f.options[next].value;
        renderChoice(f);
        return true;
    }

    function doSave() {
        const values = {
            addonUrl: inputs.addonUrl.value.trim(),
            mqttHost: inputs.mqttHost.value.trim(),
            mqttPort: inputs.mqttPort.value.trim(),
            mqttUsername: inputs.mqttUsername.value.trim(),
            mqttPassword: inputs.mqttPassword.value,
            language: choiceValues.language,
            clockPosition: choiceValues.clockPosition,
            timeOffset: choiceValues.timeOffset
        };
        const prev = loadStored();
        // перезагружать плейлисты/MQTT нужно, только если менялись их адреса
        const sourcesChanged = ['addonUrl', 'mqttHost', 'mqttPort', 'mqttUsername', 'mqttPassword']
            .some(k => (prev[k] || '') !== (values[k] || ''));

        // Проверяем, что запись реально легла в localStorage (читаем обратно): на TV логов нет,
        // и без этого «сохранил, а ничего не поменялось» не отличить от ошибки хранилища.
        let error = null;
        try {
            saveStored(values);
            if (JSON.stringify(loadStored()) !== JSON.stringify(values)) error = I18n.t('settings.notWritten');
        } catch (e) {
            error = e && e.message ? e.message : String(e);
        }
        close();
        onSave(values, sourcesChanged, error);
    }

    /** Если в поле открыта клавиатура — закрыть её (снять фокус с поля). */
    function stopEditing() {
        const active = document.activeElement;
        if (active && container.contains(active) && typeof active.blur === 'function') active.blur();
    }

    /** Идёт ли сейчас ввод текста в поле (фокус в <input> настроек, клавиатура на экране). */
    function isEditing() {
        const active = document.activeElement;
        return !!active && active.tagName === 'INPUT' && !!container && container.contains(active);
    }

    /**
     * Стрелки только ПОДСВЕЧИВАЮТ поле, но не ставят в него фокус: на Samsung системная клавиатура
     * всплывает от фокуса поля, и раньше она выскакивала на каждом шаге ▲▼. Хуже того, у кнопок
     * «Сохранить/Отмена» (div) своего фокуса нет — фокус оставался в последнем поле с открытой
     * клавиатурой, и OK на «Сохранить» забирала клавиатура, а не приложение (настройки не сохранялись).
     */
    function setFocus(idx) {
        if (!focusables.length) return;
        stopEditing();
        focusIndex = Math.max(0, Math.min(idx, focusables.length - 1));
        focusables.forEach(f => f.classList.remove('focused'));
        const el = focusables[focusIndex];
        el.classList.add('focused');
        // на последней кнопке докручиваем до конца — там справка о телевизоре
        if (focusIndex === focusables.length - 1) container.scrollTop = container.scrollHeight;
        else el.scrollIntoView({ block: 'nearest' });
    }

    function moveFocus(delta) {
        setFocus(focusIndex + delta);
    }

    /** OK: на кнопке — нажать; на текстовом поле — начать ввод (фокус → клавиатура);
     *  на переключателе — следующее значение. */
    function activateFocused() {
        const el = focusables[focusIndex];
        if (!el) return;
        if (el.classList.contains('settings-btn')) { stopEditing(); el.click(); }
        else if (el.tagName === 'INPUT') {
            el.focus();
            // курсор в конец — править URL обычно приходится с хвоста
            try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) { /* type=password */ }
        }
        else if (el.classList.contains('settings-choice')) {
            const f = FIELDS.find(field => inputs[field.key] === el);
            const idx = f.options.findIndex(o => o.value === choiceValues[f.key]);
            choiceValues[f.key] = f.options[(idx + 1) % f.options.length].value;
            renderChoice(f);
        }
    }

    /** opts.focus — ключ поля, на котором встать (addonUrl…); opts.note — пояснение над полями. */
    function open(defaults, opts = {}) {
        if (!container) return;
        populate(defaults);
        if (opts.note) {
            const note = document.createElement('div');
            note.className = 'settings-note';
            note.textContent = opts.note;
            container.insertBefore(note, container.firstChild);
        }
        container.classList.remove('hidden');
        container.scrollTop = 0;
        setFocus(Math.max(0, focusables.indexOf(inputs[opts.focus])));
    }

    function close() {
        if (!container) return;
        stopEditing();
        container.classList.add('hidden');
    }

    function toggle(defaults) {
        isOpen() ? close() : open(defaults);
    }

    function isOpen() {
        return !!container && !container.classList.contains('hidden');
    }

    return {
        init, open, close, toggle, isOpen, moveFocus, activateFocused, changeValue,
        isEditing, stopEditing, getEffectiveConfig
    };
})();

if (typeof module !== 'undefined') module.exports = { SettingsUI };
