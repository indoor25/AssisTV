/**
 * App entry point: registers the TV in the Home Assistant add-on, loads the playlist (channels + EPG
 * prepared by the add-on), wires up player/UI/remote/MQTT.
 *
 * Плейлисты настраиваются в аддоне (ha-addon/epg_builder), телевизор только выбирает их
 * (js/addon-client.js). CONFIG_DEFAULTS below are the hardcoded fallbacks; SettingsUI lets you
 * override the add-on address/MQTT/clock on the TV itself, persisted in localStorage (see
 * settings-ui.js). CONFIG is the *effective* config and is what the rest of the app reads —
 * everything below should read CONFIG, never CONFIG_DEFAULTS directly.
 */
const CONFIG_DEFAULTS = (function () {
    // Адрес аддона вводится на TV в Настройках. Своя сборка может подставить умолчания файлом
    // js/local-defaults.js (window.LOCAL_DEFAULTS = {addonUrl, mqtt}) — его кладёт tools/build-wgt.ps1,
    // в репозитории его нет.
    const local = (typeof window !== 'undefined' && window.LOCAL_DEFAULTS) || {};
    return {
        // аддон Home Assistant: плейлисты, EPG, реестр телевизоров
        addonUrl: local.addonUrl || '',
        // запасной вариант, если аддон ещё ни разу не ответил; иначе адрес и логин брокера выдаёт он
        mqtt: Object.assign({ host: '', port: 1884, username: '', password: '' }, local.mqtt)
    };
})();
let CONFIG = {
    language: 'auto',  // язык интерфейса ('auto' — как у телевизора), js/i18n.js
    addonUrl: CONFIG_DEFAULTS.addonUrl,
    mqtt: CONFIG_DEFAULTS.mqtt,
    mqttOverride: {},  // поля MQTT, заполненные в Настройках, — важнее того, что выдал аддон
    clock: { position: 'right', offsetHours: 0 },
    playlists: [],     // [{id, name, kind: 'tv'|'vod', url?}] — из аддона
    tv: null,          // {tv_id, name, area} — из аддона
    activeTv: null     // открытый M3U-плейлист (элемент playlists), см. resolveActiveTvPlaylist
};

let channels = [];
let currentIndex = 0;
let addonReg = null;        // последний ответ регистрации в аддоне (или его копия из кеша)
let viewPlaylist = null;    // имя плейлиста, который сейчас на экране (M3U или видеопортал) — для HA

const nonEmpty = obj => {
    const out = {};
    Object.keys(obj || {}).forEach(k => { if (obj[k] !== '' && obj[k] !== null && obj[k] !== undefined) out[k] = obj[k]; });
    return out;
};

/** Настройки с экрана настроек поверх умолчаний; MQTT: Настройки > аддон > CONFIG_DEFAULTS. */
function applySettings() {
    const s = SettingsUI.getEffectiveConfig(CONFIG_DEFAULTS);
    CONFIG.language = s.language;
    CONFIG.addonUrl = s.addonUrl;
    CONFIG.clock = s.clock;
    CONFIG.mqttOverride = s.mqtt;
    // свой брокер в Настройках — целиком свой (MQTT через аддон с его путём /mqtt и токеном тут ни при чём)
    const own = Object.keys(nonEmpty(s.mqtt)).length > 0;
    CONFIG.mqtt = Object.assign({}, CONFIG_DEFAULTS.mqtt, own ? {} : nonEmpty(addonReg && addonReg.mqtt), s.mqtt);
    AddonClient.setAddonUrl(CONFIG.addonUrl);    // фильмы: плагины выполняет аддон (js/vod-client.js)
    VodFavorites.setAddonUrl(CONFIG.addonUrl);   // избранное видеопортала лежит в аддоне, общее на все TV
    VodUI.setAddonUrl(CONFIG.addonUrl);          // рейтинги и рецензии аддон тоже берёт на себя
}

function applyRegistration(reg) {
    addonReg = reg;
    CONFIG.playlists = Array.isArray(reg.playlists) ? reg.playlists : [];
    CONFIG.tv = { tv_id: reg.tv_id, name: reg.name, area: reg.area };
    Parental.configure(reg.parental);
    applySettings();
}

/** Тип источника фильмов у плейлиста: новый аддон присылает src, старый — адрес с типом. */
const vodSourceType = p => p.src || (VodSources.parseUrl(p.url) || {}).type;

const tvPlaylists = () => CONFIG.playlists.filter(p => p.kind !== 'vod');

/**
 * Какой M3U-плейлист открыт: выбранный в окне выбора плейлиста (Prefs activePlaylist — по имени:
 * id в аддоне — это позиция в списке, она меняется, если плейлисты переставить), иначе первый M3U.
 * Порталы сюда не попадают — они открываются экраном VodUI.
 */
function resolveActiveTvPlaylist() {
    const want = Prefs.get('activePlaylist', null);
    const list = tvPlaylists();
    CONFIG.activeTv = list.find(p => p.name === want) || list[0] || null;
}

/** Имя плейлиста на экране поменялось — сообщить в HA (iptv/<tv_id>/current_playlist). */
function setViewPlaylist(name) {
    if (name === viewPlaylist) return;
    viewPlaylist = name;
    MqttBridge.playlistChanged();
}

/**
 * Каналы открытого M3U вместе с EPG — одним запросом к аддону. offline: аддон уже не ответил на
 * регистрацию — сразу берём копию из кеша, не ждём таймаута второй раз.
 * → {count, fromCache, hasEpg}
 */
async function loadActiveTvPlaylist(offline) {
    const pl = CONFIG.activeTv;
    if (!pl) {                           // в аддоне одни видеопорталы — каналов нет
        ChannelStore.load([], { channels: {}, programmes: {} });
        return { count: 0, fromCache: false, hasEpg: false };
    }
    const b = await AddonClient.loadTvPlaylist(offline ? '' : CONFIG.addonUrl, pl);
    // родительский контроль «не показывать на этом TV» — защищённых каналов в приложении нет совсем
    ChannelStore.load(Parental.visibleChannels(b.channels), b.epg || { channels: {}, programmes: {} });
    if (b.fromCache && !offline) addonDown(b.error, true);
    return { count: b.channels.length, fromCache: b.fromCache, hasEpg: !!b.epg };
}

/** Каналы в ChannelStore поменялись — перерисовать список и главный экран. */
function refreshChannelsUi() {
    channels = ChannelStore.getAll();
    const playing = Player.getCurrentChannel();
    if (playing) Player.updateCurrentChannel(channels.find(c => c.key === playing.key));
    ChannelListUI.render(channels);
    ChannelListUI.setCurrentPlaying(Player.getCurrentChannel());
    HomeUI.setChannels(channels);
}

// ───────────────────────── Аддон недоступен ─────────────────────────

const ADDON_RETRY_MS = 60000;
let addonRetryTimer = null;
let addonDownWarned = false;
let addonWarnUntil = 0;     // пока висит предупреждение — «MQTT подключён» его не перекрывает

/** Предупреждение — один раз на весь сбой, дальше тихо пробуем раз в минуту. */
function addonDown(message, hasCache) {
    if (!addonDownWarned) {
        addonDownWarned = true;
        addonWarnUntil = Date.now() + 12000;
        showToast(hasCache ? I18n.t('addon.downCached') : I18n.t('addon.down', { error: message }), 'error', 12000);
    }
    clearTimeout(addonRetryTimer);
    addonRetryTimer = setTimeout(retryAddon, ADDON_RETRY_MS);
}

async function retryAddon() {
    let reg = null;
    try { reg = await AddonClient.register(CONFIG.addonUrl); } catch (e) { /* кеша тоже нет */ }
    if (reg && reg.pairing) { waitForPairing(reg.pairing); return; }
    if (!reg || reg.fromCache) {
        addonRetryTimer = setTimeout(retryAddon, ADDON_RETRY_MS);
        return;
    }
    addonDownWarned = false;
    showToast(I18n.t('addon.back'), 'ok', 4000);
    await reloadFromAddon(reg, false);
}

/**
 * Источники фильмов (плагины) — их код лежит у аддона, телевизор скачивает и выполняет его у себя.
 * Поэтому новый источник не требует пересборки приложения: файл кладут в папку плагинов аддона,
 * перезапускают аддон и перезапускают плеер. Аддон недоступен — берём то, что скачали в прошлый раз.
 * Ошибка загрузки не должна мешать каналам: без источников просто не открываются фильмы.
 */
async function loadVodSources() {
    try {
        const r = await AddonClient.loadVodSources(CONFIG.addonUrl);
        r.failed.forEach(f => console.warn('[VodSources] плагин ' + f.type + ': ' + f.error));
        console.log('[VodSources] источники: ' + (r.loaded.join(', ') || 'нет') + (r.fromCache ? ' (из кеша)' : ''));
    } catch (err) {
        console.warn('[VodSources] не загрузились', err);
    }
}

/**
 * Данные из аддона → приложение: плейлисты, каналы открытого плейлиста, MQTT. Старт, восстановление
 * связи с аддоном, смена его адреса в Настройках. Если ничего не играет и меню не открыто — включает
 * последний канал (или видеопортал, когда каналов нет).
 */
async function reloadFromAddon(reg, offline) {
    // Аддон не ответил на старте — окно выбора могло открыться пустым («Плейлистов нет»). Теперь плейлисты есть:
    // пустое окно закрываем (и главный экран под ним) — дальше как при обычном старте; непустое — обновляем.
    const staleChooser = PlaylistDialogUI.isOpen() && PlaylistDialogUI.isEmpty();
    applyRegistration(reg);
    await loadVodSources();
    resolveActiveTvPlaylist();
    const closedStale = staleChooser && CONFIG.playlists.length > 0;
    if (closedStale) {
        PlaylistDialogUI.close();
        if (HomeUI.isOpen()) HomeUI.close();
    } else {
        refreshPlaylistChooser();
    }
    // открытый видеопортал из аддона убрали — уходим на главный экран каналов
    if (VodUI.isOpen() && !CONFIG.playlists.some(p => VodClient.keyOf(p) === VodUI.getPortalUrl())) {
        VodUI.hide();
        openHome();
    }
    let result = { count: 0, hasEpg: false };
    showEpgStatus(I18n.t('playlist.loading'));
    try {
        result = await loadActiveTvPlaylist(offline);
        showEpgStatus(I18n.t(result.hasEpg ? 'epg.loaded' : 'epg.unavailable'), 4000);
    } catch (err) {
        showEpgStatus(I18n.t('playlist.failedShort'), 6000);
        showToast(I18n.t('playlist.failed', { name: CONFIG.activeTv.name, error: err.message || err }), 'error', 10000);
    }
    refreshChannelsUi();

    // закрыли зависшее пустое окно — под ним ничего не играет (главный экран останавливает плеер)
    const idle = (!Player.getCurrentMedia() || closedStale) && !menuOpen() && !SettingsUI.isOpen() && !ExitDialogUI.isOpen();
    if (idle && channels.length) {
        Player.playChannel(lastOrFirstChannel());
    } else if (idle) {
        const portal = CONFIG.playlists.find(p => p.kind === 'vod');
        if (portal) { VodUI.open(portal); setViewPlaylist(portal.name); }
    }
    if (!VodUI.isOpen()) setViewPlaylist(CONFIG.activeTv ? CONFIG.activeTv.name : null);

    if (CONFIG.mqtt.host && !MqttBridge.isConnectedWith(CONFIG.mqtt, CONFIG.tv)) {
        MqttBridge.disconnect();
        MqttBridge.connect(CONFIG.mqtt, CONFIG.tv);
    }
    return result;
}

/** Старт: регистрация в аддоне (или кеш), затем всё остальное. */
async function startFromAddon() {
    // первый запуск: без адреса аддона дальше идти некуда — сразу Настройки на этом поле
    if (!String(CONFIG.addonUrl || '').trim()) {
        openSettings({ focus: 'addonUrl', note: I18n.t('settings.needAddon') });
        return;
    }
    showEpgStatus(I18n.t('addon.connecting'));
    let reg;
    try {
        reg = await AddonClient.register(CONFIG.addonUrl);
    } catch (err) {
        showEpgStatus(I18n.t('playlist.unavailable'), 6000);
        addonDown(err.message || String(err), false);
        // ни каналов, ни кеша: окно «Плейлистов нет» со строкой Настроек, а не чёрный экран
        if (!channels.length && !menuOpen() && !SettingsUI.isOpen()) openPlaylistChooser();
        return;
    }
    if (reg.pairing) { showEpgStatus('', 1); waitForPairing(reg.pairing); return; }
    if (reg.fromCache) addonDown(reg.error, true);
    await reloadFromAddon(reg, reg.fromCache);
}

// ───────────────────────── Привязка к аддону ─────────────────────────

const PAIR_POLL_MS = 3000;
let pairTimer = null;

/**
 * Аддон не знает этот телевизор: показываем код и опрашиваем аддон, пока код не подтвердят на странице
 * IPTV в HA. Подтвердили — дальше как обычный старт. Аддон пропал — ждём молча, код остаётся на экране.
 */
function waitForPairing(pairing) {
    clearTimeout(addonRetryTimer);
    clearTimeout(pairTimer);
    PairingUI.show(pairing.code);
    const poll = async () => {
        let reg = null;
        try { reg = await AddonClient.register(CONFIG.addonUrl); } catch (e) { /* аддон недоступен — повторим */ }
        if (reg && reg.pairing) PairingUI.show(reg.pairing.code);   // заявка протухла — код новый
        if (!reg || reg.pairing || reg.fromCache) { pairTimer = setTimeout(poll, PAIR_POLL_MS); return; }
        PairingUI.hide();
        addonDownWarned = false;
        showToast(I18n.t('pair.done'), 'ok', 4000);
        await reloadFromAddon(reg, false);
    };
    pairTimer = setTimeout(poll, PAIR_POLL_MS);
}

/** Аддон пересобрал плейлисты (MQTT iptv/playlists) — новый список, свежий EPG открытого M3U. */
async function onAddonPlaylistsChanged() {
    try {
        CONFIG.playlists = await AddonClient.fetchPlaylists(CONFIG.addonUrl);
    } catch (err) {
        return;   // аддон перезапускается — список придёт ещё раз
    }
    const prevName = CONFIG.activeTv && CONFIG.activeTv.name;
    resolveActiveTvPlaylist();
    refreshPlaylistChooser();
    MqttBridge.playlistChanged();
    if (VodUI.isOpen() && !CONFIG.playlists.some(p => VodClient.keyOf(p) === VodUI.getPortalUrl())) {
        VodUI.hide();
        openHome();
    }
    const changed = (CONFIG.activeTv && CONFIG.activeTv.name) !== prevName;
    // пока открыт какой-то экран — не перерисовываем (сбило бы фокус); EPG подтянется по таймеру.
    // Каналов ещё нет (первая настройка) — сбивать нечего: берём сразу, иначе ждать бы до 3 часов.
    const wasEmpty = !channels.length;
    if (!changed && !wasEmpty && screensBusy()) return;
    let result;
    try {
        result = await loadActiveTvPlaylist(false);
        refreshChannelsUi();
    } catch (err) {
        console.error('[Addon] playlist reload failed', err);
        return;
    }
    // появились первые каналы — убираем пустое окно и главный экран, включаем канал
    if (wasEmpty && channels.length && !SettingsUI.isOpen() && !ExitDialogUI.isOpen() && !PairingUI.isOpen() && !VodUI.isOpen()) {
        PlaylistDialogUI.close();
        if (HomeUI.isOpen()) HomeUI.close();
        Player.playChannel(lastOrFirstChannel());
        showToast(I18n.t(result && result.hasEpg ? 'playlist.loaded' : 'playlist.loadedNoEpg',
            { name: CONFIG.activeTv.name, n: channels.length }), 'ok', 5000);
    }
}

/** Открыт экран, который перерисовка каналов собьёт. */
function screensBusy() {
    return ChannelListUI.isOpen() || ChannelEpgUI.isOpen() || SideMenuUI.isOpen() ||
        SettingsUI.isOpen() || menuOpen() || PlayerBarUI.isOpen();
}

/** ms: через сколько скрыть (по умолчанию висит, пока не сменят текст). */
function showEpgStatus(text, ms) {
    const el = document.getElementById('epg-status');
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(showEpgStatus._t);
    if (ms) showEpgStatus._t = setTimeout(() => el.classList.add('hidden'), ms);
}

function startClock() {
    const el = document.getElementById('clock');
    const tick = () => {
        el.textContent = AppClock.local(Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };
    tick();
    setInterval(tick, 1000);
}

/** Положение часов и смещение времени из настроек: clock = CONFIG.clock ({position, offsetHours}). */
function applyClockSettings(clock) {
    AppClock.setOffsetHours(clock.offsetHours);
    const el = document.getElementById('clock');
    el.classList.toggle('left', clock.position === 'left');
    el.classList.toggle('hidden', clock.position === 'off');
    el.textContent = AppClock.local(Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Multi-digit channel number entry (e.g. "12" then "3" -> channel 123): digits accumulate in
// numberBuffer and show in #number-osd until either a short pause (NUMBER_ENTRY_TIMEOUT_MS) or
// the buffer hits the max plausible channel-count digit length, then commit as a channel index.
const NUMBER_ENTRY_TIMEOUT_MS = 1500;
const NUMBER_ENTRY_MAX_DIGITS = 4; // enough for ~1977 channels
let numberBuffer = '';
let numberEntryTimer = null;

function onNumberKey(digit) {
    numberBuffer += String(digit);
    const osd = document.getElementById('number-osd');
    osd.textContent = numberBuffer;
    osd.classList.remove('hidden');

    clearTimeout(numberEntryTimer);
    if (numberBuffer.length >= NUMBER_ENTRY_MAX_DIGITS) {
        commitNumberEntry();
    } else {
        numberEntryTimer = setTimeout(commitNumberEntry, NUMBER_ENTRY_TIMEOUT_MS);
    }
}

function commitNumberEntry() {
    clearTimeout(numberEntryTimer);
    const n = parseInt(numberBuffer, 10);
    numberBuffer = '';
    document.getElementById('number-osd').classList.add('hidden');

    // Channel "number" = 1-based position in ChannelStore's current sort order — the same
    // order the channel list UI renders, so it matches what's on screen.
    if (n >= 1 && n <= channels.length) {
        const channel = channels[n - 1];
        const play = () => { currentIndex = n - 1; Player.playChannel(channel); };
        if (Parental.isLocked(channel)) askPin(play); else play();
    }
}

/** Следующий (+1) / предыдущий (−1) канал в общей сортировке — CH+/CH− и команды next/prev из MQTT. */
function switchChannel(step) {
    if (!channels.length) return;
    let idx = currentIndex;
    // каналы под замком родительского контроля пропускаем
    for (let i = 0; i < channels.length; i++) {
        idx = (idx + step + channels.length) % channels.length;
        if (!Parental.isLocked(channels[idx])) break;
    }
    if (Parental.isLocked(channels[idx])) return;
    currentIndex = idx;
    Player.playChannel(channels[currentIndex]);
}

/** Подсказка по кнопкам: висит после запуска и ненадолго возвращается при смене канала —
 *  иначе на телевизоре неоткуда узнать, как открыть список, панель плеера и главный экран. */
function flashKeyHints(ms = 15000) {
    const el = document.getElementById('key-hints');
    el.classList.remove('hidden');
    clearTimeout(flashKeyHints._t);
    flashKeyHints._t = setTimeout(() => el.classList.add('hidden'), ms);
}

function showOsd(channel) {
    flashKeyHints(5000);
    const osd = document.getElementById('channel-osd');
    document.getElementById('osd-logo').src = channel.logo || '';
    document.getElementById('osd-name').textContent = channel.name;
    const now = ChannelStore.getCurrentProgrammeFor(channel);
    document.getElementById('osd-epg-now').textContent = now ? now.title : '';
    document.getElementById('osd-video').textContent = '';
    osd.classList.remove('hidden');
    clearTimeout(showOsd._t);
    showOsd._t = setTimeout(() => osd.classList.add('hidden'), 4000);
}

/**
 * Индикатор ожидания картинки (#buffering): заголовок, заполнение буфера в процентах с полосой и
 * сколько секунд уже ждём. Проценты присылает AVPlay; если поток завис молча, они стоят на 0%, но
 * секунды всё равно бегут — видно, что приложение живо и ждёт данные.
 */
function showBuffering(isWaiting, info) {
    document.getElementById('buffering').classList.toggle('hidden', !isWaiting);
    if (!isWaiting) return;
    document.getElementById('buffering-title').textContent =
        info.reason === 'open'
            ? I18n.t(Player.isVod() ? 'buffering.loading' : Player.isArchive() ? 'buffering.loadingArchive' : 'buffering.connecting')
            : I18n.t(Player.isVod() || Player.isArchive() ? 'buffering.buffering' : 'buffering.interrupted');
    document.getElementById('buffering-percent').textContent = info.percent + '%';
    document.getElementById('buffering-bar-fill').style.width = info.percent + '%';
    document.getElementById('buffering-wait').textContent = info.seconds > 0 ? I18n.t('buffering.wait', { s: info.seconds }) : '';
}

/** Разрешение кадра в плашке канала: логов на TV нет, а так видно, почему канал растянут или нет. */
function showVideoInfo(info) {
    document.getElementById('osd-video').textContent = info
        ? info.width + '×' + info.height + (info.scaled ? ' · ' + I18n.t('video.stretched') : '')
        : '';
}

/**
 * Пользовательские предпочтения, которые меняются не на экране настроек (режим масштаба,
 * последний канал). Отдельный ключ: SettingsUI при сохранении перезаписывает свой объект целиком.
 */
const Prefs = (() => {
    const KEY = 'tizeniptv.prefs.v1';
    function load() {
        try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; }
    }
    return {
        get: (name, def) => { const v = load()[name]; return v === undefined ? def : v; },
        set: (name, value) => {
            const all = load();
            all[name] = value;
            localStorage.setItem(KEY, JSON.stringify(all));
        }
    };
})();

/** Последний просмотренный канал (по key), иначе первый — с него приложение и стартует. */
function lastOrFirstChannel() {
    const key = Prefs.get('lastChannelKey', null);
    const last = channels.find(c => c.key === key);
    // под замком родительского контроля — не включаем сам, берём первый открытый
    if (last && !Parental.isLocked(last)) return last;
    return channels.find(c => !Parental.isLocked(c)) || channels[0];
}

// ───────────────────────── Родительский контроль ─────────────────────────

/** PIN-код (проверяет аддон) → защищённые группы открыты до выключения TV → onSuccess. */
function askPin(onSuccess) {
    PinDialogUI.open({
        title: I18n.t('parental.title'),
        text: I18n.t('parental.text'),
        check: pin => AddonClient.checkPin(CONFIG.addonUrl, CONFIG.tv && CONFIG.tv.tv_id, pin)
            .catch(() => ({ ok: false, message: I18n.t('parental.addonDown') })),
        onSuccess: () => {
            Parental.unlock();
            refreshParentalUi();
            if (onSuccess) onSuccess();
        }
    });
}

/** Замок открыли/закрыли или поменяли группы — перерисовать группы, плитки и список (с тем же выбором). */
function refreshParentalUi() {
    HomeUI.setChannels(channels);
    ChannelListUI.render(channels);
}

/** Играет канал, который теперь под замком, — уходим на главный экран (как RETURN). */
function leaveLockedChannel() {
    const cur = Player.getCurrentChannel();
    if (!cur || !Parental.isLocked(cur) || Player.isVod() || HomeUI.isOpen() || VodUI.isOpen() || PlaylistDialogUI.isOpen()) return;
    openHome();
}

/** Защита из аддона (MQTT iptv/<tv_id>/config) поменялась. */
function applyParental(p) {
    const r = Parental.configure(p);
    if (!r.changed) return;
    AddonClient.cacheParental(p);
    PinDialogUI.close();
    if (r.hideChanged && CONFIG.activeTv) {
        // «не показывать» включили/выключили — каналы нужно загрузить заново
        closeOverlays();
        loadActiveTvPlaylist(false).then(() => { refreshChannelsUi(); leaveLockedChannel(); })
            .catch(err => console.error('[Parental] playlist reload failed', err));
        return;
    }
    if (SideMenuUI.isOpen()) closeGroupsPanel();
    refreshParentalUi();
    leaveLockedChannel();
}

/** TV выключили или приложение ушло в фон — защищённое снова закрыто. */
function relockParental() {
    PinDialogUI.close();
    if (!Parental.lock()) return;
    closeOverlays();
    refreshParentalUi();
}

/**
 * Индикатор состояния воспроизведения (#play-state) по центру экрана — после Play/Pause/Stop.
 * Пауза и стоп висят, пока воспроизведение не возобновят (иначе застывший кадр не отличить от
 * зависшего потока); «воспроизведение» мелькает на пару секунд и прячется.
 */
function showPlayState(forcedState) {
    const el = document.getElementById('play-state');
    const st = forcedState || Player.getState();
    clearTimeout(showPlayState._t);
    if (st === 'PAUSED') {
        el.textContent = '❚❚  ' + I18n.t('state.paused');
    } else if (st === 'IDLE' || st === 'NONE') {
        el.textContent = '■  ' + I18n.t('state.stopped');
    } else {
        el.textContent = '▶  ' + I18n.t('state.playing');
        showPlayState._t = setTimeout(() => el.classList.add('hidden'), 2000);
    }
    el.classList.remove('hidden');
}

function hidePlayState() {
    clearTimeout(showPlayState._t);
    document.getElementById('play-state').classList.add('hidden');
}

/** Остановленный поток play() уже не запустит — его нужно открыть заново. */
function playOrResume() {
    const st = Player.getState();
    if (st === 'PAUSED') Player.resume();
    else if (st === 'IDLE' || st === 'NONE') {
        // остановленный фильм — с того места, где остановились
        const media = Player.getCurrentMedia();
        Player.restart(Player.isVod() ? VodHistory.getResume(media.id) : 0);
    }
    // после restart() поток открывается асинхронно и AVPlay ещё какое-то время отвечает IDLE
    showPlayState('PLAYING');
}

function togglePlayPause() {
    if (Player.getState() === 'PLAYING') { Player.pause(); showPlayState(); }
    else playOrResume();
}

/** Всплывающее сообщение внизу экрана. kind: 'ok' | 'error'. */
function hideToast() {
    clearTimeout(showToast._t);
    document.getElementById('toast').classList.add('hidden');
}

/** Настройки. Висящая плашка внизу закрыла бы кнопку «Сохранить» — убираем её. */
function openSettings(opts) {
    hideToast();
    SettingsUI.open(CONFIG_DEFAULTS, opts);
}

function showToast(text, kind = 'ok', ms = 4000) {
    const el = document.getElementById('toast');
    el.textContent = text;
    el.className = kind === 'error' ? 'error' : 'ok';
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.add('hidden'), ms);
}

/** SettingsUI onSave. Часы применяются всегда; аддон/MQTT переподключаются, только если менялись их
 *  адреса — иначе смена положения часов переключала бы канал.
 *  Итог показывается всплывающим сообщением: логов на TV нет. */
async function reloadFromSettings(values, sourcesChanged, saveError) {
    if (saveError) {
        showToast(I18n.t('settings.notSaved', { error: saveError }), 'error', 8000);
        return;
    }
    // язык сменился — весь интерфейс собран на старом, проще перезапустить приложение
    if ((values.language || 'auto') !== CONFIG.language) {
        saveVodPosition();
        location.reload();
        return;
    }
    const prevAddon = AddonClient.base(CONFIG.addonUrl);
    applySettings();
    applyClockSettings(CONFIG.clock);
    if (HomeUI.isOpen()) HomeUI.setChannels(channels); // прогресс передач зависит от смещения
    if (!sourcesChanged) {
        showToast(I18n.t('settings.saved'));
        return;
    }
    if (AddonClient.base(CONFIG.addonUrl) === prevAddon) {
        if (CONFIG.tv && CONFIG.mqtt.host) { MqttBridge.disconnect(); MqttBridge.connect(CONFIG.mqtt, CONFIG.tv); }
        showToast(I18n.t('settings.saved'));
        return;
    }

    showToast(I18n.t('settings.savedConnecting'), 'ok', 15000);
    let reg;
    try {
        reg = await AddonClient.register(CONFIG.addonUrl);
        if (reg.fromCache) throw new Error(reg.error);
    } catch (err) {
        showToast(I18n.t('settings.savedAddonDown', { error: err.message || err }), 'error', 10000);
        return;
    }
    // новый аддон этот телевизор не знает — код привязки (Настройки закрываются, чтобы код был виден)
    if (reg.pairing) { SettingsUI.close(); waitForPairing(reg.pairing); return; }
    clearTimeout(pairTimer);
    PairingUI.hide();
    clearTimeout(addonRetryTimer);
    addonDownWarned = false;
    const result = await reloadFromAddon(reg, false);
    showToast(result.count ? I18n.t('settings.savedLoaded', { n: result.count }) : I18n.t('settings.saved'));
}

/** Справка в Настройках: что это за телевизор для Home Assistant. */
/** Версия плеера — из config.xml (её же отдаёт телевизор по сети: :8001/api/v2/applications/<id>). */
function appVersion() {
    try { return tizen.application.getCurrentApplication().appInfo.version || ''; }
    catch (e) { return ''; }
}

function settingsInfo() {
    const version = [I18n.t('info.version'), appVersion() || '—'];
    if (!CONFIG.tv) return [version, [I18n.t('info.addon'), I18n.t('info.addonNotRegistered')]];
    return [
        version,
        [I18n.t('info.tv'), CONFIG.tv.name + (CONFIG.tv.area ? ' · ' + CONFIG.tv.area : '')],
        [I18n.t('info.tvId'), CONFIG.tv.tv_id],
        [I18n.t('info.topics'), 'iptv/' + CONFIG.tv.tv_id + '/…  (set_channel, command, set_playlist, state)'],
        [I18n.t('info.addon'), I18n.t(addonReg && addonReg.fromCache ? 'info.addonCached' : 'info.addonConnected')],
        [I18n.t('info.playlists'), CONFIG.playlists.map(p => p.name).join(', ') || I18n.t('info.none')]
    ];
}

// ───────────────────────── Выбор плейлиста ─────────────────────────

/** Окно выбора плейлиста: RETURN на ленте групп главного экрана и на главной видеопортала. */
function openPlaylistChooser() {
    const list = CONFIG.playlists;
    PlaylistDialogUI.open(
        list.map(p => ({ name: p.name, kind: p.kind === 'vod' ? 'vod' : 'tv', state: p.failed ? 'failed' : p.ready === false ? 'building' : '' })),
        Math.max(0, list.findIndex(p => p.name === viewPlaylist)),
        pickPlaylist
    );
}

/** Список плейлистов поменялся, а окно выбора открыто — показать новый (иначе там старый или пустой список). */
function refreshPlaylistChooser() {
    if (PlaylistDialogUI.isOpen()) openPlaylistChooser();
}

/** index — в CONFIG.playlists. Окно выбора плейлиста и MQTT iptv/<tv_id>/set_playlist. */
async function pickPlaylist(index) {
    const playlist = CONFIG.playlists[index];
    PlaylistDialogUI.close();
    if (!playlist) return;

    if (playlist.kind === 'vod') {
        closeOverlays();
        HomeUI.close();
        Player.stop();
        hidePlayState();
        VodUI.open(playlist);
        setViewPlaylist(playlist.name);
        return;
    }

    VodUI.hide();
    openHome();
    setViewPlaylist(playlist.name);
    if (CONFIG.activeTv && CONFIG.activeTv.name === playlist.name && channels.length) return;

    // другой M3U: главный экран уже открыт, плитки появятся, когда плейлист загрузится
    Prefs.set('activePlaylist', playlist.name);
    CONFIG.activeTv = playlist;
    showToast(I18n.t('playlist.loadingName', { name: playlist.name }), 'ok', 15000);
    try {
        const r = await loadActiveTvPlaylist(false);
        if (!r.count) throw new Error(I18n.t('playlist.empty'));
        currentIndex = 0;
        refreshChannelsUi();
        MqttBridge.playlistChanged();
        showToast(I18n.t(r.hasEpg ? 'playlist.loaded' : 'playlist.loadedNoEpg', { name: playlist.name, n: r.count }), 'ok', 3000);
    } catch (err) {
        showToast(I18n.t('playlist.failed', { name: playlist.name, error: err.message || err }), 'error', 10000);
    }
}

// ───────────────────────── Фильмы и сериалы (видеопортал) ─────────────────────────

/**
 * MQTT iptv/<tv_id>/vod/play (карточка HA, голос через аддон):
 * {id | fid, episode_fid?, from_start?, title?}. id — составной («portal:48357»); fid без источника
 * означает portal, так шлёт старая карточка и старые скрипты Assist.
 * Открывает нужный источник, карточку фильма и сразу запускает — как если бы выбрали с пульта. → {title}
 */
async function playVodFromHa(msg) {
    const id = msg.id != null && msg.id !== '' ? String(msg.id) : msg.fid != null ? String(msg.fid) : '';
    if (!id) throw new Error('bad_fid');
    const src = VodSources.splitId(id).type;
    // плейлист того источника, которому принадлежит id (его же откроем на экране)
    const playlist = CONFIG.playlists.find(p => p.kind === 'vod' && vodSourceType(p) === src);
    if (!playlist) throw new Error('no_portal');
    SuggestUI.hide();   // выбрали голосом («включи второй») — подборку с экрана убираем
    saveVodPosition();
    closeOverlays();
    HomeUI.close();
    PlaylistDialogUI.close();
    Player.stop();
    hidePlayState();
    VodUI.open(playlist);
    setViewPlaylist(playlist.name);
    if (msg.title) showToast(I18n.t('vod.opening', { title: msg.title }), 'ok', 4000);
    try {
        return await VodUI.playId(id, {
            episodeFid: msg.episode_fid, fromStart: !!msg.from_start, stream: msg.stream, quality: msg.quality,
            // position (сек) — продолжить с этого места: просмотр перенесли с другого телевизора
            startMs: msg.position != null && isFinite(msg.position) ? Math.max(0, msg.position * 1000) : undefined
        });
    } catch (err) {
        showToast(I18n.t(msg.title ? 'vod.playFailedTitle' : 'vod.playFailed', { title: msg.title, error: err.message || err }), 'error', 8000);
        throw err;
    }
}

/**
 * MQTT command where: что и с какого места сейчас идёт — аддон продолжает это на другом телевизоре («перенеси в
 * спальню»). → {kind: 'vod', id, episode_fid, position (сек), title} | {kind: 'archive', channel, time (unix-сек)} |
 * {kind: 'live', channel}; ничего не идёт (главный экран, стоп) — ошибка not_playing.
 */
function playbackPoint() {
    const media = Player.isVod() ? Player.getCurrentMedia() : null;
    if (media) {
        const s = media.series;
        return {
            kind: 'vod', id: s ? VodSources.makeId(VodSources.splitId(media.id).type, s.fid) : media.id,
            episode_fid: s ? media.fid : null, position: Math.floor(Player.getPosition() / 1000), title: media.title
        };
    }
    const channel = Player.getCurrentChannel();
    if (!channel || Player.getPlaybackState() === 'stopped') throw new Error('not_playing');
    return Player.isArchive() ? { kind: 'archive', channel: channel.name, time: Math.floor(Player.getArchiveTime()) }
        : { kind: 'live', channel: channel.name };
}

/**
 * Избранное общее на все источники: запись другого источника открываем в нём — переключаем экран фильмов
 * на его плейлист и сразу показываем карточку. RETURN из карточки ведёт на главную уже этого источника.
 */
function openFavoriteFromOtherSource(item) {
    const playlist = CONFIG.playlists.find(p => p.kind === 'vod' && vodSourceType(p) === item.src);
    if (!playlist) return showToast(I18n.t('vod.sourceMissing', { title: item.title }), 'error', 6000);
    VodUI.open(playlist);
    setViewPlaylist(playlist.name);
    VodUI.openItem(item);
}

let seekTarget = null;    // куда ведут бегунок на линии времени (мс), null — не перематываем
let seekTimer = null;
const scrub = { dir: 0, streak: 0, lastTs: 0 };
const SCRUB_COMMIT_MS = 1500;   // бегунок отпустили — через столько перейти самим
const VOD_END_SLACK_MS = 2 * 60 * 1000;   // «конец фильма» дальше этого от длительности — обрыв, а не конец
const VOD_REOPEN_MAX = 3;

/** VodUI onPlay: media — см. VodUI.mediaFrom, startMs — с какого места. */
function startVod(media, startMs) {
    closeOverlays();
    HomeUI.close();
    PlaylistDialogUI.close();
    VodUI.hide();
    hidePlayState();
    document.getElementById('key-hints').classList.add('hidden');
    cancelScrub();
    Player.playVod(media, startMs || 0);
    showTimelineOsd(6000);
}

/** Открыт полноэкранный «меню»-экран, где воспроизведение остановлено. */
function menuOpen() {
    return HomeUI.isOpen() || VodUI.isOpen() || PlaylistDialogUI.isOpen();
}

/** Смотрим фильм и поверх нет меню — кнопки управляют фильмом. */
function isWatchingVod() {
    return Player.isVod() && !VodUI.isOpen() && !HomeUI.isOpen() && !PlaylistDialogUI.isOpen();
}

function saveVodPosition() {
    const media = Player.getCurrentMedia();
    if (!Player.isVod() || !media) return;
    const pos = Player.getPosition();
    const dur = Player.getDuration();
    if (pos > 0) VodHistory.setPosition(media.id, pos, dur);
}

/** RETURN при просмотре фильма — обратно на карточку, позиция запоминается. */
function leaveVodPlayback() {
    saveVodPosition();
    cancelScrub();
    Player.stop();
    hidePlayState();
    closeOverlays();
    document.getElementById('vod-osd').classList.add('hidden');
    VodUI.show();
}

/** Соседняя серия: step +1 / −1 (CH+/CH−, панель плеера, конец серии). */
function vodEpisodeStep(step) {
    const media = Player.getCurrentMedia();
    if (!Player.isVod() || !media || !media.series) return false;
    const idx = media.episodeIdx + step;
    if (idx < 0 || idx >= media.series.episodes.length) return false;
    saveVodPosition();
    VodUI.prepareEpisode(media.series, idx, media.quality)
        .then(next => startVod(next, VodHistory.getResume(next.id)))
        .catch(err => showToast(I18n.t('vod.episodeFailed', { error: err.message || err }), 'error', 6000));
    return true;
}

// ───────────────────────── Архив каналов ─────────────────────────

const ARCHIVE_GUIDE_TTL_MS = 10 * 60 * 1000;
const archiveGuides = new Map();   // key канала -> { at, list } — программа с прошлыми днями из аддона

/** Программа канала: из кеша архивной (если загружали), иначе окно из плейлиста. */
function guideFor(channel) {
    const g = archiveGuides.get(channel.key);
    return g ? g.list : ChannelStore.getProgrammesFor(channel);
}

/**
 * ChannelEpgUI loadGuide: передачи за дни архива из аддона + окно плейлиста (там же будущие), без дублей.
 * Кешируется на ARCHIVE_GUIDE_TTL_MS — программу открывают и закрывают по нескольку раз.
 */
function archiveGuide(channel) {
    const cached = archiveGuides.get(channel.key);
    if (cached && Date.now() - cached.at < ARCHIVE_GUIDE_TTL_MS) return Promise.resolve(cached.list);
    return AddonClient.loadArchiveGuide(CONFIG.addonUrl, CONFIG.activeTv, channel.name).then(past => {
        const byStart = new Map();
        past.concat(ChannelStore.getProgrammesFor(channel)).forEach(p => byStart.set(p.start.getTime(), p));
        const list = Array.from(byStart.values()).sort((x, y) => x.start - y.start);
        archiveGuides.set(channel.key, { at: Date.now(), list });
        return list;
    });
}

/** Передача канала в момент ms; нет в программе — часовой отрезок без названия (линии времени нужны границы). */
function programmeAt(channel, ms) {
    const p = guideFor(channel).find(x => x.start.getTime() <= ms && ms < x.stop.getTime());
    if (p) return p;
    const start = Math.floor(ms / 3600000) * 3600000;
    return { start: new Date(start), stop: new Date(start + 3600000), title: '' };
}

const pad2 = n => (n < 10 ? '0' : '') + n;

/** «14:05» / «14:05:30»; не сегодня — с днём недели: «пн 14:05». */
function clockLabel(ms, withSeconds) {
    const d = AppClock.local(ms);
    const hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + (withSeconds ? ':' + pad2(d.getSeconds()) : '');
    return d.toDateString() === AppClock.local(Date.now()).toDateString() ? hm : I18n.t('common.weekdays').split(',')[d.getDay()] + ' ' + hm;
}

/** Из программы канала (OK на прошедшей передаче с меткой «архив») — запись с начала передачи. */
function startArchive(channel, programme) {
    startArchiveAt(channel, programme.start.getTime());
}

/** Запись канала с момента ms — откуда бы ни включили (программа канала, «С начала», карточка HA, голос). */
function startArchiveAt(channel, ms) {
    saveVodPosition();
    closeOverlays();
    HomeUI.close();
    VodUI.hide();
    PlaylistDialogUI.close();
    hidePlayState();
    cancelScrub();
    document.getElementById('key-hints').classList.add('hidden');
    Player.playArchive(channel, ms / 1000);
    document.getElementById('channel-osd').classList.add('hidden');
    setViewPlaylist(CONFIG.activeTv ? CONFIG.activeTv.name : null);
    showTimelineOsd(6000);
}

/**
 * «С начала»: передача, которая идёт на канале (в архиве — та, на которой стоим), с её начала; фильм — с нуля.
 * Нельзя — исключение с кодом: no_channel, no_archive (у канала нет архива), no_programme (нет программы —
 * неизвестно, где начало). → с какого момента включили (unix-сек)
 */
function watchFromStart() {
    if (isWatchingVod()) {
        cancelScrub();
        Player.seekTo(0);
        showTimelineOsd(4000);
        return 0;
    }
    const channel = Player.getCurrentChannel();
    if (!channel) throw new Error('no_channel');
    if (!(ChannelStore.archiveDays(channel) > 0)) throw new Error('no_archive');
    const atMs = Player.isArchive() ? Player.getArchiveTime() * 1000 : AppClock.now().getTime();
    const p = programmeAt(channel, atMs);
    if (!p.title) throw new Error('no_programme');
    startArchive(channel, p);
    return Math.floor(p.start.getTime() / 1000);
}

/** Кнопка «С начала» в панели плеера: то же, с сообщением на экране, если нельзя. */
function watchFromStartButton() {
    PlayerBarUI.close();
    try { watchFromStart(); } catch (e) {
        showToast(I18n.t(e.message === 'no_programme' ? 'archive.noProgramme' : 'archive.none'), 'error', 4000);
    }
}

/**
 * Команда archive из Home Assistant (карточка): {channel, start (unix-сек) | нет — текущая передача с начала, key}.
 * Канал под родительским контролем — только с ключом аддона (PIN ввели в карточке), как и set_channel.
 * → с какого момента включили (unix-сек)
 */
function playArchiveFromHa(v) {
    const name = v && v.channel ? String(v.channel) : '';
    const channel = name ? channels.find(c => c.name === name) || ChannelStore.findByName(name).channel : Player.getCurrentChannel();
    if (!channel) throw new Error('not_found');
    if (Parental.isProtected(channel) && !Parental.keyMatches(v && v.key)) throw new Error('locked');
    if (!(ChannelStore.archiveDays(channel) > 0)) throw new Error('no_archive');
    const nowMs = AppClock.now().getTime();
    let ms = v && Number(v.start) > 0 ? Number(v.start) * 1000 : null;
    if (ms === null) {
        const p = programmeAt(channel, nowMs);
        if (!p.title) throw new Error('no_programme');
        ms = p.start.getTime();
    }
    // позже «минуту назад» — это уже эфир
    if (ms >= nowMs - 60000) {
        playFromOverlay(channel);
        return Math.floor(nowMs / 1000);
    }
    ms = Math.max(ms, nowMs - ChannelStore.archiveDays(channel) * 86400000 + 60000);
    startArchiveAt(channel, ms);
    return Math.floor(ms / 1000);
}

// ───────────────────────── Таймер сна ─────────────────────────

/** Значение таймера сна для кнопки в настройках панели: «выкл» / «30 мин» (по кругу 15…120 минут). */
function sleepLabel() {
    return SleepTimer.isActive() ? I18n.t('bar.sleepOn', { n: SleepTimer.remainingMin() }) : I18n.t('bar.sleepOff');
}

function sleepToast(minutes) {
    showToast(minutes > 0 ? I18n.t('sleep.set', { n: minutes }) : I18n.t('sleep.off'), 'ok', 3000);
}


/** Отсчёт последней минуты (seconds) или убрать его (null). */
function showSleepCountdown(seconds) {
    const el = document.getElementById('sleep-countdown');
    el.classList.toggle('hidden', seconds === null);
    if (seconds !== null) el.innerHTML = I18n.t('sleep.countdown', { s: seconds });
}

/** Время вышло: тишина и просьба аддону выключить телевизор (сам плеер этого не может). */
function sleepNow() {
    saveVodPosition();
    cancelScrub();
    closeOverlays();
    if (!menuOpen()) { Player.stop(); showPlayState(); }
    if (!MqttBridge.requestPowerOff()) showToast(I18n.t('sleep.noAddon'), 'error', 10000);
}

// ───────────────────────── Сообщения из Home Assistant ─────────────────────────

let notice = null;    // {channel | null, options | null, focus, request, timer} — плашка на экране

/**
 * MQTT iptv/<tv_id>/notify: {text, channel?, seconds?} — плашка вверху экрана (напоминание о передаче от аддона,
 * любое сообщение из автоматизации HA). С channel — OK на пульте включает этот канал.
 * С options: [{n, label}] и request — это вопрос («какой фильм добавить в избранное?»): ▲▼ или цифра — выбор,
 * OK — ответ аддону: request + {choice: n} (на вопрос можно ответить и голосом — тогда плашку сменит аддон).
 */
function showNotice(msg) {
    if (!msg || !msg.text) return;
    const channel = msg.channel ? channels.find(c => c.name === msg.channel) || ChannelStore.findByName(String(msg.channel)).channel : null;
    const usable = channel && !Parental.isProtected(channel) ? channel : null;
    const options = Array.isArray(msg.options) && msg.options.length && msg.request ? msg.options : null;
    document.getElementById('notice-text').textContent = String(msg.text);
    document.getElementById('notice-hint').innerHTML = I18n.t(options ? 'notice.hintPick' : usable ? 'notice.hintChannel' : 'notice.hint');
    document.getElementById('notice').classList.remove('hidden');
    clearTimeout(notice && notice.timer);
    const seconds = Math.max(5, Math.min(300, Number(msg.seconds) || 30));
    notice = { channel: usable, options, focus: 0, request: msg.request || null, timer: setTimeout(hideNotice, seconds * 1000) };
    renderNoticeOptions();
}

function renderNoticeOptions() {
    const box = document.getElementById('notice-options');
    box.innerHTML = '';
    const options = notice && notice.options;
    box.classList.toggle('hidden', !options);
    (options || []).forEach((o, i) => {
        const row = document.createElement('div');
        row.className = 'notice-option' + (i === notice.focus ? ' focused' : '');
        row.textContent = o.n + '. ' + o.label;
        box.appendChild(row);
    });
}

/** ▲▼ в плашке-вопросе. */
function moveNoticeFocus(step) {
    const n = notice.options.length;
    notice.focus = (notice.focus + step + n) % n;
    renderNoticeOptions();
}

/** Ответ на вопрос плашки: вариант idx уходит аддону, он же сменит плашку на «добавил …». */
function pickNoticeOption(idx) {
    const o = notice && notice.options && notice.options[idx];
    if (!o) return;
    const sent = MqttBridge.request(Object.assign({}, notice.request, { choice: o.n }));
    if (!sent) { hideNotice(); return showToast(I18n.t('notice.noLink'), 'error', 5000); }
    // ответа ждём недолго: аддон молчит — плашка не должна висеть минуту
    notice.focus = idx;
    notice.options = [o];
    notice.request = null;
    renderNoticeOptions();
    clearTimeout(notice.timer);
    notice.timer = setTimeout(hideNotice, 8000);
}

function hideNotice() {
    clearTimeout(notice && notice.timer);
    notice = null;
    renderNoticeOptions();
    document.getElementById('notice').classList.add('hidden');
}

/** OK на плашке с каналом — включить его в эфире (уже идёт — просто убрать плашку). */
function activateNotice() {
    const channel = notice && notice.channel;
    hideNotice();
    if (!channel) return;
    const cur = Player.getCurrentChannel();
    if (cur && cur.key === channel.key && !Player.isVod() && !Player.isArchive() && !menuOpen()) return;
    saveVodPosition();
    VodUI.hide();
    PlaylistDialogUI.close();
    playFromOverlay(channel);
}

/**
 * Перейти в архиве на момент ms. Ближе минуты к «сейчас» — это уже эфир: включаем канал вживую.
 * Раньше глубины архива — на самое раннее, что есть.
 */
function seekArchive(channel, ms) {
    const nowMs = AppClock.now().getTime();
    if (ms >= nowMs - 60000) {
        goLive();
        return;
    }
    const earliest = nowMs - ChannelStore.archiveDays(channel) * 86400000 + 60000;
    Player.playArchive(channel, Math.max(ms, earliest) / 1000);
}

/** Из архива — в прямой эфир того же канала. */
function goLive() {
    const channel = Player.getCurrentChannel();
    cancelScrub();
    hideTimelineOsd();
    PlayerBarUI.close();
    if (!channel) return;
    Player.playChannel(channel);
    showToast(I18n.t('player.live'), 'ok', 2500);
}

/** Смотрим архив и поверх нет меню — ◄ список каналов, ► перемотка, OK — панель, RETURN — главный экран (как в эфире). */
function isWatchingArchive() {
    return Player.isArchive() && !VodUI.isOpen() && !HomeUI.isOpen() && !PlaylistDialogUI.isOpen();
}

/** Фильм или архив: кнопки работают с линией времени. */
function isWatchingTimeline() {
    return isWatchingVod() || isWatchingArchive();
}

/**
 * Линия времени того, что играет: фильм (позиции от 0) или архив (абсолютное время, мс; линия — передача,
 * на которой стоит бегунок). null — идёт эфир.
 *   pos — где сейчас; start/dur — границы линии; min/max — куда можно перемотать; maxStep — предел шага;
 *   title, timeText, hint — для плашки; label(ms) — время над бегунком; seek(ms) — перейти.
 */
function timeline() {
    const media = Player.getCurrentMedia();
    if (!media) return null;
    if (Player.isVod()) {
        const dur = Player.getDuration();
        const pos = Player.getPosition();
        return {
            pos, start: 0, dur,
            min: 0, max: dur > 0 ? Math.max(0, dur - 5000) : Infinity, maxStep: dur > 0 ? dur / 20 : Infinity,
            title: media.title,
            timeText: VodUI.formatTime(pos) + (dur > 0 ? ' / ' + VodUI.formatTime(dur) : ''),
            hint: I18n.t('timeline.hintVod'),
            label: ms => VodUI.formatTime(ms),
            seek: ms => Player.seekTo(ms)
        };
    }
    if (Player.isArchive()) {
        const channel = media.channel;
        const pos = Player.getArchiveTime() * 1000;
        const p = programmeAt(channel, seekTarget !== null ? seekTarget : pos);
        const nowMs = AppClock.now().getTime();
        const start = p.start.getTime();
        return {
            pos, start, dur: p.stop.getTime() - start,
            min: nowMs - ChannelStore.archiveDays(channel) * 86400000 + 60000, max: nowMs, maxStep: Infinity,
            title: channel.name + ' · ' + clockLabel(start) + '–' + clockLabel(p.stop.getTime()).replace(/^\S+ /, '') +
                (p.title ? '  ' + p.title : ''),
            timeText: I18n.t('timeline.archive', { time: clockLabel(pos, true) }),
            hint: I18n.t('timeline.hintArchive'),
            label: ms => clockLabel(ms, true),
            seek: ms => seekArchive(channel, ms)
        };
    }
    return null;
}

/**
 * Перемотка как в YouTube (фильмы и архив): ◄► двигают бегунок по линии времени, картинка пока играет
 * с прежнего места. Пока кнопку держат (автоповтор) или жмут подряд, шаг растёт: 10 с → 30 с → 1 мин →
 * 2 мин → 5 мин, но у фильма не больше 1/20 длины. Переход — OK или сам, через SCRUB_COMMIT_MS после
 * последнего нажатия; RETURN — отмена. В архиве переход — новое открытие потока (Player.playArchive).
 */
function scrubStep(dir) {
    const m = timeline() || liveTimeline();
    if (!m) return;
    const now = Date.now();
    if (dir === scrub.dir && now - scrub.lastTs < 450) scrub.streak++;
    else scrub.streak = 0;
    scrub.dir = dir;
    scrub.lastTs = now;
    const n = scrub.streak;
    let step = n < 4 ? 10000 : n < 10 ? 30000 : n < 18 ? 60000 : n < 28 ? 120000 : 300000;
    step = Math.max(10000, Math.min(step, m.maxStep));

    const base = seekTarget !== null ? seekTarget : m.pos;
    seekTarget = Math.max(m.min, Math.min(m.max, base + dir * step));
    clearTimeout(seekTimer);
    seekTimer = setTimeout(commitScrub, SCRUB_COMMIT_MS);
    if (!PlayerBarUI.isOpen()) showTimelineOsd(SCRUB_COMMIT_MS + 2500);
}

/** Перейти туда, где стоит бегунок. */
function commitScrub() {
    clearTimeout(seekTimer);
    const m = timeline() || liveTimeline();
    const target = seekTarget;
    seekTarget = null;
    scrub.streak = 0;
    if (target !== null && m) m.seek(target);
}

/** RETURN во время перемотки — бегунок возвращается на место, никуда не переходим. */
function cancelScrub() {
    clearTimeout(seekTimer);
    seekTarget = null;
    scrub.streak = 0;
}

/** Доля линии времени (0..1) для момента ms. */
function timelineFrac(m, ms) {
    return m.dur > 0 ? Math.max(0, Math.min(1, (ms - m.start) / m.dur)) : 0;
}

/** Плашка внизу (фильм или архив): название, время и полоса. Пока видна — обновляется. */
function showTimelineOsd(ms) {
    if (!timeline()) return;
    const el = document.getElementById('vod-osd');
    const update = () => {
        const m = timeline();
        if (!m) { hideTimelineOsd(); return; }
        const scrubbing = seekTarget !== null;
        const at = scrubbing ? seekTarget : m.pos;
        const frac = x => timelineFrac(m, x) * 100;
        document.getElementById('vod-osd-title').textContent = m.title;
        document.getElementById('vod-osd-time').textContent = m.timeText;
        document.getElementById('vod-osd-hint').innerHTML = m.hint;
        document.getElementById('vod-osd-fill').style.width = frac(m.pos) + '%';
        document.getElementById('vod-osd-thumb').style.left = frac(at) + '%';
        const span = document.getElementById('vod-osd-span');
        span.classList.toggle('hidden', !scrubbing);
        span.style.left = Math.min(frac(at), frac(m.pos)) + '%';
        span.style.width = Math.abs(frac(at) - frac(m.pos)) + '%';
        const bubble = document.getElementById('vod-osd-bubble');
        bubble.classList.toggle('hidden', !scrubbing);
        bubble.style.left = Math.max(3, Math.min(97, frac(at))) + '%';
        bubble.textContent = m.label(at);
    };
    update();
    el.classList.remove('hidden');
    clearInterval(showTimelineOsd._i);
    clearTimeout(showTimelineOsd._t);
    showTimelineOsd._i = setInterval(update, 500);
    showTimelineOsd._t = setTimeout(() => { el.classList.add('hidden'); clearInterval(showTimelineOsd._i); }, ms);
}

function hideTimelineOsd() {
    clearInterval(showTimelineOsd._i);
    clearTimeout(showTimelineOsd._t);
    document.getElementById('vod-osd').classList.add('hidden');
}

/** Качество фильма по кругу (варианты из деталей портала), с того же места. */
function nextVodQuality() {
    const media = Player.getCurrentMedia();
    const qs = VodUI.qualitiesOf(media && media.variants);
    if (qs.length < 2) return;
    const q = qs[(qs.indexOf(media.quality) + 1) % qs.length];
    const pos = Player.getPosition();
    media.quality = q;
    media.url = media.variants[q];
    VodHistory.setQuality(q);
    Player.playVod(media, pos);
}

// ───────────────────────── Панель плеера (▼ / OK) ─────────────────────────
// Один и тот же порядок везде: [с начала] [назад] [пауза/пуск] [вперёд] … [аудио] [настройки].
// «Назад/вперёд» — то, что листается в этом режиме: каналы в эфире, передачи в архиве, серии у сериала.
// Кнопки — значки, подсказка всплывает над выбранной (js/player-bar-ui.js).

let barReopen = null;   // открыто подменю «Настройки» панели: как вернуться к её кнопкам

const scaleModeLabel = () => I18n.t('bar.scale', { mode: I18n.t(Player.getScaleMode() === 'auto' ? 'bar.scaleAuto' : 'bar.scaleOff') });
function toggleScaleMode() {
    const mode = Player.getScaleMode() === 'auto' ? 'off' : 'auto';
    Player.setScaleMode(mode);
    Prefs.set('scaleMode', mode);
}

/** Пауза / пуск — одна кнопка, значок по тому, что она сейчас сделает. */
const playPauseButton = {
    main: true,
    icon: () => (Player.getState() === 'PLAYING' ? 'pause' : 'play'),
    label: () => {
        const st = Player.getState();
        return st === 'PLAYING' ? I18n.t('state.paused') : I18n.t(st === 'PAUSED' ? 'bar.resume' : 'bar.play');
    },
    action: togglePlayPause
};

/** Аудиодорожка: на кнопке — язык и номер, если дорожек несколько. */
const audioButton = {
    icon: 'audio',
    text: () => {
        const tracks = Player.getAudioTracks();
        const cur = Math.max(0, tracks.findIndex(t => t.index === Player.getCurrentAudioIndex()));
        const lang = tracks[cur] && tracks[cur].language ? tracks[cur].language : '';
        return tracks.length > 1 ? (lang ? lang + ' ' : '') + (cur + 1) + '/' + tracks.length : lang;
    },
    label: audioLabel,
    action: nextAudioTrack
};

/**
 * Кнопка «Настройки» панели: подменю — таймер сна, масштаб и (в эфире) перестановка и логотип канала.
 * reopen — открыть панель снова с её обычными кнопками (RETURN и «Назад» из подменю).
 */
function barSettingsButton(info, reopen, withChannelTools) {
    return {
        icon: 'settings',
        label: I18n.t('bar.settings'),
        action: () => {
            const items = [
                { icon: 'back', wide: true, label: I18n.t('bar.back'), action: reopen },
                { icon: 'sleep', wide: true, label: () => I18n.t('bar.sleep', { value: sleepLabel() }), action: () => { SleepTimer.next(); } },
                { icon: 'scale', wide: true, label: scaleModeLabel, action: toggleScaleMode }
            ];
            if (withChannelTools) {
                items.push({ icon: 'move', wide: true, label: I18n.t('bar.moveChannel'), action: () => openListInMode('reorder') });
                items.push({ icon: 'logo', wide: true, label: I18n.t('bar.channelLogo'), action: () => openListInMode('logo') });
            }
            barReopen = reopen;
            PlayerBarUI.open(info, items, { focus: 1 });
        }
    };
}

/** Открыть панель с обычными кнопками; фокус — на «пауза/пуск» (или там, где были, после подменю). */
function openBar(info, buttons, opts, keepFocus) {
    document.getElementById('channel-osd').classList.add('hidden');   // плашка канала просвечивала бы под кнопками
    const wasSub = barReopen !== null;
    barReopen = null;
    const main = buttons.indexOf(playPauseButton);
    const settings = buttons.length - 1;
    PlayerBarUI.open(info, buttons, Object.assign({ focus: wasSub && keepFocus !== false ? settings : main }, opts || {}));
}

/** RETURN при открытой панели: из подменю — к кнопкам, иначе закрыть. */
function barBack() {
    cancelScrub();
    if (barReopen) barReopen();
    else PlayerBarUI.close();
}

/** Панель плеера (▼ / OK) при просмотре фильма. */
function openVodPlayerBar() {
    const media = Player.getCurrentMedia();
    if (!media) return;
    hideTimelineOsd();
    barReopen = null;
    const info = () => {
        const dur = Player.getDuration();
        const pos = Player.getPosition();
        return {
            name: media.title,
            programme: VodUI.formatTime(pos) + (dur > 0 ? ' / ' + VodUI.formatTime(dur) : ''),
            progress: dur > 0 ? Math.min(1, pos / dur) : null,
            scrub: seekTarget !== null && dur > 0 ? Math.min(1, seekTarget / dur) : null,
            timeLabel: VodUI.formatTime(seekTarget !== null ? seekTarget : pos)
        };
    };
    const buttons = [{ icon: 'restart', label: I18n.t('bar.fromStart'), action: () => { watchFromStart(); } }];
    if (media.series) buttons.push({ icon: 'prev', label: I18n.t('bar.prevEpisode'), action: () => vodEpisodeStep(-1) });
    buttons.push(playPauseButton);
    if (media.series) buttons.push({ icon: 'next', label: I18n.t('bar.nextEpisode'), action: () => vodEpisodeStep(1) });
    buttons.push(audioButton);
    if (VodUI.qualitiesOf(media.variants).length > 1) {
        buttons.push({
            icon: 'quality', text: () => VodUI.qualityLabel(media.quality),
            label: () => I18n.t('bar.quality', { q: VodUI.qualityLabel(media.quality) }), action: nextVodQuality
        });
    }
    buttons.push({ icon: 'details', label: I18n.t('bar.toDetails'), action: leaveVodPlayback });
    const timelineOpts = { timeline: true, onScrub: scrubStep, onScrubCommit: commitScrub };
    const reopen = () => openBar(info, buttons, Object.assign({ startZone: 'buttons' }, timelineOpts));
    buttons.push(barSettingsButton(info, reopen, false));
    // фокус сразу на линии времени: ◄► — бегунок, OK — перейти, ▼ — кнопки
    openBar(info, buttons, timelineOpts);
}

/** Соседняя передача в архиве: step −1 — к началу текущей (если от него ушли дальше 30 с), иначе к предыдущей. */
function archiveProgrammeStep(step) {
    const media = Player.getCurrentMedia();
    if (!Player.isArchive() || !media) return;
    const pos = Player.getArchiveTime() * 1000;
    const cur = programmeAt(media.channel, pos);
    let target;
    if (step > 0) target = cur.stop.getTime();
    else if (pos - cur.start.getTime() > 30000) target = cur.start.getTime();
    else target = programmeAt(media.channel, cur.start.getTime() - 1000).start.getTime();
    cancelScrub();
    seekArchive(media.channel, target);
    showTimelineOsd(4000);
}

/** Программа канала поверх архива — выбрать другую передачу (архив играет, пока не выбрали). */
function openArchiveGuide() {
    const media = Player.getCurrentMedia();
    if (!Player.isArchive() || !media) return;
    PlayerBarUI.close();
    hideTimelineOsd();
    ChannelListUI.open();
    ChannelEpgUI.open(media.channel, { focusTime: new Date(Player.getArchiveTime() * 1000) });
    ChannelListUI.setActive(false);
}

/** Панель плеера (▼ / OK) при просмотре архива. */
function openArchivePlayerBar() {
    if (!Player.isArchive()) return;
    hideTimelineOsd();
    document.getElementById('key-hints').classList.add('hidden');
    barReopen = null;
    const info = () => {
        const m = timeline();
        if (!m) return null;
        return {
            name: m.title,
            programme: m.timeText,
            progress: timelineFrac(m, m.pos),
            scrub: seekTarget !== null ? timelineFrac(m, seekTarget) : null,
            timeLabel: m.label(seekTarget !== null ? seekTarget : m.pos)
        };
    };
    const buttons = [
        { icon: 'restart', label: I18n.t('bar.fromStart'), action: watchFromStartButton },
        { icon: 'prev', label: I18n.t('bar.prevProgramme'), action: () => archiveProgrammeStep(-1) },
        playPauseButton,
        { icon: 'next', label: I18n.t('bar.nextProgramme'), action: () => archiveProgrammeStep(1) },
        { icon: 'live', label: I18n.t('player.live'), action: goLive },
        { icon: 'guide', label: I18n.t('bar.guide'), action: openArchiveGuide },
        audioButton
    ];
    const timelineOpts = { timeline: true, onScrub: scrubStep, onScrubCommit: commitScrub };
    const reopen = () => openBar(info, buttons, Object.assign({ startZone: 'buttons' }, timelineOpts));
    buttons.push(barSettingsButton(info, reopen, false));
    openBar(info, buttons, timelineOpts);
}

/**
 * ▲ при просмотре — описание (InfoPanelUI): фильм — из карточки портала; канал и архив — передача в этот момент,
 * описание, жанр и возраст догружаются из аддона (/playlists/<id>/programme.json; в JSON плейлиста их нет).
 */
function openInfoPanel() {
    const media = Player.getCurrentMedia();
    const channel = Player.getCurrentChannel();
    hideTimelineOsd();
    document.getElementById('key-hints').classList.add('hidden');
    document.getElementById('channel-osd').classList.add('hidden');

    if (Player.isVod() && media) {
        const meta = [
            media.rating ? '★ ' + media.rating.toFixed(1) + (media.ratingSrc ? ' ' + media.ratingSrc : '') : '',
            media.year ? String(media.year) : '',
            media.duration ? I18n.t('common.minutes', { n: media.duration }) : '',
            (media.genres || []).slice(0, 2).join(', '),
            media.agelimit ? media.agelimit + '+' : ''
        ];
        InfoPanelUI.open(() => {
            const m = timeline();
            return {
                logo: media.poster, channel: I18n.t(media.series ? 'vod.series' : 'vod.movie'), title: media.title,
                time: m ? m.timeText : '', progress: m && m.dur > 0 ? timelineFrac(m, m.pos) : null,
                meta, desc: media.description || null, next: ''
            };
        });
        return;
    }
    if (!channel) return;

    const archive = Player.isArchive();
    const atMs = archive ? Player.getArchiveTime() * 1000 : AppClock.now().getTime();
    const local = archive ? programmeAt(channel, atMs) : ChannelStore.getCurrentProgrammeFor(channel);
    const info = { loaded: false, programme: null, next: null };
    const number = channelNumber(channel);

    AddonClient.loadProgrammeInfo(CONFIG.addonUrl, CONFIG.activeTv, channel.name, atMs / 1000)
        .then(r => { info.programme = r && r.programme; info.next = r && r.next; })
        .catch(err => console.warn('[info] описание не загрузилось', err))
        .then(() => { info.loaded = true; InfoPanelUI.refresh(); });

    InfoPanelUI.open(() => {
        // панель про то, что открывали: сменили канал или вышли из архива — закрыть
        const cur = Player.getCurrentChannel();
        if (!cur || cur.key !== channel.key || Player.isArchive() !== archive) return null;
        const p = info.programme;
        const start = p ? p.start * 1000 : (local && local.title ? local.start.getTime() : null);
        const stop = p ? p.stop * 1000 : (local && local.title ? local.stop.getTime() : null);
        const pos = archive ? Player.getArchiveTime() * 1000 : AppClock.now().getTime();
        const n = info.next || nextLocalProgramme(channel, stop);
        return {
            logo: channel.logo,
            channel: (number ? number + '. ' : '') + channel.name + (archive ? ' · ' + I18n.t('info.archive') : ''),
            title: p ? p.title : (local && local.title) || '',
            time: start !== null ? clockLabel(start) + ' – ' + clockLabel(stop).replace(/^\S+ /, '') +
                (archive ? '  ·  ' + I18n.t('info.watchingAt', { time: clockLabel(pos, true) }) : '') : '',
            progress: start !== null && stop > start ? (pos - start) / (stop - start) : null,
            meta: p ? [p.category, p.rating] : [],
            desc: info.loaded ? (p && p.desc) || null : undefined,
            next: n ? clockLabel(typeof n.start === 'number' ? n.start * 1000 : n.start.getTime()) + '  ' + n.title : ''
        };
    });
}

/** Следующая передача канала после stopMs из программы плейлиста (если аддон не ответил). */
function nextLocalProgramme(channel, stopMs) {
    if (!stopMs) return null;
    return ChannelStore.getProgrammesFor(channel).find(p => p.start.getTime() >= stopMs) || null;
}

/** Номер канала в общей сортировке (как в списке), 0 — не нашёлся. */
function channelNumber(channel) {
    return ChannelStore.getAll().findIndex(c => c.key === channel.key) + 1;
}

/** Панель плеера для того, что с линией времени: фильм или архив. */
function openTimelinePlayerBar() {
    if (Player.isVod()) openVodPlayerBar();
    else openArchivePlayerBar();
}

function closeOverlays() {
    PlayerBarUI.close();
    InfoPanelUI.close();
    SideMenuUI.close();
    ChannelEpgUI.close();
    ChannelListUI.setActive(true);
    ChannelListUI.close();
}

function playFromOverlay(channel) {
    closeOverlays();
    HomeUI.close();
    Player.playChannel(channel);
}

/** Список групп (◄ из бокового списка): выбор группы показывает её каналы в списке. */
function openGroupsPanel() {
    const groups = ChannelListUI.getGroups();
    const items = groups.map(g => ({
        label: ChannelStore.groupLabel(g),
        lock: Parental.isProtectedGroup(g) ? (Parental.isGroupLocked(g) ? 'locked' : 'open') : undefined,
        action: () => {
            ChannelListUI.setActive(true);
            // группа под замком — сначала PIN
            if (Parental.isGroupLocked(g)) askPin(() => ChannelListUI.showGroup(g));
            else ChannelListUI.showGroup(g);
        }
    }));
    SideMenuUI.open(I18n.t('groups.title'), items, Math.max(0, groups.indexOf(ChannelListUI.getCurrentGroup())));
    ChannelListUI.setActive(false);
}

function closeGroupsPanel() {
    SideMenuUI.close();
    ChannelListUI.setActive(true);
}

/** ► из списка: в программу выбранного канала (уже открыта рядом — только переводим туда кнопки). */
function openChannelEpg() {
    const channel = ChannelListUI.getFocusedChannel();
    if (!channel) return;
    const shown = ChannelEpgUI.getChannel();
    if (shown && shown.key === channel.key) ChannelEpgUI.setActive(true);
    else ChannelEpgUI.open(channel, { focusTime: epgFocusTime(channel) });
    ChannelListUI.setActive(false);
}

/** ◄ из программы: кнопки — списку каналов, программа остаётся открытой и следует за выбранным каналом. */
function focusChannelList() {
    ChannelEpgUI.setActive(false);
    ChannelListUI.setActive(true);
}

/** ▲▼ в списке каналов; открытая рядом программа показывает выбранный канал. */
function moveListFocus(delta) {
    ChannelListUI.moveFocus(delta);
    if (!ChannelEpgUI.isOpen() || ChannelListUI.isReordering()) return;
    const channel = ChannelListUI.getFocusedChannel();
    const shown = ChannelEpgUI.getChannel();
    if (channel && (!shown || shown.key !== channel.key)) ChannelEpgUI.open(channel, { active: false, guideDelayMs: 400, focusTime: epgFocusTime(channel) });
}

/** На какой передаче открыть программу: у канала, который смотрят из архива, — на смотрящейся. */
function epgFocusTime(channel) {
    const cur = Player.getCurrentChannel();
    return Player.isArchive() && cur && cur.key === channel.key ? new Date(Player.getArchiveTime() * 1000) : undefined;
}

function closeChannelEpg() {
    ChannelEpgUI.close();
    ChannelListUI.setActive(true);
}

/** Главный экран: воспроизведение останавливается, выбор плитки запускает выбранный канал. */
function openHome() {
    closeOverlays();
    Player.stop();
    hidePlayState();   // остановка тут — не действие пользователя, «Стоп» по центру не нужен
    HomeUI.setChannels(channels);
    HomeUI.open(Player.getCurrentChannel());
}

/** Открыть боковой список на текущем канале — в режиме перестановки или правки логотипа. */
function openListInMode(mode) {
    PlayerBarUI.close();
    ChannelListUI.open();
    if (mode === 'reorder') ChannelListUI.enterReorderMode();
    else ChannelListUI.enterLogoEdit();
}

function audioLabel() {
    const tracks = Player.getAudioTracks();
    if (tracks.length < 2) return I18n.t('bar.audio', { track: tracks[0] && tracks[0].language ? tracks[0].language : I18n.t('bar.audioSingle') });
    const cur = tracks.findIndex(t => t.index === Player.getCurrentAudioIndex());
    const t = tracks[cur >= 0 ? cur : 0];
    return I18n.t('bar.audio', { track: (t.language || I18n.t('bar.audioTrack')) + ' (' + ((cur >= 0 ? cur : 0) + 1) + '/' + tracks.length + ')' });
}

function nextAudioTrack() {
    const tracks = Player.getAudioTracks();
    if (tracks.length < 2) return;
    const cur = tracks.findIndex(t => t.index === Player.getCurrentAudioIndex());
    Player.setAudioTrack(tracks[(cur + 1) % tracks.length].index);
}

/**
 * Линия времени эфира — только у канала с архивом: «сейчас» — правый край, назад можно на глубину архива.
 * Перемотка назад уводит в архив (с того места, куда поставили бегунок); ближе минуты к «сейчас» — остаёмся в эфире.
 */
function liveTimeline() {
    if (Player.isVod() || Player.isArchive() || menuOpen()) return null;
    const channel = Player.getCurrentChannel();
    const days = channel ? ChannelStore.archiveDays(channel) : 0;
    if (!(days > 0)) return null;
    const nowMs = AppClock.now().getTime();
    const p = programmeAt(channel, seekTarget !== null ? seekTarget : nowMs);
    const start = p.start.getTime();
    return {
        pos: nowMs, start, dur: p.stop.getTime() - start,
        min: nowMs - days * 86400000 + 60000, max: nowMs, maxStep: Infinity,
        title: p.title,
        label: ms => clockLabel(ms, true),
        seek: ms => {
            if (ms >= AppClock.now().getTime() - 60000) return;
            PlayerBarUI.close();
            startArchiveAt(channel, ms);
        }
    };
}

/** Панель плеера по ▼ во время просмотра эфира. */
function openPlayerBar() {
    const channel = Player.getCurrentChannel();
    if (!channel) return;
    document.getElementById('key-hints').classList.add('hidden'); // иначе ложится поверх кнопок панели
    barReopen = null;
    const hasArchive = ChannelStore.archiveDays(channel) > 0;
    const info = () => {
        const m = hasArchive ? liveTimeline() : null;
        if (m) {
            return {
                name: channel.name, programme: m.title,
                progress: timelineFrac(m, m.pos),
                scrub: seekTarget !== null ? timelineFrac(m, seekTarget) : null,
                timeLabel: m.label(seekTarget !== null ? seekTarget : m.pos)
            };
        }
        const p = ChannelStore.getCurrentProgrammeFor(channel);
        return {
            name: channel.name,
            programme: p ? p.title : '',
            progress: p ? Math.max(0, Math.min(1, (AppClock.now() - p.start) / (p.stop - p.start))) : null
        };
    };
    const buttons = [];
    // включили на середине фильма — смотрим с его начала (только у каналов с архивом)
    if (hasArchive) buttons.push({ icon: 'restart', label: I18n.t('bar.fromStart'), action: watchFromStartButton });
    buttons.push(
        { icon: 'prev', label: I18n.t('ha.prev'), action: () => { PlayerBarUI.close(); switchChannel(-1); } },
        playPauseButton,
        { icon: 'next', label: I18n.t('ha.next'), action: () => { PlayerBarUI.close(); switchChannel(1); } },
        audioButton
    );
    // с архивом полоска передачи — линия времени (▲ с кнопок): ◄ уводит назад, в запись
    const opts = hasArchive ? { timeline: true, startZone: 'buttons', onScrub: scrubStep, onScrubCommit: commitScrub } : {};
    const reopen = () => openBar(info, buttons, opts);
    buttons.push(barSettingsButton(info, reopen, true));
    openBar(info, buttons, opts);
}

async function main() {
    // язык — до создания экранов: они берут подписи при init
    I18n.setLanguage(SettingsUI.getEffectiveConfig(CONFIG_DEFAULTS).language);
    document.documentElement.lang = I18n.language();
    document.getElementById('key-hints').innerHTML = I18n.t('keys.hints');
    Player.init();
    Player.setScaleMode(Prefs.get('scaleMode', 'off'));
    applySettings();
    applyClockSettings(CONFIG.clock);
    startClock();
    flashKeyHints();

    ChannelListUI.init(document.getElementById('channel-list'), { onSelect: playFromOverlay });
    ChannelEpgUI.init(document.getElementById('channel-epg'), {
        onSelect: (channel, programme) => (programme ? startArchive(channel, programme) : playFromOverlay(channel)),
        loadGuide: archiveGuide
    });
    SideMenuUI.init(document.getElementById('side-menu'));
    PlayerBarUI.init(document.getElementById('player-bar'));
    HomeUI.init(document.getElementById('home-view'), {
        onSelect: playFromOverlay,
        onSettings: () => openSettings(),
        onLockedGroup: () => askPin(() => HomeUI.setZone('grid'))
    });
    ExitDialogUI.init(document.getElementById('exit-dialog'));
    PairingUI.init(document.getElementById('pairing-view'));
    PlaylistDialogUI.init(document.getElementById('playlist-dialog'), { onSettings: () => openSettings() });
    SuggestUI.init({
        // постеры лежат в аддоне под именем из id («portal:48357» → portal_48357.jpg), как у избранного
        posterUrl: id => AddonClient.base(CONFIG.addonUrl) + '/posters/' + String(id).replace(/[^\w-]+/g, '_') + '.jpg',
        onPlay: item => { playVodFromHa({ id: item.id, title: item.title }).catch(() => { /* тост уже показан */ }); }
    });
    VodUI.init(document.getElementById('vod-view'), {
        onPlay: startVod,
        onExit: openPlaylistChooser,
        onOtherSource: openFavoriteFromOtherSource
    });
    // Фильм кончился: следующая серия, если есть, иначе — обратно к описанию (как просмотренный).
    Player.onCompleted((media) => {
        // архив догнал эфир (или сервер закрыл поток) — дальше смотрим вживую
        if (media && media.archive) { goLive(); return; }
        if (!media || !media.vod) return;
        const dur = Player.getDuration() || media.durationMs || 0;
        const pos = Math.max(Player.getPosition(), media.lastPos || 0);
        // AVPlay принимает обрыв соединения (часто после долгой паузы) за конец файла. До конца ещё далеко —
        // это обрыв: открываем фильм заново с того же места. Три обрыва подряд без хода вперёд — сдаёмся.
        if (dur > 0 && dur - pos > VOD_END_SLACK_MS) {
            if (pos > (media.reopenPos || 0) + VOD_END_SLACK_MS) media.reopens = 0;
            if ((media.reopens || 0) < VOD_REOPEN_MAX) {
                media.reopens = (media.reopens || 0) + 1;
                media.reopenPos = pos;
                console.warn('[Player] фильм оборвался на ' + Math.round(pos / 1000) + ' с из ' + Math.round(dur / 1000) + ' — открываю заново');
                VodHistory.setPosition(media.id, pos, dur);
                Player.restart(pos);
                return;
            }
            VodHistory.setPosition(media.id, pos, dur);
            leaveVodPlayback();
            showToast(I18n.t('vod.streamLost'), 'error', 8000);
            return;
        }
        VodHistory.setPosition(media.id, dur || 1, dur || 1);
        if (!vodEpisodeStep(1)) leaveVodPlayback();
    });
    // Позиция фильма пишется и по ходу просмотра — на случай, если приложение закроют кнопкой HOME.
    setInterval(() => { if (Player.isVod() && Player.getState() === 'PLAYING') saveVodPosition(); }, 15000);

    SettingsUI.init(document.getElementById('settings-view'), {
        onSave: reloadFromSettings,
        getInfo: settingsInfo
    });

    // Register channel-change listeners before the first playChannel() call below,
    // so the OSD and the list's "now playing" marker also reflect the very first channel.
    Player.onChannelChanged(showOsd);
    Player.onChannelChanged(hidePlayState);   // новый канал играет — висящая «Пауза» уже неправда
    Player.onChannelChanged(ChannelListUI.setCurrentPlaying);
    Player.onChannelChanged((channel) => {
        // Ch+/Ch− продолжают от того канала, что реально играет — откуда бы его ни включили
        // (список, плитка, номер, MQTT). По key: после загрузки EPG объекты каналов новые.
        const idx = channels.findIndex(c => c.key === channel.key);
        if (idx >= 0) currentIndex = idx;
        Prefs.set('lastChannelKey', channel.key);
        // канал может переключить и MQTT, пока открыт главный экран — тогда уходим к просмотру
        if (HomeUI.isOpen()) HomeUI.close();
        if (VodUI.isOpen()) VodUI.hide();
        PlaylistDialogUI.close();
        hideTimelineOsd();
        setViewPlaylist(CONFIG.activeTv ? CONFIG.activeTv.name : null);
    });
    Player.onVideoInfo(showVideoInfo);
    Player.onBufferingChanged(showBuffering);
    Player.onBufferingChanged(reopenIfStuck);
    Lifecycle.init();

    TvAudio.init();
    SleepTimer.init({
        onChange: () => MqttBridge.stateChanged(),
        onCountdown: showSleepCountdown,
        onFinish: sleepNow
    });
    const mqttStatus = { connectedOnce: false, hadProblem: false };
    // Команды из Home Assistant идут через те же функции, что и пульт, — с тем же показом на экране.
    // На главном экране воспроизведение остановлено, поэтому play и смена канала уводят к просмотру.
    const leaveHome = () => {
        if (HomeUI.isOpen() || VodUI.isOpen() || PlaylistDialogUI.isOpen()) {
            closeOverlays(); HomeUI.close(); VodUI.hide(); PlaylistDialogUI.close();
        }
    };
    MqttBridge.init({
        play: () => { leaveHome(); playOrResume(); },
        pause: () => { if (!menuOpen()) { saveVodPosition(); Player.pause(); showPlayState(); } },
        playPause: () => { leaveHome(); togglePlayPause(); },
        stop: () => { if (!menuOpen()) { saveVodPosition(); Player.stop(); showPlayState(); } },
        next: () => { leaveHome(); switchChannel(1); },
        prev: () => { leaveHome(); switchChannel(-1); },
        nextEpisode: () => vodEpisodeStep(1),
        prevEpisode: () => vodEpisodeStep(-1),
        programmeAt: (channel, ms) => { const p = programmeAt(channel, ms); return p.title ? p : null; },
        // «с начала», архив из карточки, эфир, перемотка, таймер сна — см. команды в js/mqtt-bridge.js
        fromStart: watchFromStart,
        where: playbackPoint,
        archive: playArchiveFromHa,
        live: () => { if (!isWatchingArchive()) throw new Error('not_archive'); goLive(); },
        seek: (sec) => {
            if (menuOpen() || !Player.getCurrentMedia()) throw new Error('not_playing');
            if (Player.isArchive()) seekArchive(Player.getCurrentChannel(), (Player.getArchiveTime() + sec) * 1000);
            else Player.seek(sec * 1000);
            if (timeline()) showTimelineOsd(4000);
        },
        seekTo: (sec) => {
            if (menuOpen()) throw new Error('not_playing');
            if (Player.isArchive()) {
                const channel = Player.getCurrentChannel();
                if (!channel) throw new Error('not_playing');
                seekArchive(channel, sec * 1000);
            } else if (Player.isVod() && Player.getDuration() > 0) {
                Player.seekTo(Math.min(Player.getDuration(), sec * 1000));
            } else throw new Error('seek_unavailable');
            if (timeline()) showTimelineOsd(4000);
        },
        sleep: (minutes) => { const m = SleepTimer.set(minutes); sleepToast(m); return m; },
        getSleepUntil: () => SleepTimer.untilSec(),
        onNotify: showNotice,
        onSuggest: (msg) => { hideNotice(); SuggestUI.show(msg); },
        getChannelNumber: (channel) => channels.findIndex(c => c.key === channel.key) + 1 || null,
        notify: (text) => showToast(text, 'ok', 2500),
        getPlaylists: () => CONFIG.playlists,
        getCurrentPlaylist: () => viewPlaylist,
        getTvPlaylist: () => (CONFIG.activeTv ? CONFIG.activeTv.name : null),
        setPlaylist: (index) => { pickPlaylist(index); },
        playVod: playVodFromHa,
        onParental: applyParental,
        onPlaylistsChanged: () => { onAddonPlaylistsChanged(); },
        onTvConfig: (cfg) => {
            if (!CONFIG.tv) return;
            CONFIG.tv.name = cfg.name;
            CONFIG.tv.area = cfg.area;
        },
        // «Подключён» — только при первом подключении и после сбоя, иначе при каждом сохранении
        // настроек он перекрывал бы сообщение о результате сохранения.
        onStatus: (status, detail) => {
            if (status === 'connected') {
                if ((!mqttStatus.connectedOnce || mqttStatus.hadProblem) && Date.now() > addonWarnUntil) showToast(I18n.t('mqtt.connected'), 'ok', 3000);
                mqttStatus.connectedOnce = true;
                mqttStatus.hadProblem = false;
                return;
            }
            mqttStatus.hadProblem = true;
            // логин, выданный аддоном, брокер не принял — один раз пробуем прежний из CONFIG_DEFAULTS
            if (status === 'error' && /authori|password|auth/i.test(detail) && !mqttStatus.fellBack &&
                !CONFIG.mqttOverride.username && addonReg && addonReg.mqtt && CONFIG_DEFAULTS.mqtt.host) {
                mqttStatus.fellBack = true;
                CONFIG.mqtt = Object.assign({}, CONFIG_DEFAULTS.mqtt, CONFIG.mqttOverride);
                MqttBridge.disconnect();
                MqttBridge.connect(CONFIG.mqtt, CONFIG.tv);
                return;
            }
            if (status === 'offline') showToast(I18n.t('mqtt.lost', { host: detail }), 'error', 6000);
            else showToast('MQTT: ' + detail, 'error', 8000);
        }
    });

    const listBusy = () => ChannelListUI.isEditingLogo() || ChannelListUI.isReordering();

    // Кто получает кнопки — сверху вниз: диалог выхода → Настройки → выбор плейлиста → видеопортал →
    // Главный экран → панель плеера → просмотр фильма → список групп → программа канала →
    // боковой список (и его режимы) → просмотр канала.
    const remoteKeys = {
        // На главном экране CH+/CH− не переключают канал, а прыгают по зонам: наверх к «Настройкам»
        // и вниз на ленту групп — иначе до них долго листать через все плитки.
        // При просмотре сериала — следующая/предыдущая серия.
        onChannelUp: () => {
            if (ExitDialogUI.isOpen() || SettingsUI.isOpen() || PlaylistDialogUI.isOpen() || VodUI.isOpen()) return;
            if (HomeUI.isOpen()) { HomeUI.setZone('header'); return; }
            if (isWatchingVod()) { vodEpisodeStep(1); return; }
            switchChannel(1);
        },
        onChannelDown: () => {
            if (ExitDialogUI.isOpen() || SettingsUI.isOpen() || PlaylistDialogUI.isOpen() || VodUI.isOpen()) return;
            if (HomeUI.isOpen()) { HomeUI.setZone('groups'); return; }
            if (isWatchingVod()) { vodEpisodeStep(-1); return; }
            switchChannel(-1);
        },
        onPlayPause: () => { if (!menuOpen()) { if (Player.isVod() && Player.getState() === 'PLAYING') saveVodPosition(); togglePlayPause(); } },
        onPlay: () => { if (!menuOpen()) playOrResume(); },
        onPause: () => { if (!menuOpen()) { saveVodPosition(); Player.pause(); showPlayState(); } },
        onStop: () => { if (!menuOpen()) { saveVodPosition(); Player.stop(); showPlayState(); } },
        onFastForward: () => { if (isWatchingTimeline()) { if (PlayerBarUI.isOpen()) PlayerBarUI.moveFocus(1); else scrubStep(1); } else if (!menuOpen()) Player.seek(30000); },
        onRewind: () => { if (isWatchingTimeline()) { if (PlayerBarUI.isOpen()) PlayerBarUI.moveFocus(-1); else scrubStep(-1); } else if (!menuOpen()) Player.seek(-30000); },

        onBack: () => {
            if (ExitDialogUI.isOpen()) ExitDialogUI.close();
            else if (SettingsUI.isOpen()) { if (SettingsUI.isEditing()) SettingsUI.stopEditing(); else SettingsUI.close(); }
            // выбор плейлиста: RETURN — диалог выхода (окно выбора остаётся под ним)
            else if (PlaylistDialogUI.isOpen()) ExitDialogUI.open();
            else if (VodUI.isOpen()) VodUI.handleKey('back');
            // главный экран: из плиток/настроек — на ленту групп, с ленты групп — выбор плейлиста
            else if (HomeUI.isOpen()) { if (HomeUI.getZone() === 'groups') openPlaylistChooser(); else HomeUI.setZone('groups'); }
            else if (PlayerBarUI.isOpen()) barBack();
            else if (InfoPanelUI.isOpen()) InfoPanelUI.close();
            else if (isWatchingTimeline() && seekTarget !== null) { cancelScrub(); showTimelineOsd(2000); }
            else if (isWatchingVod()) leaveVodPlayback();   // фильм → обратно к описанию
            else if (SideMenuUI.isOpen()) closeGroupsPanel();
            else if (ChannelEpgUI.isActive()) closeChannelEpg();
            else if (ChannelEpgUI.isOpen()) { closeChannelEpg(); ChannelListUI.close(); }   // кнопки у списка — закрыть оба
            else if (ChannelListUI.isOpen() && ChannelListUI.isEditingLogo()) ChannelListUI.cancelLogoEdit();
            else if (ChannelListUI.isOpen() && ChannelListUI.isReordering()) ChannelListUI.exitReorderMode();
            else if (ChannelListUI.isOpen()) ChannelListUI.close();
            else openHome();                       // просмотр → главный экран
        },
        onUp: () => {
            if (ExitDialogUI.isOpen()) return;
            if (SettingsUI.isOpen()) SettingsUI.moveFocus(-1);
            else if (PlaylistDialogUI.isOpen()) PlaylistDialogUI.moveFocus(-1);
            else if (VodUI.isOpen()) VodUI.handleKey('up');
            else if (HomeUI.isOpen()) HomeUI.moveVertical(-1);
            else if (PlayerBarUI.isOpen()) PlayerBarUI.moveVertical(-1);
            else if (InfoPanelUI.isOpen()) InfoPanelUI.close();
            else if (isWatchingTimeline() && !ChannelListUI.isOpen()) openInfoPanel();   // фильм/архив → описание
            else if (SideMenuUI.isOpen()) SideMenuUI.moveFocus(-1);
            else if (ChannelEpgUI.isActive()) ChannelEpgUI.moveFocus(-1);
            else if (ChannelListUI.isOpen()) moveListFocus(-1);
            else openInfoPanel();                  // просмотр → описание передачи
        },
        onDown: () => {
            if (ExitDialogUI.isOpen()) return;
            if (SettingsUI.isOpen()) SettingsUI.moveFocus(1);
            else if (PlaylistDialogUI.isOpen()) PlaylistDialogUI.moveFocus(1);
            else if (VodUI.isOpen()) VodUI.handleKey('down');
            else if (HomeUI.isOpen()) HomeUI.moveVertical(1);
            else if (PlayerBarUI.isOpen()) PlayerBarUI.moveVertical(1);
            else if (InfoPanelUI.isOpen()) InfoPanelUI.close();
            else if (isWatchingTimeline() && !ChannelListUI.isOpen()) openTimelinePlayerBar();   // фильм/архив → панель плеера
            else if (SideMenuUI.isOpen()) SideMenuUI.moveFocus(1);
            else if (ChannelEpgUI.isActive()) ChannelEpgUI.moveFocus(1);
            else if (ChannelListUI.isOpen()) moveListFocus(1);
            else openPlayerBar();                  // просмотр → панель плеера
        },
        // В режиме ввода текста (логотип, поле настроек) стрелки ◄► не перехватываем: там они
        // двигают курсор в поле (SettingsUI.changeValue на текстовом поле ничего не делает).
        onLeft: () => {
            InfoPanelUI.close();   // описание (▲) — прочие кнопки делают своё, закрыв его
            if (ExitDialogUI.isOpen()) ExitDialogUI.moveFocus(-1);
            else if (SettingsUI.isOpen()) SettingsUI.changeValue(-1);
            else if (PlaylistDialogUI.isOpen()) return;
            else if (VodUI.isOpen()) { if (!VodUI.isEditing()) VodUI.handleKey('left'); }
            else if (HomeUI.isOpen()) HomeUI.moveHorizontal(-1);
            else if (PlayerBarUI.isOpen()) PlayerBarUI.moveFocus(-1);
            // архив: ◄ — список каналов, как в эфире (назад бегунок идёт, только пока перемотка уже начата ►)
            else if (isWatchingArchive() && !ChannelListUI.isOpen() && seekTarget === null) { hideTimelineOsd(); ChannelListUI.open(); }
            else if (isWatchingTimeline() && !ChannelListUI.isOpen()) scrubStep(-1);    // фильм/архив → бегунок назад
            else if (SideMenuUI.isOpen()) return;
            else if (ChannelEpgUI.isActive()) focusChannelList();   // программа остаётся открытой
            else if (ChannelListUI.isOpen()) { if (!listBusy()) { ChannelEpgUI.close(); openGroupsPanel(); } }
            else ChannelListUI.open();             // просмотр → боковой список
        },
        onRight: () => {
            InfoPanelUI.close();
            if (ExitDialogUI.isOpen()) ExitDialogUI.moveFocus(1);
            else if (SettingsUI.isOpen()) SettingsUI.changeValue(1);
            // окно плейлистов — общее для ТВ и фильмов (и единственное, когда аддона нет): ► — настройки
            else if (PlaylistDialogUI.isOpen()) openSettings();
            else if (VodUI.isOpen()) { if (!VodUI.isEditing()) VodUI.handleKey('right'); }
            else if (HomeUI.isOpen()) HomeUI.moveHorizontal(1);
            else if (PlayerBarUI.isOpen()) PlayerBarUI.moveFocus(1);
            else if (isWatchingTimeline() && !ChannelListUI.isOpen()) scrubStep(1);     // фильм/архив → бегунок вперёд
            else if (SideMenuUI.isOpen()) SideMenuUI.activateFocused();
            else if (ChannelEpgUI.isActive()) return;
            else if (ChannelListUI.isOpen() && !listBusy()) openChannelEpg();
        },
        onEnter: () => {
            InfoPanelUI.close();
            if (ExitDialogUI.isOpen()) ExitDialogUI.activateFocused();
            // OK в поле с открытой клавиатурой — закончить ввод; иначе — открыть поле/нажать кнопку
            else if (SettingsUI.isOpen()) { if (SettingsUI.isEditing()) SettingsUI.stopEditing(); else SettingsUI.activateFocused(); }
            else if (PlaylistDialogUI.isOpen()) PlaylistDialogUI.activateFocused();
            else if (VodUI.isOpen()) VodUI.handleKey('enter');
            else if (HomeUI.isOpen()) HomeUI.activate();
            else if (PlayerBarUI.isOpen()) PlayerBarUI.activate();
            else if (isWatchingTimeline() && !ChannelListUI.isOpen()) { if (seekTarget !== null) { commitScrub(); showTimelineOsd(2500); } else openTimelinePlayerBar(); }
            else if (SideMenuUI.isOpen()) SideMenuUI.activateFocused();
            else if (ChannelEpgUI.isActive()) ChannelEpgUI.selectFocused();
            else if (ChannelListUI.isOpen()) {
                if (ChannelListUI.isEditingLogo()) ChannelListUI.confirmLogoEdit();
                else if (ChannelListUI.isReordering()) ChannelListUI.exitReorderMode();
                else ChannelListUI.selectFocused();
            }
            else ChannelListUI.open();             // просмотр → боковой список
        },

        // Цветные кнопки — только дубли для пультов, где они есть.
        onGreen: () => { if (!ExitDialogUI.isOpen()) { closeOverlays(); if (SettingsUI.isOpen()) SettingsUI.close(); else openSettings(); } },
        onRed: () => { if (ChannelListUI.isOpen() && !SideMenuUI.isOpen() && !ChannelEpgUI.isActive()) { ChannelEpgUI.close(); ChannelListUI.toggleLogoEdit(); } },
        onBlue: () => { if (ChannelListUI.isOpen() && !SideMenuUI.isOpen() && !ChannelEpgUI.isActive()) { ChannelEpgUI.close(); ChannelListUI.toggleReorderMode(); } },
        // Долгое OK в боковом списке (обычный просмотр списка, поверх ничего не открыто) —
        // перестановка выбранного канала прямо из списка, не включая его. Короткое OK — как раньше.
        wantsLongEnter: () => ChannelListUI.isOpen() && !listBusy() && !SettingsUI.isOpen() &&
            !HomeUI.isOpen() && !ExitDialogUI.isOpen() && !PlayerBarUI.isOpen() &&
            !SideMenuUI.isOpen() && !ChannelEpgUI.isActive() && !VodUI.isOpen() && !PlaylistDialogUI.isOpen(),
        onEnterLong: () => { ChannelEpgUI.close(); ChannelListUI.enterReorderMode(); },
        onImeDone: () => {
            if (SettingsUI.isOpen()) SettingsUI.stopEditing();
            else if (VodUI.isOpen() && VodUI.isEditing()) VodUI.stopEditing(true);
            else if (ChannelListUI.isEditingLogo()) ChannelListUI.confirmLogoEdit();
        },
        onImeCancel: () => {
            if (SettingsUI.isOpen()) SettingsUI.stopEditing();
            else if (VodUI.isOpen() && VodUI.isEditing()) VodUI.stopEditing(false);
            else if (ChannelListUI.isEditingLogo()) ChannelListUI.cancelLogoEdit();
        },
        onNumber: (digit) => {
            if (!menuOpen() && !SettingsUI.isOpen() && !ExitDialogUI.isOpen() && !Player.isVod()) onNumberKey(digit);
        }
    };
    // Окно PIN — поверх всего: пока открыто, кнопки только ему (цифры, стрелки, OK, RETURN), остальные молчат.
    const pinKeys = { onBack: 'back', onUp: 'up', onDown: 'down', onLeft: 'left', onRight: 'right', onEnter: 'enter' };
    Object.keys(remoteKeys).forEach(name => {
        const fn = remoteKeys[name];
        remoteKeys[name] = function () {
            // идёт отсчёт таймера сна — любая кнопка его отменяет (и только это: человек ещё смотрит)
            if (SleepTimer.isFading() && name !== 'wantsLongEnter') {
                SleepTimer.cancel();
                showToast(I18n.t('sleep.cancelled'), 'ok', 4000);
                return;
            }
            // ждём привязки к аддону: OK — Настройки (адрес аддона), RETURN — выход; остальное не нужно
            if (PairingUI.isOpen() && !SettingsUI.isOpen() && !ExitDialogUI.isOpen()) {
                if (name === 'wantsLongEnter') return false;
                if (name === 'onEnter') openSettings();
                else if (name === 'onBack') ExitDialogUI.open();
                else if (name === 'onGreen') fn.apply(null, arguments);
                return;
            }
            // подборка фильмов от ассистента лежит поверх всего: ◄► OK RETURN и цифры — ей
            if (SuggestUI.isOpen() && !PinDialogUI.isOpen() && !SettingsUI.isOpen() && !ExitDialogUI.isOpen()) {
                if (name === 'wantsLongEnter') return false;
                if (SuggestUI.handleKey(name, arguments[0])) return;
            }
            // плашка из HA (напоминание): OK — включить канал, RETURN — убрать; остальные кнопки работают как обычно
            if (notice && !PinDialogUI.isOpen() && !SettingsUI.isOpen() && !ExitDialogUI.isOpen()) {
                if (name === 'wantsLongEnter') return false;
                // плашка-вопрос со списком: ▲▼ и цифры выбирают, OK отвечает
                if (notice.options && notice.request) {
                    if (name === 'onUp') return moveNoticeFocus(-1);
                    if (name === 'onDown') return moveNoticeFocus(1);
                    if (name === 'onEnter') return pickNoticeOption(notice.focus);
                    if (name === 'onNumber' && arguments[0] >= 1 && arguments[0] <= notice.options.length) return pickNoticeOption(arguments[0] - 1);
                }
                if (name === 'onEnter') return activateNotice();
                if (name === 'onBack') return hideNotice();
            }
            if (!PinDialogUI.isOpen()) return fn.apply(null, arguments);
            if (name === 'wantsLongEnter') return false;
            if (name === 'onNumber') PinDialogUI.handleKey('digit', arguments[0]);
            else if (pinKeys[name]) PinDialogUI.handleKey(pinKeys[name]);
        };
    });
    RemoteControl.init(remoteKeys);

    // Пульт уже отвечает, а плейлист грузится: без await — если аддон не отвечает, запрос ждёт таймаута
    // (addon-client.js), и всё это время приложение должно оставаться живым.
    startFromAddon().catch(showFatalError);

    // Аддон пересобирает EPG каждые несколько часов, а окно передач у него ограничено —
    // без периодического обновления на долго включённом телевизоре программа «кончится».
    // Пока открыт какой-то экран — пропускаем: перерисовка сбила бы фокус.
    // Аддон и сам сообщает о пересборке (MQTT iptv/playlists), таймер — на случай, если MQTT не работает.
    setInterval(() => {
        if (screensBusy() || !CONFIG.activeTv || addonDownWarned) return;
        loadActiveTvPlaylist(false).then(refreshChannelsUi).catch(err => console.error('[EPG] refresh failed', err));
    }, EPG_REFRESH_MS);
}

const EPG_REFRESH_MS = 3 * 60 * 60 * 1000;

/**
 * Сон TV и уход приложения в фон. Раньше плеер это никак не обрабатывал: после включения TV AVPlay
 * оставался на оборванном потоке — вечная «буферизация», пульт не отвечал (выйти можно было только
 * долгим RETURN). Теперь: скрыли — позиция фильма запоминается и поток закрывается (Player.suspend);
 * показали — ждём, пока появится сеть (Wi-Fi после сна поднимается не сразу), и открываем заново то,
 * что играло: канал — с live, фильм — с сохранённого места. Если в этот момент открыто меню
 * (главный экран, кино) — ничего не запускаем, как и при обычной остановке.
 */
const Lifecycle = (() => {
    let resumeTimer = null;
    let hiddenAt = 0;

    function networkUp() {
        try {
            if (typeof webapis !== 'undefined' && webapis.network && webapis.network.isConnectedToGateway) {
                return webapis.network.isConnectedToGateway();
            }
        } catch (e) { /* нет API — смотрим navigator.onLine */ }
        return navigator.onLine !== false;
    }

    function onHidden() {
        clearTimeout(resumeTimer);
        hiddenAt = Date.now();
        if (Player.isVod() && !Player.isSuspended()) saveVodPosition();
        cancelScrub();
        SleepTimer.cancel();   // телевизор выключили сами — таймер больше не нужен
        hideNotice();
        // «Пауза»/«Воспроизведение» по центру: после пробуждения фильм открывается заново и играет,
        // а таймер, прятавший надпись, во сне мог не сработать — надпись висела бы поверх фильма
        hidePlayState();
        Player.suspend();
        relockParental();
    }

    function onVisible() {
        if (!Player.isSuspended()) return;
        showBuffering(true, { reason: 'open', percent: 0, seconds: 0 });
        const started = Date.now();
        const tryResume = () => {
            if (document.hidden) return;
            // до 30 с ждём сеть; дольше — всё равно пробуем, индикатор покажет, что идёт подключение
            if (!networkUp() && Date.now() - started < 30000) { resumeTimer = setTimeout(tryResume, 1000); return; }
            if (!Player.isSuspended()) return;          // уже включили что-то другое (пульт, MQTT)
            if (menuOpen()) { showBuffering(false, {}); return; }
            const media = Player.getCurrentMedia();
            if (media && media.vod) Player.playVod(media, VodHistory.getResume(media.id));
            // канал под замком родительского контроля (включали из карточки с PIN) сам не возобновляется
            else if (Player.getCurrentChannel() && Parental.isLocked(Player.getCurrentChannel())) { showBuffering(false, {}); openHome(); }
            else if (media && media.archive) Player.restart();   // архив — с того же места
            else if (Player.getCurrentChannel()) Player.playChannel(Player.getCurrentChannel());
            else showBuffering(false, {});
        };
        // сразу после пробуждения прошивка ещё занята — небольшая пауза перед открытием потока
        resumeTimer = setTimeout(tryResume, Date.now() - hiddenAt > 5000 ? 1500 : 300);
    }

    function init() {
        document.addEventListener('visibilitychange', () => (document.hidden ? onHidden() : onVisible()));
    }

    return { init };
})();

/**
 * Сторож: картинки нет дольше STUCK_MS (канал не открывается или поток завис) — открываем поток заново,
 * не чаще раза в STUCK_MS. Раньше висело бесконечно и спасала только ручная смена канала.
 */
const STUCK_MS = 30000;
let lastReopenTs = 0;
function reopenIfStuck(isWaiting, info) {
    if (!isWaiting || info.seconds * 1000 < STUCK_MS || Date.now() - lastReopenTs < STUCK_MS) return;
    if (document.hidden || Player.isSuspended() || menuOpen()) return;
    lastReopenTs = Date.now();
    const media = Player.getCurrentMedia();
    if (!media) return;
    console.warn('[Player] нет картинки ' + info.seconds + ' с — открываю поток заново');
    if (media.vod) Player.restart(Math.max(VodHistory.getResume(media.id), Player.getPosition()));
    else Player.restart();
}

/** На TV нет консоли и нет доступного sdb dlog — без этого любое падение старта выглядит
 *  просто как чёрный экран, и непонятно, что случилось. Показываем ошибку прямо на экране. */
function showFatalError(err) {
    const el = document.getElementById('fatal-error');
    el.textContent = (typeof I18n !== 'undefined' ? I18n.t('app.startError') : 'Startup error') + ':\n' + (err && err.stack ? err.stack : err);
    el.classList.remove('hidden');
}

document.addEventListener('DOMContentLoaded', () => {
    main().catch(showFatalError);
});
window.addEventListener('error', (e) => showFatalError(e.error || e.message));
