/**
 * custom:tizen-iptv-card — карточка Home Assistant для плеера AssisTV.
 *
 *   type: custom:tizen-iptv-card
 *   tv_id: qe55qn85c_xxxx                             # какой телевизор (страница аддона IPTV) — обязательно
 *   title: Спальня                                    # необязательно, по умолчанию — имя TV из аддона
 *   tv_entity: media_player.…                         # необязательно, по умолчанию — media_player, выбранный
 *                                                     # для этого TV на странице аддона
 *   state_entity: sensor.iptv_<tv_id>_playback        # необязательно, по умолчанию — от tv_id
 *   data_url: /local/tizen-iptv/channels-<tv_id>.json # необязательно, по умолчанию — от tv_id
 *   collapse_channels: true                           # необязательно: список каналов свёрнут под строкой «Каналы»,
 *                                                     # плеер — во всю ширину; раскрывается нажатием
 *
 * Новый телевизор: Изменить дашборд → Добавить карточку → «AssisTV» → выбрать TV в списке
 * (визуальный редактор ниже, список берётся из /local/tizen-iptv/tvs.json, его пишет аддон).
 *
 * Команды уходят через mqtt.publish в топики этого телевизора — iptv/<tv_id>/set_channel,
 * iptv/<tv_id>/command, iptv/<tv_id>/set_playlist. Вкладка «Фильмы и сериалы»: поиск и детали — запросы
 * аддону iptv/vod/search|details, запуск — iptv/request {action: vod_play, tv, fid} (аддон при необходимости
 * включит TV и плеер); ответы приходят подпиской mqtt/subscribe через websocket HA (только для админов HA). Поиск — ChannelMatch из js/channel-match.js плеера
 * (аддон склеивает его с этим файлом), поэтому находит каналы с опечатками так же, как TV.
 *
 * Родительский контроль (аддон, parental.js; в channels-<tv_id>.json — parental {enabled, mode, groups}): группы под
 * PIN показаны с замком, их каналов нет в «Все каналы» и в поиске; PIN проверяет аддон (iptv/request parental_check),
 * открыто до перезагрузки страницы. Защищённый канал включается через аддон с PIN (iptv/request channel + pin) —
 * напрямую в set_channel телевизор его не примет. На TV со «скрывать» аддон убирает эти каналы из файла сам.
 *
 * Без сборщика и без Lit: обычный custom element, чтобы файл можно было положить в /local как есть.
 *
 * Тексты — на языке пользователя HA (lang/*.js, js/i18n.js — аддон склеивает их с карточкой, card-data.js).
 */
(() => {
    // язык пользователя HA: hass приложения (есть не всегда при загрузке модуля), иначе <html lang>, который ставит HA
    const haLanguage = () => {
        const ha = document.querySelector('home-assistant');
        return (ha && ha.hass && ha.hass.language) || document.documentElement.lang || 'auto';
    };
    I18n.setLanguage(haLanguage());
    const _t = (key, params) => I18n.t(key, params);
    const PAGE = 60;                  // плиток за раз — в группе «кино» их почти 300
    const DATA_REFRESH_MS = 15 * 60 * 1000;
    const VOL_SEND_MS = 200;          // ползунок громкости: не чаще одной команды за это время
    const VOL_HOLD_MS = 1200;         // столько держим своё значение, не давая состоянию от TV вернуть старое
    const ALL_GROUP = 'Все каналы';   // как на TV (js/channel-store.js groupsOf) — всегда последняя группа
    const NO_GROUP = 'Без группы';
    // эти имена — внутренние (так их пишет плеер), на экран — через groupLabel
    const groupLabel = (g) => (g === ALL_GROUP ? _t('groups.all') : g === NO_GROUP ? _t('groups.none') : g);

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    /**
     * Идентификатор фильма — составной: «portal:48357» (источник и его номер). У записей, сделанных до
     * появления плагинов, источника нет — это portal, как и в аддоне (VodSources.splitId).
     */
    const vodId = (x) => String(x && x.id != null && x.id !== '' ? x.id : (x && x.src ? x.src : 'portal') + ':' + (x ? x.fid : ''));
    const httpsLogo = (u) => (u ? String(u).replace(/^https?:\/\/(cdn\.)?epg\.one\//, 'https://cdn.epg.one/') : '');
    const hhmm = (sec) => new Date(sec * 1000).toLocaleTimeString(I18n.locale(), { hour: '2-digit', minute: '2-digit' });
    const norm = (s) => String(s).toLowerCase().replace(/ё/g, 'е');
    const initials = (name) => esc(String(name).replace(/[^\p{L}\p{N}\s]/gu, '').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase());

    const STATE_KEYS = {
        playing: 'state.playing', paused: 'state.paused', stopped: 'card.stopped', buffering: 'buffering.buffering',
        unavailable: 'card.playerOff', unknown: 'card.noData', tv_off: 'card.tvOff', powering: 'card.poweringOn'
    };

    const STYLE = `
    :host { display: block; }
    [hidden] { display: none !important; }
    ha-card { padding: 16px; box-sizing: border-box; }
    .layout { display: flex; flex-direction: column; gap: 18px; }
    .wide .layout { flex-direction: row; align-items: flex-start; }
    .player { position: relative; display: flex; flex-direction: column; gap: 12px; }
    .wide .player { width: 380px; flex: none; position: sticky; top: 12px; }
    .guide { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 10px; }
    button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; -webkit-tap-highlight-color: transparent; }

    .np { display: flex; gap: 14px; align-items: center; }
    .np-logo { width: 88px; height: 88px; flex: none; border-radius: 16px; display: grid; place-items: center;
        background: var(--secondary-background-color, #f2f2f2); overflow: hidden; }
    .np-logo img { width: 78%; height: 78%; object-fit: contain; }
    .np-logo ha-icon { --mdc-icon-size: 40px; color: var(--secondary-text-color); }
    .np-meta { min-width: 0; flex: 1; }
    .np-top { display: flex; align-items: center; gap: 8px; min-height: 28px; }
    .spacer { flex: 1; }
    .chip { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; padding: 3px 10px;
        border-radius: 999px; background: var(--secondary-background-color, #eee); color: var(--secondary-text-color); white-space: nowrap; }
    .chip::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
    .chip.playing { color: var(--success-color, #43a047); }
    .chip.buffering { color: var(--warning-color, #ffa000); }
    .chip.paused, .chip.stopped { color: var(--info-color, #039be5); }
    .chip.unavailable, .chip.tv_off { color: var(--error-color, #db4437); }
    .chip.powering { color: var(--warning-color, #ffa000); }
    .pill.busy { opacity: .6; cursor: default; }
    .pill.secondary { background: var(--secondary-background-color, #f0f0f0); color: var(--primary-text-color); display: inline-flex; align-items: center; gap: 4px; }
    .pill.secondary ha-icon { --mdc-icon-size: 18px; }
    .pill[disabled] { opacity: .4; pointer-events: none; }
    .arch-row { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
    .arch-panel { border-radius: 12px; background: var(--secondary-background-color, #f5f5f5); padding: 8px 10px; }
    .arch-head { display: flex; align-items: center; gap: 8px; font-size: 14px; }
    .arch-sub { font-size: 12px; color: var(--secondary-text-color); }
    .arch-msg { padding: 10px 2px; font-size: 13px; color: var(--secondary-text-color); }
    .arch-list { max-height: 320px; overflow-y: auto; display: flex; flex-direction: column; }
    .arch-day { position: sticky; top: 0; padding: 6px 2px 4px; font-size: 12px; font-weight: 700; text-transform: capitalize; color: var(--secondary-text-color); background: var(--secondary-background-color, #f5f5f5); }
    .arch-item { display: flex; align-items: baseline; gap: 10px; padding: 7px 6px; border-radius: 8px; text-align: left; font-size: 14px; color: var(--primary-text-color); }
    .arch-item:hover { background: var(--card-background-color, #fff); }
    .arch-item.pending { opacity: .5; }
    .arch-time { flex: none; font-variant-numeric: tabular-nums; color: var(--secondary-text-color); }
    .arch-title { flex: 1; min-width: 0; }
    .arch-now { flex: none; font-size: 11px; font-weight: 700; color: var(--primary-color); }
    .tile .archive { cursor: pointer; }
    .np-name { font-size: 20px; font-weight: 600; line-height: 1.25; margin-top: 4px; overflow: hidden;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
    .np-num { color: var(--secondary-text-color); font-weight: 500; margin-right: 8px; }
    .np-prog { color: var(--secondary-text-color); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-height: 20px; }
    .progress { height: 6px; border-radius: 3px; background: var(--divider-color, rgba(0,0,0,.12)); overflow: hidden; }
    .progress i { display: block; height: 100%; width: 0; background: var(--primary-color); border-radius: 3px; transition: width .6s; }
    .np-times { display: flex; justify-content: space-between; font-size: 12px; color: var(--secondary-text-color); margin-top: -6px; min-height: 16px; }
    .media-progress { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--secondary-text-color); font-variant-numeric: tabular-nums; }
    .media-progress span { min-width: 38px; }
    .media-progress span:last-child { text-align: right; }
    .media-progress input { appearance: none; flex: 1; min-width: 0; height: 5px; border-radius: 5px; cursor: pointer; }
    .media-progress input::-webkit-slider-thumb { appearance: none; width: 13px; height: 13px; border-radius: 50%; background: var(--primary-color); }
    .media-progress input::-moz-range-thumb { width: 13px; height: 13px; border: 0; border-radius: 50%; background: var(--primary-color); }
    .media-progress input:disabled { cursor: default; opacity: .55; }

    .controls { display: flex; justify-content: center; align-items: center; gap: 14px; }
    .ctl { width: 52px; height: 52px; border-radius: 50%; display: grid; place-items: center; background: var(--secondary-background-color, #eee); }
    .ctl ha-icon { --mdc-icon-size: 26px; }
    .ctl.main { width: 68px; height: 68px; background: var(--primary-color); color: var(--text-primary-color, #fff); }
    .ctl.main ha-icon { --mdc-icon-size: 36px; }
    .ctl.nav { border: 1px solid var(--divider-color, rgba(0,0,0,.16)); }
    .ctl.stop { width: 38px; height: 38px; margin-left: 10px; background: transparent; border: 1px solid var(--divider-color, rgba(0,0,0,.16)); }
    .ctl.stop ha-icon { --mdc-icon-size: 21px; }
    .ctl[disabled] { opacity: .38; cursor: default; }
    .ctl:active, .icon-btn:active, .tile:active { transform: scale(.94); }
    .icon-btn { width: 38px; height: 38px; border-radius: 50%; display: grid; place-items: center; flex: none; }
    .icon-btn:hover, .ctl:hover { filter: brightness(1.08); }
    .icon-btn.on { color: var(--error-color, #db4437); }
    .volume-panel { border-radius: 12px; background: var(--secondary-background-color, #f5f5f5); padding: 0 10px; }
    .volume-panel summary { list-style: none; display: flex; align-items: center; gap: 8px; min-height: 42px; cursor: pointer; }
    .volume-panel summary::-webkit-details-marker { display: none; }
    .volume-panel summary ha-icon { --mdc-icon-size: 20px; color: var(--secondary-text-color); }
    .volume-panel summary .volume-name { flex: 1; }
    .volume-panel summary .volume-value { color: var(--secondary-text-color); font-variant-numeric: tabular-nums; }
    .volume { display: flex; align-items: center; gap: 8px; padding: 0 0 8px; }
    .volume input { flex: 1; min-width: 60px; accent-color: var(--primary-color); }
    .vol-val { width: 34px; text-align: right; font-variant-numeric: tabular-nums; color: var(--secondary-text-color);
      transition: color .15s, transform .15s; }
    .vol-val.bump { color: var(--primary-color); transform: scale(1.35); }
    .disabled .controls, .disabled .volume-panel { opacity: .4; pointer-events: none; }

    .offline { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 12px; border-radius: 12px;
        background: rgba(219, 68, 55, .1); color: var(--primary-text-color); font-size: 14px; }
    .offline .spacer { min-width: 8px; }
    .pill { padding: 7px 14px; border-radius: 999px; background: var(--primary-color); color: var(--text-primary-color, #fff); font-weight: 600; font-size: 13px; }
    .toast { position: absolute; left: 50%; bottom: -6px; transform: translate(-50%, 100%); background: var(--primary-text-color); color: var(--card-background-color, #fff);
        padding: 6px 14px; border-radius: 999px; font-size: 13px; white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; z-index: 2; }

    .search { display: flex; align-items: center; gap: 8px; padding: 0 10px; height: 42px; border-radius: 21px; background: var(--secondary-background-color, #eee); }
    .search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; font: inherit; color: var(--primary-text-color); }
    .search ha-icon { color: var(--secondary-text-color); }
    .vod-recent { display: flex; gap: 6px; overflow-x: auto; padding: 2px 0 8px; scrollbar-width: none; }
    .vod-recent[hidden] { display: none; }
    .vod-recent::-webkit-scrollbar { display: none; }
    .vod-recent button { flex: none; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 5px 10px; border-radius: 999px; font-size: 12px; color: var(--secondary-text-color); border: 1px solid var(--divider-color, rgba(0,0,0,.12)); }
    .vod-fav-box { margin: 4px 0 12px; }
    .vod-fav-box summary { cursor: pointer; list-style: none; display: flex; align-items: center; gap: 6px; font-size: 14px; font-weight: 600; color: var(--secondary-text-color); padding: 4px 0 8px; }
    .vod-fav-box summary::-webkit-details-marker { display: none; }
    .vod-fav-box summary::before { content: '▶'; font-size: 10px; transition: transform .15s; }
    .vod-fav-box[open] summary::before { transform: rotate(90deg); }
    .chips { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 2px; scrollbar-width: none; }
    .chips::-webkit-scrollbar { display: none; }
    .chips button { flex: none; padding: 6px 14px; border-radius: 999px; font-size: 14px; border: 1px solid var(--divider-color, rgba(0,0,0,.12)); white-space: nowrap; }
    .chips button.active { background: var(--primary-color); border-color: var(--primary-color); color: var(--text-primary-color, #fff); }
    .chips small { opacity: .7; margin-left: 4px; }

    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 8px; }
    .tile { display: flex; gap: 10px; align-items: center; text-align: left; padding: 8px; border-radius: 14px; min-width: 0;
        background: var(--secondary-background-color, #f5f5f5); border: 2px solid transparent; }
    .tile:hover { border-color: var(--divider-color, rgba(0,0,0,.12)); }
    .tile.active { border-color: var(--primary-color); }
    .tile.pending { opacity: .6; }
    .t-logo { width: 52px; height: 52px; flex: none; border-radius: 10px; display: grid; place-items: center; background: var(--card-background-color, #fff);
        overflow: hidden; font-weight: 700; color: var(--secondary-text-color); font-size: 15px; }
    .t-logo img { width: 84%; height: 84%; object-fit: contain; }
    .t-body { min-width: 0; flex: 1; }
    .t-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .t-name { font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 0 1 auto; }
    /* метка архива — всегда в правом верхнем углу плитки, как бы ни было длинно название */
    .tile { position: relative; }
    .tile.has-arch .t-top { padding-right: 24px; }
    .archive { position: absolute; top: 5px; right: 6px; font-size: 11px; font-weight: 700; line-height: 1; padding: 2px 5px; border-radius: 5px;
        background: var(--warning-color, #ffa000); color: #fff; }
    .t-num { color: var(--secondary-text-color); font-weight: 500; margin-right: 6px; font-variant-numeric: tabular-nums; }
    .t-prog { font-size: 12px; color: var(--secondary-text-color); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; min-height: 15px; }
    .t-bar { height: 3px; border-radius: 2px; background: var(--divider-color, rgba(0,0,0,.1)); margin-top: 5px; overflow: hidden; }
    .t-bar i { display: block; height: 100%; background: var(--primary-color); }
    .tile.active .t-name::after { content: ' ▶'; color: var(--primary-color); }
    .empty { text-align: center; color: var(--secondary-text-color); padding: 24px 8px; }
    .pin { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 20px 8px; text-align: center; }
    .pin ha-icon { --mdc-icon-size: 44px; color: var(--warning-color, #e0a000); }
    .pin-row { display: flex; gap: 8px; }
    .pin input { font: inherit; font-size: 22px; letter-spacing: 8px; width: 120px; text-align: center; padding: 6px 8px; border-radius: 8px;
        border: 1px solid var(--divider-color, #ccc); background: var(--card-background-color, #fff); color: var(--primary-text-color); }
    .pin button { padding: 6px 16px; border-radius: 8px; background: var(--primary-color); color: var(--text-primary-color, #fff); }
    .pin-msg { font-size: 13px; color: var(--error-color, #c00); min-height: 16px; }
    .chips button ha-icon { --mdc-icon-size: 15px; margin-right: 3px; vertical-align: -2px; }
    .sentinel { height: 1px; }
    .card-title { font-size: 18px; font-weight: 600; margin: -4px 0 12px; }
    .playlists { display: flex; gap: 8px; flex-wrap: wrap; }
    .playlists button { display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px; border-radius: 10px; font-size: 14px;
        background: var(--secondary-background-color, #eee); border: 2px solid transparent; }
    .playlists button ha-icon { --mdc-icon-size: 18px; }
    .playlists button.active { border-color: var(--primary-color); color: var(--primary-color); font-weight: 600; }
    .playlists button.pending { opacity: .6; }

    .vod { display: flex; flex-direction: column; gap: 10px; }
    .vod-fav-title { font-size: 14px; font-weight: 600; color: var(--secondary-text-color); margin-bottom: 6px; }
    .fav-btn.on { color: var(--primary-color); }
    .posters { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 12px; }
    .poster { display: flex; flex-direction: column; gap: 4px; text-align: left; min-width: 0; }
    .poster .pic { position: relative; aspect-ratio: 2 / 3; border-radius: 10px; overflow: hidden; background: var(--secondary-background-color, #eee);
        display: grid; place-items: center; color: var(--secondary-text-color); }
    .poster .pic img { width: 100%; height: 100%; object-fit: cover; }
    .poster .badge { position: absolute; left: 6px; top: 6px; font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 6px; background: rgba(0,0,0,.65); color: #fff; }
    .poster .p-title { font-weight: 600; font-size: 13px; line-height: 1.25; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .poster .p-meta { font-size: 12px; color: var(--secondary-text-color); }
    .poster:hover .pic { outline: 2px solid var(--primary-color); }
    .vod-detail { position: relative; display: flex; gap: 16px; padding: 12px; border-radius: 14px; background: var(--secondary-background-color, #f5f5f5); }
    .vod-detail .d-pic { width: 150px; flex: none; aspect-ratio: 2 / 3; border-radius: 10px; overflow: hidden; background: var(--card-background-color, #fff); }
    .vod-detail .d-pic img { width: 100%; height: 100%; object-fit: cover; }
    .vod-detail .d-body { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 8px; }
    .vod-detail .d-title { font-size: 20px; font-weight: 600; padding-right: 36px; }
    .vod-detail .d-meta { font-size: 13px; color: var(--secondary-text-color); }
    .vod-detail .d-rating { display: inline-block; margin-right: 8px; padding: 1px 7px; border-radius: 10px;
      background: #d9a441; color: #1a1a1a; font-weight: 600; }
    .vod-detail .d-rating.dim { background: rgba(217,164,65,0.28); color: var(--primary-text-color); }
    .vod-detail .d-rating i { margin-left: 5px; font-size: 10px; font-style: normal; opacity: 0.75; }
    .vod-detail .d-desc { font-size: 14px; line-height: 1.4; max-height: 7em; overflow: auto; }
    .vod-detail .d-btns { display: flex; gap: 8px; flex-wrap: wrap; }
    .vod-detail .pill.secondary { background: var(--card-background-color, #fff); color: var(--primary-text-color); border: 1px solid var(--divider-color, rgba(0,0,0,.12)); }
    .vod-detail .d-close { position: absolute; right: 8px; top: 8px; }
    .episodes { display: flex; flex-wrap: wrap; gap: 6px; max-height: 150px; overflow: auto; }
    .episodes button { padding: 5px 10px; border-radius: 8px; font-size: 13px; background: var(--card-background-color, #fff); border: 1px solid var(--divider-color, rgba(0,0,0,.12)); }
    .episodes button:hover { border-color: var(--primary-color); }
    @media (max-width: 520px) { .vod-detail { flex-direction: column; } .vod-detail .d-pic { width: 120px; } }

    /* collapse_channels: список под строкой «Каналы»; раскрытие — анимация высоты через grid 0fr → 1fr */
    .fold { min-width: 0; flex: 1; }
    .fold-head { display: none; }
    .foldable .layout, .foldable.wide .layout { flex-direction: column; align-items: stretch; }
    .foldable.wide .player { width: auto; position: relative; top: 0; }
    .foldable .fold { border-radius: 16px; background: var(--secondary-background-color, #f5f5f5); }
    .foldable .fold-head { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 54px; padding: 0 14px; box-sizing: border-box; text-align: left; }
    .fold-head .fold-icon { width: 34px; height: 34px; flex: none; border-radius: 11px; display: grid; place-items: center;
        background: color-mix(in srgb, var(--primary-color) 22%, transparent); color: var(--primary-color); }
    .fold-head .fold-icon ha-icon { --mdc-icon-size: 20px; }
    .fold-head .fold-name { font-size: 15px; font-weight: 600; }
    .fold-head .fold-count { font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 999px; color: var(--secondary-text-color);
        background: var(--card-background-color, #fff); font-variant-numeric: tabular-nums; }
    .fold-head .fold-now { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; color: var(--secondary-text-color); text-align: right; }
    .fold-head .fold-chev { flex: none; color: var(--secondary-text-color); transition: transform .3s ease; }
    .fold.open .fold-chev { transform: rotate(180deg); }
    .foldable .fold-body { display: grid; grid-template-rows: 0fr; transition: grid-template-rows .35s ease; }
    .foldable .fold.open .fold-body { grid-template-rows: 1fr; }
    .foldable .fold-inner { min-height: 0; overflow: hidden; }
    .foldable .guide { padding: 0 12px 12px; opacity: 0; transition: opacity .25s ease; }
    .foldable .fold.open .guide { opacity: 1; }
    `;

    class TizenIptvCard extends HTMLElement {
        /** Новая карточка из «Добавить карточку» — сразу на первый зарегистрированный телевизор. */
        static async getStubConfig() {
            const list = await loadTvs();
            return { tv_id: list.length ? list[0].tv_id : '' };
        }

        static getConfigElement() {
            return document.createElement('tizen-iptv-card-editor');
        }

        setConfig(config) {
            const tvId = config && config.tv_id ? String(config.tv_id).trim() : '';
            this._config = Object.assign({
                state_entity: 'sensor.iptv_' + tvId + '_playback',
                tv_entity: null,
                data_url: '/local/tizen-iptv/channels-' + tvId + '.json',
                app_id: 'TzIptvPl01.IPTVTizen',
                title: ''
            }, config || {});
            this._tvId = tvId;
            this._topic = 'iptv/' + tvId;
            if (this.shadowRoot && this._started) this._loadData();
            if (!this.shadowRoot) this._build();
            else this._card.classList.toggle('foldable', !!this._config.collapse_channels);
            if (this.isConnected && !this._started) this.connectedCallback();
        }

        getCardSize() { return 12; }
        getGridOptions() { return { columns: 'full', rows: 'auto' }; }

        set hass(hass) {
            this._hass = hass;
            if (hass.language && I18n.normalize(hass.language) && I18n.normalize(hass.language) !== I18n.language()) I18n.setLanguage(hass.language);
            const st = hass.states[this._config.state_entity];
            const tvEntity = this._tvEntity();
            const tv = tvEntity ? hass.states[tvEntity] : null;
            if (st !== this._lastSt || tv !== this._lastTv) {
                this._lastSt = st;
                this._lastTv = tv;
                this._renderPlayer();
            }
        }

        connectedCallback() {
            if (!this.shadowRoot || this._started) return;
            this._started = true;
            this._loadData();
            this._dataTimer = setInterval(() => this._loadData(), DATA_REFRESH_MS);
            this._tick = setInterval(() => { this._renderProgress(); this._refreshTiles(); }, 30000);
            this._onVisible = () => { if (!document.hidden && Date.now() - (this._loadedAt || 0) > 5 * 60 * 1000) this._loadData(); };
            document.addEventListener('visibilitychange', this._onVisible);
            this._ro = new ResizeObserver(entries => {
                const w = entries[0].contentRect.width;
                this._card.classList.toggle('wide', w >= 860);
            });
            this._ro.observe(this);
            this._io = new IntersectionObserver(entries => {
                if (entries.some(e => e.isIntersecting)) this._renderMore();
            }, { rootMargin: '600px' });
            this._io.observe(this.$('sentinel'));
        }

        disconnectedCallback() {
            this._started = false;
            this._unsubscribeMqtt();
            clearInterval(this._dataTimer);
            clearInterval(this._tick);
            document.removeEventListener('visibilitychange', this._onVisible);
            if (this._ro) this._ro.disconnect();
            if (this._io) this._io.disconnect();
        }

        $(id) { return this.shadowRoot.getElementById(id); }

        _build() {
            I18n.setLanguage(haLanguage());
            const root = this.attachShadow({ mode: 'open' });
            root.innerHTML = `<style>${STYLE}</style>
            <ha-card id="card">
              <div class="card-title" id="title" hidden></div>
              <div class="layout">
                <div class="player" id="player">
                  <div class="np">
                    <div class="np-logo" id="npLogo"><ha-icon icon="mdi:television-classic"></ha-icon></div>
                    <div class="np-meta">
                      <div class="np-top">
                        <span class="chip" id="chip">…</span><span class="spacer"></span>
                        <button class="icon-btn" id="power" title="${esc(_t('card.power'))}" hidden><ha-icon icon="mdi:power"></ha-icon></button>
                      </div>
                      <div class="np-name"><span class="np-num" id="npNum"></span><span id="npName">—</span></div>
                      <div class="np-prog" id="npProg"></div>
                    </div>
                  </div>
                  <div class="progress"><i id="npBar"></i></div>
                  <div class="np-times"><span id="npStart"></span><span id="npLeft"></span><span id="npStop"></span></div>
                  <div class="media-progress" id="mediaProgress" hidden>
                    <span id="mediaCurrent">0:00</span>
                    <input type="range" min="0" max="0" step="1" id="mediaSeek" aria-label="${esc(_t('card.seek'))}" disabled>
                    <span id="mediaDuration">0:00</span>
                  </div>
                  <div class="offline" id="offline" hidden></div>
                  <div class="controls">
                    <button class="ctl nav" id="navPrev" data-cmd="prev" title="${esc(_t('ha.prev'))}" aria-label="${esc(_t('ha.prev'))}"><ha-icon icon="mdi:skip-previous"></ha-icon></button>
                    <button class="ctl main" data-cmd="play_pause" title="${esc(_t('ha.playPause'))}" aria-label="${esc(_t('ha.playPause'))}"><ha-icon id="ppIcon" icon="mdi:play"></ha-icon></button>
                    <button class="ctl nav" id="navNext" data-cmd="next" title="${esc(_t('ha.next'))}" aria-label="${esc(_t('ha.next'))}"><ha-icon icon="mdi:skip-next"></ha-icon></button>
                    <button class="ctl stop" data-cmd="stop" title="${esc(_t('state.stopped'))}" aria-label="${esc(_t('state.stopped'))}"><ha-icon icon="mdi:stop"></ha-icon></button>
                  </div>
                  <div class="arch-row" id="archRow" hidden>
                    <button class="pill secondary" data-arch="start" id="archStart"><ha-icon icon="mdi:skip-backward"></ha-icon>${esc(_t('bar.fromStart'))}</button>
                    <button class="pill secondary" data-arch="back" id="archBack" title="${esc(_t('card.archBack'))}"><ha-icon icon="mdi:rewind-60"></ha-icon></button>
                    <button class="pill secondary" data-arch="fwd" id="archFwd" title="${esc(_t('card.archFwd'))}"><ha-icon icon="mdi:fast-forward-60"></ha-icon></button>
                    <button class="pill secondary" data-arch="live" id="archLive"><ha-icon icon="mdi:record-circle-outline"></ha-icon>${esc(_t('player.live'))}</button>
                    <button class="pill secondary" data-arch="guide" id="archGuide"><ha-icon icon="mdi:history"></ha-icon>${esc(_t('card.archive'))}</button>
                  </div>
                  <div class="arch-panel" id="archPanel" hidden></div>
                  <details class="volume-panel" id="volumePanel">
                    <summary><ha-icon icon="mdi:volume-high"></ha-icon><span class="volume-name">${esc(_t('ha.volume'))}</span>
                    <span class="volume-value"><span id="volVal" class="vol-val">—</span>%</span><ha-icon icon="mdi:chevron-down"></ha-icon></summary>
                    <div class="volume">
                      <button class="icon-btn" id="mute" title="${esc(_t('ha.mute'))}"><ha-icon icon="mdi:volume-high"></ha-icon></button>
                      <input type="range" min="0" max="100" step="1" id="vol" aria-label="${esc(_t('ha.volume'))}">
                    </div>
                  </details>
                  <div class="toast" id="toast" hidden></div>
                </div>
                <div class="fold" id="fold">
                <button class="fold-head" id="foldHead" aria-expanded="false">
                  <span class="fold-icon"><ha-icon icon="mdi:format-list-bulleted-square"></ha-icon></span>
                  <span class="fold-name">${esc(_t('card.channels'))}</span><span class="fold-count" id="foldCount" hidden></span>
                  <span class="fold-now" id="foldNow"></span><ha-icon class="fold-chev" icon="mdi:chevron-down"></ha-icon>
                </button>
                <div class="fold-body"><div class="fold-inner">
                <div class="guide">
                  <div class="playlists" id="playlists" hidden></div>
                  <div id="tvGuide" class="vod">
                    <label class="search">
                      <ha-icon icon="mdi:magnify"></ha-icon>
                      <input id="search" type="search" placeholder="${esc(_t('card.searchChannel'))}" autocomplete="off">
                    </label>
                    <div class="chips ha-scrollbar" id="chips"></div>
                    <form class="pin" id="pin" hidden autocomplete="off">
                      <ha-icon icon="mdi:lock"></ha-icon>
                      <div>${esc(_t('card.groupLocked'))}</div>
                      <div class="pin-row"><input id="pinInput" type="password" inputmode="numeric" maxlength="4" placeholder="PIN" autocomplete="off">
                        <button type="submit" id="pinBtn">${esc(_t('card.unlock'))}</button></div>
                      <div class="pin-msg" id="pinMsg"></div>
                    </form>
                    <div class="grid" id="grid"></div>
                    <div class="empty" id="empty" hidden></div>
                    <div class="sentinel" id="sentinel"></div>
                  </div>
                  <div id="vodGuide" class="vod" hidden>
                    <label class="search">
                      <ha-icon icon="mdi:magnify"></ha-icon>
                      <input id="vodSearch" type="search" placeholder="${esc(_t('card.searchVod'))}" autocomplete="off" enterkeyhint="search">
                    </label>
                    <div class="vod-recent" id="vodRecent" hidden></div>
                    <div class="vod-detail" id="vodDetail" hidden></div>
                    <details class="vod-fav-box" id="vodFav" hidden>
                      <summary>${esc(_t('vod.favorites'))}</summary>
                      <div class="posters" id="vodFavGrid"></div>
                      <div class="empty" id="vodFavEmpty" hidden>${esc(_t('vod.favEmpty'))}</div>
                    </details>
                    <div class="posters" id="vodGrid"></div>
                    <div class="empty" id="vodMsg">${esc(_t('card.vodIntro'))}</div>
                  </div>
                </div>
                </div></div>
                </div>
              </div>
            </ha-card>`;
            this._card = this.$('card');
            this._card.classList.toggle('foldable', !!this._config.collapse_channels);
            this.$('foldHead').addEventListener('click', () => this._toggleFold());

            root.addEventListener('click', (e) => {
                const poster = e.target.closest('[data-vodid]');
                if (poster) return this._openVod(poster.dataset.vodid);
                const recent = e.target.closest('[data-vodrecent]');
                if (recent) {
                    this.$('vodSearch').value = recent.dataset.vodrecent;
                    return this._searchVod(recent.dataset.vodrecent, true);
                }
                const vodAct = e.target.closest('[data-vodplay]');
                if (vodAct) return this._playVod(vodAct.dataset.vodplay, vodAct.dataset.ep, vodAct.dataset.start === '1', vodAct, vodAct.dataset.stream);
                const fav = e.target.closest('[data-vodfav]');
                if (fav) return this._toggleFavorite(fav.dataset.vodfav, fav);
                if (e.target.closest('[data-vodclose]')) { this.$('vodDetail').hidden = true; this._vodDetail = null; return; }
                const arch = e.target.closest('[data-arch]');
                if (arch) return this._archAction(arch.dataset.arch, arch);
                // метка «А7» на плитке — архив этого канала, а не переключение на него
                const badge = e.target.closest('.tile .archive');
                if (badge) return this._openArchive(this._data.channels[+badge.closest('.tile').dataset.i][0]);
                const cmd = e.target.closest('[data-cmd]');
                if (cmd) {
                    return this._command(cmd.dataset.cmd);
                }
                const tile = e.target.closest('.tile');
                if (tile) return this._switchTo(this._data.channels[+tile.dataset.i], tile);
                const chip = e.target.closest('[data-group]');
                if (chip) {
                    this._group = chip.dataset.group;
                    this.$('search').value = '';
                    this._renderList();
                    return;
                }
                const pl = e.target.closest('[data-playlist]');
                if (pl) return this._setPlaylist(pl.dataset.playlist);
                const act = e.target.closest('[data-action]');
                if (act) return this._action(act.dataset.action);
            });
            this.$('mute').addEventListener('click', () => {
                const a = this._attrs();
                this._command(a.muted ? 'unmute' : 'mute');
            });
            this.$('power').addEventListener('click', () => this._action('power'));
            this.$('pin').addEventListener('submit', (e) => { e.preventDefault(); this._checkPin(); });
            const vol = this.$('vol');
            vol.addEventListener('pointerdown', () => { this._volDragging = true; });
            vol.addEventListener('input', () => {
                this._showVolume(vol.value);
                this._sendVolume(vol.value);
            });
            vol.addEventListener('change', () => {
                this._volDragging = false;
                clearTimeout(this._volSendTimer);
                this._volSentTs = Date.now();
                this._command('volume ' + vol.value);   // отпустили — досылаем точное значение
            });
            const seek = this.$('mediaSeek');
            seek.addEventListener('pointerdown', () => { this._seekDragging = true; });
            seek.addEventListener('input', () => {
                this.$('mediaCurrent').textContent = this._seekLabel(Number(seek.value), !!this._attrs().archive);
                this._paintSeek(seek);
            });
            seek.addEventListener('change', () => {
                this._seekDragging = false;
                if (!seek.disabled) this._command('seek_to ' + seek.value);
            });
            let vodTimer = null;
            const vodInput = this.$('vodSearch');
            vodInput.addEventListener('input', () => {
                clearTimeout(vodTimer);
                vodTimer = setTimeout(() => this._searchVod(vodInput.value), 700);
            });
            vodInput.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter') return;
                clearTimeout(vodTimer);
                this._searchVod(vodInput.value, true);
                vodInput.blur();   // на телефоне — спрятать клавиатуру
            });
            this.$('vodGrid').addEventListener('error', (e) => {
                if (e.target.tagName === 'IMG') e.target.replaceWith(Object.assign(document.createElement('ha-icon'), { icon: 'mdi:movie-open-outline' }));
            }, true);
            let searchTimer = null;
            this.$('search').addEventListener('input', () => {
                clearTimeout(searchTimer);
                searchTimer = setTimeout(() => this._renderList(), 200);
            });
            // картинка логотипа не загрузилась — показываем буквы названия
            this.$('grid').addEventListener('error', (e) => {
                if (e.target.tagName !== 'IMG') return;
                const box = e.target.parentElement;
                box.innerHTML = box.dataset.initials || '';
            }, true);
        }

        /** media_player телевизора: из конфига карточки, иначе выбранный на странице аддона. */
        _tvEntity() {
            return this._config.tv_entity || (this._data && this._data.tv && this._data.tv.media_player) || null;
        }

        _attrs() {
            const st = this._lastSt;
            return st ? st.attributes : {};
        }

        _publish(topic, payload) {
            if (!this._hass) return;
            this._hass.callService('mqtt', 'publish', { topic, payload: String(payload) });
        }

        /** HA уже знает, что TV выключен. Плеер при этом ещё ~40 с числится в MQTT «воспроизведение»:
         *  брокер замечает пропажу клиента только по таймауту, — поэтому состоянию TV верим раньше. */
        _tvOff() {
            const tv = this._lastTv;
            return !!this._tvEntity() && !!tv && tv.state !== 'on' && tv.state !== 'unavailable';
        }

        /** Нажали «включить» и ждём, пока TV проснётся (аддон повторяет KEY_POWER до ~40 с). */
        _poweringOn() {
            return !!this._powerOnAt && Date.now() - this._powerOnAt < 45000 && this._tvOff();
        }

        _available() {
            const st = this._lastSt;
            return !!st && st.state !== 'unavailable' && st.state !== 'unknown' && !this._tvOff();
        }

        // показать громкость сразу, до ответа телевизора
        _showVolume(v) {
            const el = this.$('volVal');
            this.$('vol').value = v;
            el.textContent = v;
            this._volHoldUntil = Date.now() + VOL_HOLD_MS;
            el.classList.add('bump');
            clearTimeout(this._volBumpTimer);
            this._volBumpTimer = setTimeout(() => el.classList.remove('bump'), 200);
        }

        // во время перетаскивания шлём не чаще VOL_SEND_MS, но последнее значение уходит обязательно
        _sendVolume(value) {
            clearTimeout(this._volSendTimer);
            const wait = VOL_SEND_MS - (Date.now() - (this._volSentTs || 0));
            if (wait > 0) {
                this._volSendTimer = setTimeout(() => this._sendVolume(value), wait);
                return;
            }
            this._volSentTs = Date.now();
            this._command('volume ' + value);
        }

        _command(cmd) {
            if (!this._available()) return this._toast(_t('card.playerOffTv'));
            this._publish(this._topic + '/command', cmd);
        }

        _switchTo(channel, tile) {
            if (!channel) return;
            // защищённый канал: телевизор примет его только от аддона, который проверил PIN
            if (this._isProtected(channel)) return this._switchProtected(channel, tile);
            if (!this._available()) return this._toast(_t('card.playerOffTv'));
            this._publish(this._topic + '/set_channel', channel[0]);
            this.shadowRoot.querySelectorAll('.tile.pending').forEach(t => t.classList.remove('pending'));
            if (tile) tile.classList.add('pending');
            this._toast(_t('card.switching', { name: channel[0] }));
        }

        // ---------- родительский контроль ----------

        _isProtected(channel) {
            const p = this._data && this._data.parental;
            return !!(p && p.enabled && channel && p.groups.indexOf(channel[1]) >= 0);
        }

        _groupLocked(group) {
            const p = this._data && this._data.parental;
            return !!(p && p.enabled && !this._pin && p.groups.indexOf(group) >= 0);
        }

        /** PIN проверяет аддон; верный — группы открыты до перезагрузки страницы, PIN помним для включения каналов. */
        async _checkPin() {
            const input = this.$('pinInput');
            const pin = input.value.trim();
            const msg = this.$('pinMsg');
            if (!/^\d{4}$/.test(pin)) { msg.textContent = _t('pin.need4'); return; }
            msg.textContent = _t('pin.checking');
            this.$('pinBtn').disabled = true;
            try {
                const r = await this._rpc('iptv/request', { action: 'parental_check', pin }, { timeout: 15000 });
                if (!r.ok) { msg.textContent = r.message || _t('pin.wrong'); input.value = ''; return; }
                this._pin = pin;
                input.value = '';
                msg.textContent = '';
                this._countGroups();
                this._renderList();
            } catch (err) {
                msg.textContent = this._mqttErrorText(err);
            } finally {
                this.$('pinBtn').disabled = false;
            }
        }

        async _switchProtected(channel, tile) {
            if (!this._pin) return this._toast(_t('card.channelLocked'));
            this.shadowRoot.querySelectorAll('.tile.pending').forEach(t => t.classList.remove('pending'));
            if (tile) tile.classList.add('pending');
            this._toast(_t('card.switching', { name: channel[0] }), 60000);
            try {
                const r = await this._rpc('iptv/request', { action: 'channel', query: channel[0], tv: this._tvId, pin: this._pin },
                    { timeout: 90000, idempotent: false });
                if (!r.ok && (r.error === 'wrong_pin' || r.error === 'disabled')) { this._pin = null; this._countGroups(); this._renderList(); }
                this._toast(r.ok ? _t('card.switching', { name: r.channel || channel[0] }) : (r.message || _t('card.failed', { error: r.error })), 4000);
            } catch (err) {
                this._toast(this._mqttErrorText(err), 5000);
            }
        }

        /** Сколько каналов в «Все каналы»: защищённых там нет, пока PIN не введён. */
        _countGroups() {
            if (!this._data || !this._groupCounts) return;
            this._groupCounts.set(ALL_GROUP, this._data.channels.filter(c => !this._groupLocked(c[1])).length);
        }

        _action(name) {
            const tvId = this._tvEntity();
            const tv = this._lastTv;
            if (!tvId || !this._hass) return;
            if (name === 'power') {
                if (tv && tv.state === 'on') {
                    this._powerOnAt = 0;
                    this._hass.callService('media_player', 'turn_off', { entity_id: tvId });
                    this._toast(_t('card.poweringOff'));
                    return;
                }
                if (this._poweringOn()) return this._toast(_t('card.alreadyPowering'));
                // media_player.turn_on у Samsung TV — только Wake-on-LAN, а этот TV (по Wi-Fi) его не слышит.
                // Включает аддон (server.js, tvPowerOn): смотрит PowerState телевизора, шлёт KEY_POWER через
                // HA, ждёт включения и повторяет. KEY_POWER — переключатель, поэтому сама карточка его не шлёт.
                this._publish(this._topic + '/tv/power_on', '1');
                this._powerOnAt = Date.now();
                this._toast(_t('card.poweringOn'));
                this._renderPlayer();
                // «Включаю…» снимается, когда HA увидит TV включённым, либо по таймауту
                clearTimeout(this._powerTimer);
                this._powerTimer = setTimeout(() => this._renderPlayer(), 46000);
            } else if (name === 'launch') {
                // media_player.play_media (app) приложение из режима разработчика молча не запускает —
                // запуск делает аддон через REST-API телевизора (server.js, launchTvApp)
                this._publish(this._topic + '/tv/launch', this._config.app_id);
                this._toast(_t('card.launching'));
            }
        }

        /**
         * Кнопки плейлистов переключают вид карточки: портал — поиск фильмов (на телевизоре ничего не меняется,
         * чтобы не прерывать просмотр), M3U — каналы. Другой M3U (если их несколько) открывается и на TV:
         * каналы в карточке — из того M3U, что открыт на телевизоре.
         */
        _setPlaylist(name) {
            const list = (this._data && this._data.playlists) || [];
            const pl = list.find(p => p.name === name);
            if (!pl) return;
            if (pl.kind === 'vod') {
                const source = pl.src || 'portal';
                const changed = source !== this._vodSource;
                this._vodSource = source;
                this._setMode('vod');
                if (changed) {
                    this._vodResults = null;
                    this._vodQuery = null;
                    this.$('vodGrid').innerHTML = '';
                    this.$('vodMsg').hidden = false;
                    this.$('vodMsg').textContent = _t('card.vodIntro');
                    const query = this.$('vodSearch').value;
                    if (query.trim().length >= 2) this._searchVod(query, true);
                }
                return;
            }
            this._setMode('tv');
            if (name === this._tvPlaylist() || list.filter(p => p.kind === 'tv').length < 2) return;
            if (!this._available()) return this._toast(_t('card.playerOffTv'));
            this._publish(this._topic + '/set_playlist', name);
            this._pendingPlaylist = name;
            this._renderPlaylists();
            this._toast(_t('card.openingPlaylist', { name }));
        }

        // ---------- фильмы и сериалы (поиск — в аддоне, ответы — по MQTT через websocket HA) ----------

        _setMode(mode) {
            this._mode = mode;
            this._renderPlaylists();
            this.$('tvGuide').hidden = mode !== 'tv';
            this.$('vodGuide').hidden = mode !== 'vod';
            if (mode === 'vod') {
                this._renderVodRecent();
                // подписка в брокере включается не мгновенно — оформляем заранее, пока вводят название
                this._renderFavorites();   // подсказку видно сразу, даже если MQTT не поднимется
                this._ensureMqtt()
                    .then(() => this._loadFavorites())
                    .catch(err => { this.$('vodMsg').textContent = this._mqttErrorText(err); });
                if (!this._vodResults) setTimeout(() => this.$('vodSearch').focus(), 50);
            }
        }

        _mqttErrorText(err) {
            const msg = (err && (err.message || err.code)) || String(err);
            return /unauthorized|admin/i.test(msg)
                ? _t('card.adminOnly')
                : _t('card.mqttError', { error: msg });
        }

        /** Ответы аддона: iptv/vod/search/result, iptv/vod/details/result, iptv/request/result — по request_id. */
        _ensureMqtt() {
            if (this._mqttReady) return this._mqttReady;
            if (!this._hass) return Promise.reject(new Error('нет hass'));
            this._pending = this._pending || new Map();
            const topics = ['iptv/vod/search/result', 'iptv/vod/details/result', 'iptv/request/result', 'iptv/card/request/result'];
            const onMsg = (m) => {
                let p;
                try { p = JSON.parse(m.payload); } catch (e) { return; }
                const w = p && this._pending.get(p.request_id);
                if (!w) return;
                this._pending.delete(p.request_id);
                clearTimeout(w.timer);
                clearTimeout(w.retry);
                w.resolve(p);
            };
            this._mqttReady = Promise.all(topics.map(topic =>
                this._hass.connection.subscribeMessage(onMsg, { type: 'mqtt/subscribe', topic })))
                .then(unsubs => { this._mqttUnsubs = unsubs; return new Promise(r => setTimeout(r, 700)); })
                .catch(err => { this._mqttReady = null; throw err; });
            return this._mqttReady;
        }

        _unsubscribeMqtt() {
            (this._mqttUnsubs || []).forEach(u => { try { u(); } catch (e) { /* соединение уже закрыто */ } });
            this._mqttUnsubs = null;
            this._mqttReady = null;
        }

        /** Запрос аддону с ожиданием ответа. idempotent — можно повторить, если ответ не пришёл (поиск, детали). */
        async _rpc(topic, body, { timeout = 20000, idempotent = true } = {}) {
            await this._ensureMqtt();
            const id = 'card-' + Math.random().toString(36).slice(2, 10);
            const payload = JSON.stringify(Object.assign({ request_id: id }, body));
            const send = () => this._hass.callService('mqtt', 'publish', { topic, payload });
            return new Promise((resolve, reject) => {
                const w = { resolve };
                w.timer = setTimeout(() => { this._pending.delete(id); clearTimeout(w.retry); reject(new Error(_t('card.addonTimeout'))); }, timeout);
                // самый первый запрос может уйти раньше, чем брокер оформил подписку HA — ответ потеряется
                if (idempotent) w.retry = setTimeout(send, 4000);
                this._pending.set(id, w);
                send();
            });
        }

        async _searchVod(text, force) {
            const q = String(text || '').trim();
            const msg = this.$('vodMsg');
            if (q.length < 2) {
                if (!q) {
                    this.$('vodGrid').innerHTML = ''; this._vodResults = null; this._vodQuery = null;
                    msg.hidden = false; msg.textContent = _t('card.vodIntro');
                    this._renderFavorites();   // поиск очистили — избранное снова видно
                }
                return;
            }
            if (q === this._vodQuery && !force) return;
            this._rememberVodSearch(q);
            this._vodQuery = q;
            const source = this._vodSource || 'portal';
            this._renderFavorites();
            msg.hidden = false;
            msg.textContent = _t('card.searching', { query: q });
            try {
                const r = await this._rpc('iptv/vod/search', { query: q, limit: 30, src: source });
                if (q !== this._vodQuery || source !== (this._vodSource || 'portal')) return;
                if (!r.ok) throw new Error(r.error === 'no_portal' ? _t('assist.noPortal') : r.error);
                this._vodResults = r.results;
                this.$('vodGrid').innerHTML = r.results.map(x => `<button class="poster" data-vodid="${esc(vodId(x))}" title="${esc(x.title)}">
                    <div class="pic">${x.poster ? `<img src="${esc(x.poster)}" alt="" loading="lazy">` : '<ha-icon icon="mdi:movie-open-outline"></ha-icon>'}
                      ${x.kind === 'series' || x.quality ? `<span class="badge">${esc(x.kind === 'series' ? _t('vod.series') : x.quality)}</span>` : ''}</div>
                    <div class="p-title">${esc(x.title)}</div><div class="p-meta">${esc(x.year || '')}</div></button>`).join('');
                msg.hidden = r.results.length > 0;
                msg.textContent = _t('vod.nothingFound');
            } catch (err) {
                if (q !== this._vodQuery || source !== (this._vodSource || 'portal')) return;
                this._vodQuery = null;
                msg.textContent = /MQTT|admin|unauthorized/i.test(err.message) ? this._mqttErrorText(err) : _t('card.searchFailed', { error: err.message });
            }
        }

        _vodRecentKey() { return 'tizen-iptv-vod-searches:' + (this._tvId || 'default'); }

        _getVodRecent() {
            if (this._vodRecent) return this._vodRecent;
            try {
                const saved = JSON.parse(localStorage.getItem(this._vodRecentKey()) || '[]');
                this._vodRecent = Array.isArray(saved) ? saved.filter(x => typeof x === 'string' && x.trim()).slice(0, 5) : [];
            } catch (e) { this._vodRecent = []; }
            return this._vodRecent;
        }

        _rememberVodSearch(query) {
            const recent = this._getVodRecent();
            this._vodRecent = [query].concat(recent.filter(x => x.toLocaleLowerCase() !== query.toLocaleLowerCase())).slice(0, 5);
            try { localStorage.setItem(this._vodRecentKey(), JSON.stringify(this._vodRecent)); } catch (e) { /* storage недоступен */ }
            this._renderVodRecent();
        }

        _renderVodRecent() {
            const box = this.$('vodRecent');
            if (!box) return;
            const items = this._getVodRecent();
            box.innerHTML = items.map(q => `<button type="button" data-vodrecent="${esc(q)}" title="${esc(q)}">${esc(q)}</button>`).join('');
            box.hidden = !items.length;
        }

        // ───── избранное (общее на все телевизоры, живёт в аддоне: favorites.js) ─────

        _isFavorite(id) {
            return id != null && (this._favorites || []).some(x => vodId(x) === String(id));
        }

        async _loadFavorites() {
            try {
                const r = await this._rpc('iptv/request', { action: 'favorites' });
                this._favorites = (r && r.items) || [];
            } catch (err) {
                this._favorites = this._favorites || [];   // не смогли — показываем что было
            }
            this._renderFavorites();
        }

        /**
         * Лента избранного — прячется только пока ищут: под результатами поиска она мешает.
         * Пустую показываем с подсказкой (как на телевизоре) — иначе о функции никто не узнает.
         */
        _renderFavorites() {
            const box = this.$('vodFav');
            const items = this._favorites || [];
            box.hidden = !!this._vodQuery;
            this.$('vodFavEmpty').hidden = items.length > 0;
            if (box.hidden) return;
            this.$('vodFavGrid').innerHTML = items.map(x => {
                const pic = x.posterLocal || x.poster;
                const fallback = x.posterLocal && x.poster && !/^\/local\//.test(x.poster) && x.posterLocal !== x.poster ? x.poster : '';
                return `<button class="poster" data-vodid="${esc(vodId(x))}" title="${esc(x.title)}">
                    <div class="pic">${pic ? `<img src="${esc(pic)}"${fallback ? ` data-fallback="${esc(fallback)}"` : ''} alt="" loading="lazy">` : '<ha-icon icon="mdi:movie-open-outline"></ha-icon>'}
                      ${x.kind === 'series' || x.quality ? `<span class="badge">${esc(x.kind === 'series' ? _t('vod.series') : x.quality)}</span>` : ''}</div>
                    <div class="p-title">${esc(x.title)}</div><div class="p-meta">${esc(x.year || '')}</div></button>`;
            }).join('');
            this.$('vodFavGrid').querySelectorAll('img[data-fallback]').forEach(img => {
                img.addEventListener('error', () => {
                    const fallback = img.dataset.fallback;
                    if (fallback) {
                        delete img.dataset.fallback;
                        img.src = fallback;
                    } else {
                        img.remove();
                    }
                });
            });
        }

        async _toggleFavorite(id, btn) {
            if (btn) { if (btn.disabled) return; btn.disabled = true; }
            const known = (this._vodResults || []).concat(this._favorites || []).find(x => vodId(x) === String(id)) || {};
            const item = this._vodItem && vodId(this._vodItem) === String(id) ? this._vodItem : known;
            try {
                const r = await this._rpc('iptv/request', {
                    action: 'favorite', id, title: item.title || '', year: item.year || null,
                    kind: item.kind || 'movie', poster: item.poster || null, quality: item.quality || ''
                }, { idempotent: false });
                if (!r || !r.ok) throw new Error((r && r.error) || 'failed');
                this._favorites = r.items || [];
                this._renderFavorites();
                if (this._vodDetail === id && this._vodItem) this.$('vodDetail').innerHTML = this._vodDetailHtml(this._vodItem, this._vodItem.episodes || []);
                this._toast(r.message || '', 3000);
            } catch (err) {
                this._toast(_t('vod.favFailed', { error: err.message }), 5000);
            } finally {
                if (btn) btn.disabled = false;
            }
        }

        async _openVod(id) {
            const box = this.$('vodDetail');
            const brief = (this._vodResults || []).concat(this._favorites || [])
                .find(x => vodId(x) === String(id)) || { id, title: '' };
            this._vodDetail = id;
            this._vodItem = null;
            box.hidden = false;
            box.innerHTML = this._vodDetailHtml(brief, null);
            box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            try {
                const r = await this._rpc('iptv/vod/details', { id });
                if (this._vodDetail !== id) return;
                if (!r.ok) throw new Error(r.error);
                this._vodItem = r.item;
                box.innerHTML = this._vodDetailHtml(r.item, r.item.episodes);
            } catch (err) {
                if (this._vodDetail === id) box.querySelector('.d-desc').textContent = _t('common.loadFailed', { error: err.message });
            }
        }

        _vodDetailHtml(item, episodes) {
            const loading = !episodes;
            const series = item.kind === 'series' || (episodes && episodes.length > 0);
            const dur = item.duration && !series ? (item.duration >= 60 ? _t('common.hoursShort', { n: Math.floor(item.duration / 60) }) + ' ' + _t('common.minutes', { n: item.duration % 60 }) : _t('common.minutes', { n: item.duration })) : '';
            const meta = [item.year, series ? (episodes ? _t('vod.seriesEpisodes', { n: episodes.length }) : _t('vod.seriesLower')) : dur,
                (item.genres || []).slice(0, 3).join(', '), item.quality, item.agelimit ? item.agelimit + '+' : '']
                .filter(Boolean).join(' · ');
            // рейтинги (аддон кладёт их в details; ключа нет — поля нет, строка как раньше).
            // Кинопоиск первым и ярче, TMDB рядом приглушён — как в карточке фильма на телевизоре.
            const badge = (v, label, dim) => v ? `<span class="d-rating${dim ? ' dim' : ''}">★ ${v.toFixed(1)}<i>${esc(label)}</i></span>` : '';
            const rating = badge(item.kpRating, _t('vod.kpShort'), false) + badge(item.rating, 'TMDB', !!item.kpRating);
            const fid = esc(vodId(item));
            const on = this._isFavorite(vodId(item));
            const favBtn = loading ? '' :
                `<button class="pill secondary fav-btn${on ? ' on' : ''}" data-vodfav="${fid}">${on ? '♥ ' : '♡ '}${esc(_t(on ? 'vod.favRemove' : 'vod.favAdd'))}</button>`;
            // несколько озвучек одного фильма — кнопка на каждую; у портала озвучка одна и streams пустой
            const streams = (item.streams || []).filter(s => s.name);
            const watch = streams.length > 1
                ? streams.map(s => `<button class="pill" data-vodplay="${fid}" data-stream="${esc(s.id)}">▶ ${esc(s.name)}</button>`).join('')
                : `<button class="pill" data-vodplay="${fid}">▶ ${esc(_t('card.watchOnTv'))}</button>`;
            const buttons = loading ? '' : series
                ? `${watch}${favBtn}`
                : `${watch}<button class="pill secondary" data-vodplay="${fid}" data-start="1">${esc(_t('vod.fromStart'))}</button>${favBtn}`;
            const eps = episodes && episodes.length
                ? `<div class="d-meta">${esc(_t('card.episodeHint'))}</div>
                   <div class="episodes">${episodes.map(e => `<button data-vodplay="${fid}" data-ep="${esc(vodId(e))}">${esc(e.title)}</button>`).join('')}</div>`
                : '';
            return `<div class="d-pic">${item.poster ? `<img src="${esc(item.poster)}" alt="">` : ''}</div>
                <div class="d-body">
                  <div class="d-title">${esc(item.title || _t('common.loading'))}</div>
                  <div class="d-meta">${rating}${esc(meta)}</div>
                  <div class="d-desc">${loading ? esc(_t('common.loading')) : esc(item.description || '')}</div>
                  <div class="d-btns">${buttons}</div>${eps}
                </div>
                <button class="icon-btn d-close" data-vodclose="1" title="${esc(_t('map.close'))}"><ha-icon icon="mdi:close"></ha-icon></button>`;
        }

        /** Включить на этом TV. Аддон сам включит телевизор и запустит плеер, если нужно. */
        async _playVod(id, episodeId, fromStart, btn, stream) {
            if (btn) { if (btn.disabled) return; btn.disabled = true; btn.classList.add('busy'); }
            const needStart = !this._available();
            this._toast(_t(needStart ? 'card.startingTv' : 'card.sending'), 150000);
            try {
                // query — запасной путь аддона: идентификаторы портала не вечны, избранное живёт дольше
                const known = (this._vodResults || []).concat(this._favorites || []).find(x => vodId(x) === String(id));
                const r = await this._rpc('iptv/request', {
                    action: 'vod_play', tv: this._tvId, id, query: (known && known.title) || undefined,
                    episode_fid: episodeId || undefined, from_start: !!fromStart,
                    stream: stream || undefined   // выбранная озвучка, когда их несколько

                }, { timeout: 150000, idempotent: false });
                this._toast(r.ok ? _t('card.playingVod', { title: r.title || '' }) : (r.message || _t('card.failed', { error: r.error })), 5000);
            } catch (err) {
                this._toast(_t('card.failed', { error: err.message }), 5000);
            } finally {
                if (btn) { btn.disabled = false; btn.classList.remove('busy'); }
            }
        }

        /** M3U, из которого каналы в карточке (на TV в это время может быть открыт портал). */
        _tvPlaylist() {
            const list = (this._data && this._data.playlists) || [];
            return (this._data && this._data.tv_playlist) || (list.find(p => p.kind === 'tv') || {}).name;
        }

        /** Строка плейлистов: подсвечен вид карточки — портал или M3U, из которого показаны каналы. */
        _renderPlaylists() {
            const box = this.$('playlists');
            const list = (this._data && this._data.playlists) || [];
            box.hidden = list.length < 2;
            if (box.hidden) return;
            const vodSources = list.filter(p => p.kind === 'vod');
            if (!this._vodSource && vodSources.length) this._vodSource = vodSources[0].src || 'portal';
            const selectedVod = vodSources.find(p => (p.src || 'portal') === this._vodSource) || vodSources[0];
            const cur = this._mode === 'vod' ? (selectedVod || {}).name : this._tvPlaylist();
            box.innerHTML = list.map(p => {
                const cls = (p.name === cur ? 'active' : '') + (p.name === this._pendingPlaylist && p.name !== cur ? ' pending' : '');
                const icon = p.kind === 'vod' ? 'mdi:movie-open-outline' : 'mdi:television-classic';
                return `<button data-playlist="${esc(p.name)}" class="${cls}"><ha-icon icon="${icon}"></ha-icon>${esc(p.name)}</button>`;
            }).join('');
        }

        _toast(text, ms = 2500) {
            const el = this.$('toast');
            el.textContent = text;
            el.title = text;
            el.hidden = false;
            clearTimeout(this._toastTimer);
            this._toastTimer = setTimeout(() => { el.hidden = true; }, ms);
        }

        // ---------- архив ----------

        /** Дней архива у канала по имени (0 — архива нет). */
        _archDays(name) {
            const c = name && this._data ? this._data.channels.find(x => x[0] === name) : null;
            return c ? c[4] || 0 : 0;
        }

        /** Кнопки строки архива: с начала, ∓1 мин, эфир — прямо телевизору; «Архив» — список передач из аддона. */
        _archAction(name, el) {
            if (name === 'close') { this.$('archPanel').hidden = true; this._arch = null; return; }
            if (name === 'play') return this._playArchive(+el.dataset.start, el);
            if (name === 'guide') {
                if (this._arch && !this.$('archPanel').hidden) { this.$('archPanel').hidden = true; this._arch = null; return; }
                return this._openArchive(this._curChannel);
            }
            if (name === 'start') { this._command('from_start'); return this._toast(_t('card.fromStart')); }
            if (name === 'live') { this._command('live'); return this._toast(_t('player.live')); }
            if (name === 'back') return this._command('seek -60');
            if (name === 'fwd') return this._command('seek 60');
        }

        /** Список передач канала за дни архива (аддон: action archive_guide) — свежие сверху. */
        async _openArchive(channel) {
            if (!channel) return;
            const panel = this.$('archPanel');
            const c = this._data.channels.find(x => x[0] === channel);
            if (c && this._isProtected(c) && !this._pin) return this._toast(_t('card.channelLocked'));
            this._arch = { channel, list: null };
            panel.hidden = false;
            panel.innerHTML = `<div class="arch-head"><b>${esc(channel)}</b><span class="spacer"></span>
                <button class="icon-btn" data-arch="close"><ha-icon icon="mdi:close"></ha-icon></button></div>
                <div class="arch-msg">${esc(_t('epg.loadingArchive'))}</div>`;
            try {
                const r = await this._rpc('iptv/card/request', { action: 'archive_guide', query: channel, tv: this._tvId, pin: this._pin || undefined });
                if (!this._arch || this._arch.channel !== channel) return;   // уже открыли другой или закрыли
                if (!r.ok) throw new Error(r.message || r.error);
                this._arch.list = r.programmes || [];
                this._arch.days = r.days;
                this._renderArchive();
            } catch (err) {
                if (!this._arch || this._arch.channel !== channel) return;
                panel.querySelector('.arch-msg').textContent = /unauthorized|admin/i.test(err.message || '') ? this._mqttErrorText(err) : (err.message || String(err));
            }
        }

        _renderArchive() {
            const panel = this.$('archPanel');
            const a = this._arch;
            if (!a || !a.list) return;
            const now = Date.now() / 1000;
            let day = '';
            let html = '';
            // свежие сверху: чаще всего ищут то, что шло только что или вчера вечером
            for (let i = a.list.length - 1; i >= 0; i--) {
                const [start, stop, title] = a.list[i];
                const d = new Date(start * 1000).toLocaleDateString(I18n.locale(), { weekday: 'long', day: 'numeric', month: 'long' });
                if (d !== day) { day = d; html += `<div class="arch-day">${esc(d)}</div>`; }
                const live = start <= now && now < stop;
                html += `<button class="arch-item${live ? ' live' : ''}" data-arch="play" data-start="${start}">
                    <span class="arch-time">${hhmm(start)}</span><span class="arch-title">${esc(title)}</span>
                    ${live ? `<span class="arch-now">${esc(_t('card.archNow'))}</span>` : ''}</button>`;
            }
            panel.innerHTML = `<div class="arch-head"><b>${esc(a.channel)}</b><span class="arch-sub">${esc(_t('card.archiveDays', { days: a.days || 0 }))}</span>
                <span class="spacer"></span><button class="icon-btn" data-arch="close"><ha-icon icon="mdi:close"></ha-icon></button></div>
                ${html ? `<div class="arch-list ha-scrollbar">${html}</div>` : `<div class="arch-msg">${esc(_t(a.days ? 'epg.empty' : 'card.archNone'))}</div>`}`;
        }

        /** Включить запись передачи на телевизоре (аддон включит TV и плеер, если надо). */
        async _playArchive(start, btn) {
            const a = this._arch;
            if (!a || !start) return;
            if (btn) btn.classList.add('pending');
            this._toast(_t(this._available() ? 'card.sending' : 'card.startingTv'), 90000);
            try {
                const r = await this._rpc('iptv/card/request', { action: 'archive', query: a.channel, start, tv: this._tvId, pin: this._pin || undefined },
                    { timeout: 90000, idempotent: false });
                this._toast(r.message || (r.ok ? _t('assist.done') : _t('card.failed', { error: r.error })), 4000);
            } catch (err) {
                this._toast(this._mqttErrorText(err), 5000);
            } finally {
                if (btn) btn.classList.remove('pending');
            }
        }

        // ---------- сейчас играет ----------

        _renderPlayer() {
            if (!this.shadowRoot) return;
            const st = this._lastSt;
            const a = this._attrs();
            const available = this._available();
            const state = this._poweringOn() ? 'powering' : this._tvOff() ? 'tv_off'
                : !st ? 'unknown' : (available ? st.state : 'unavailable');
            this._card.classList.toggle('disabled', !available);

            const chip = this.$('chip');
            chip.className = 'chip ' + state;
            chip.textContent = STATE_KEYS[state] ? _t(STATE_KEYS[state]) : state;

            // плейлист на TV сменился — через несколько секунд аддон перепишет список каналов этого TV
            if (a.playlist !== this._curPlaylist) {
                if (this._curPlaylist !== undefined && a.playlist) {
                    clearTimeout(this._plReload);
                    this._plReload = setTimeout(() => this._loadData(), 6000);
                }
                this._curPlaylist = a.playlist;
                if (a.playlist === this._pendingPlaylist) this._pendingPlaylist = null;
                this._renderPlaylists();
            }
            const channelChanged = a.channel !== this._curChannel;
            this._curChannel = a.channel || null;
            const vod = !!a.vod_title;
            const isSeries = vod && !!a.vod_is_series;
            this.$('npName').textContent = vod ? a.vod_title : a.channel || '—';
            this.$('npNum').textContent = !vod && a.number ? a.number : '';
            this.$('npProg').textContent = vod ? _t('card.vodFromPortal') : a.programme || (a.channel ? _t('card.noGuide') : '');
            const navPrev = this.$('navPrev'), navNext = this.$('navNext');
            const previousTitle = _t(isSeries ? 'ha.prevEpisode' : 'ha.prev');
            const nextTitle = _t(isSeries ? 'ha.nextEpisode' : 'ha.next');
            navPrev.dataset.cmd = isSeries ? 'prev_episode' : 'prev';
            navNext.dataset.cmd = isSeries ? 'next_episode' : 'next';
            navPrev.title = previousTitle;
            navPrev.setAttribute('aria-label', previousTitle);
            navNext.title = nextTitle;
            navNext.setAttribute('aria-label', nextTitle);
            const episodeIndex = a.vod_episode_index;
            const episodeCount = a.vod_episode_count;
            const validEpisode = Number.isInteger(episodeIndex) && Number.isInteger(episodeCount)
                && episodeCount > 0 && episodeIndex >= 0 && episodeIndex < episodeCount;
            const canNavigate = !vod || isSeries;
            navPrev.disabled = !available || !canNavigate || (isSeries ? !validEpisode || episodeIndex === 0 : !a.channel);
            navNext.disabled = !available || !canNavigate || (isSeries ? !validEpisode || episodeIndex >= episodeCount - 1 : !a.channel);

            // строка архива: у канала есть архив — «С начала» и «Архив»; идёт запись — ещё ∓1 мин и «Эфир»
            const archDays = vod ? 0 : this._archDays(a.channel);
            const inArchive = !vod && !!a.archive;
            this.$('archRow').hidden = !(archDays || inArchive);
            this.$('archStart').disabled = this.$('archBack').disabled = this.$('archFwd').disabled = this.$('archLive').disabled = !available;
            this.$('archBack').hidden = this.$('archFwd').hidden = this.$('archLive').hidden = !inArchive;

            const logo = vod ? '' : httpsLogo(a.logo) || this._logoFor(a.channel);
            const box = this.$('npLogo');
            const logoKey = vod ? 'vod' : logo;
            if (logoKey !== this._npLogo) {
                this._npLogo = logoKey;
                box.innerHTML = logo
                    ? `<img src="${esc(logo)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('ha-icon'),{icon:'mdi:television-classic'}))">`
                    : `<ha-icon icon="${vod ? 'mdi:movie-open-outline' : 'mdi:television-classic'}"></ha-icon>`;
            }

            this.$('ppIcon').setAttribute('icon', state === 'playing' || state === 'buffering' ? 'mdi:pause' : 'mdi:play');
            const mute = this.$('mute');
            mute.classList.toggle('on', !!a.muted);
            mute.querySelector('ha-icon').setAttribute('icon', a.muted ? 'mdi:volume-off' : 'mdi:volume-high');
            if (!this._volDragging && Date.now() > (this._volHoldUntil || 0) && typeof a.volume === 'number') {
                this.$('vol').value = a.volume;
                this.$('volVal').textContent = a.volume;
            }

            const tv = this._lastTv;
            const power = this.$('power');
            power.hidden = !this._tvEntity();
            power.classList.toggle('on', !!tv && tv.state !== 'on');

            const off = this.$('offline');
            if (available) {
                off.hidden = true;
            } else {
                off.hidden = false;
                const tvOn = tv && tv.state === 'on';
                const powering = this._poweringOn();
                let btn = '';
                if (this._tvEntity()) {
                    btn = tvOn
                        ? `<button class="pill" data-action="launch">${esc(_t('card.openPlayer'))}</button>`
                        : powering
                            ? `<button class="pill busy" disabled>${esc(_t('card.poweringShort'))}</button>`
                            : `<button class="pill" data-action="power">${esc(_t('card.powerOn'))}</button>`;
                }
                off.innerHTML = `<ha-icon icon="mdi:television-off"></ha-icon><span>${this._tvEntity() && !tvOn
                    ? esc(_t(powering ? 'card.poweringLong' : 'card.tvOff'))
                    : esc(_t('card.playerOffTv'))}</span><span class="spacer"></span>${btn}`;
            }

            this._renderProgress();
            if (channelChanged) {
                this.shadowRoot.querySelectorAll('.tile.pending').forEach(t => t.classList.remove('pending'));
                if (this._data && !this._group) this._group = this._groupOf(this._curChannel);
                this._markActive();
            }
        }

        _seekLabel(seconds, archive) {
            if (archive) return hhmm(seconds);
            const s = Math.max(0, Math.floor(seconds || 0));
            const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60;
            return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
        }

        _paintSeek(input) {
            const min = Number(input.min || 0), max = Number(input.max || 0);
            const value = Number(input.value || 0);
            const percent = max > min ? Math.max(0, Math.min(100, (value - min) * 100 / (max - min))) : 0;
            input.style.background = `linear-gradient(to right, var(--primary-color) ${percent}%, var(--divider-color, rgba(0,0,0,.18)) ${percent}%)`;
        }

        _renderProgress() {
            const a = this._attrs();
            const bar = this.$('npBar');
            const vod = !!a.vod_title;
            const archive = !!a.archive;
            const mediaProgress = this.$('mediaProgress');
            const seek = this.$('mediaSeek');
            const start = Number(a.programme_start || 0);
            const stop = Number(a.programme_stop || 0);
            const nowSec = Math.floor(Date.now() / 1000);
            const archiveDays = this._archDays(a.channel);
            const archiveMin = archive && start > 0 && archiveDays > 0
                ? Math.max(start, nowSec - archiveDays * 86400 + 60) : start;
            const archiveMax = Math.min(stop, nowSec - 60);
            const archiveSeek = archive && archiveMin > 0 && archiveMax > archiveMin;
            const position = vod ? Number(a.vod_position || 0) : Number(a.archive_position || 0);
            const rangeMin = archiveSeek && !vod ? archiveMin : 0;
            const rangeMax = archiveSeek && !vod ? archiveMax : Math.max(0, Number(a.vod_duration || 0));
            const interactive = !!a.seekable && rangeMax > rangeMin;
            const hasVodTimeline = vod && Number(a.vod_duration || 0) > 0;
            mediaProgress.hidden = !hasVodTimeline && !archiveSeek;
            seek.disabled = !interactive || !this._available();
            seek.min = rangeMin;
            seek.max = rangeMax;
            if (!this._seekDragging) seek.value = Math.max(Number(seek.min), Math.min(Number(seek.max), position));
            this.$('mediaCurrent').textContent = this._seekLabel(this._seekDragging ? Number(seek.value) : position, archive && !vod);
            this.$('mediaDuration').textContent = archive && !vod ? hhmm(archiveMax) : this._seekLabel(Number(a.vod_duration || 0), false);
            this._paintSeek(seek);
            this.$('npStart').parentElement.hidden = vod || archiveSeek;
            this.$('npStart').parentElement.previousElementSibling.hidden = vod || archiveSeek;
            if (!vod && !archiveSeek && a.programme_start && a.programme_stop) {
                // запись из архива: «сейчас» — это момент записи (телевизор шлёт его с точностью до минуты)
                const now = a.archive && a.archive_time ? a.archive_time : Date.now() / 1000;
                const p = Math.max(0, Math.min(1, (now - a.programme_start) / (a.programme_stop - a.programme_start)));
                bar.style.width = (p * 100).toFixed(1) + '%';
                this.$('npStart').textContent = hhmm(a.programme_start);
                this.$('npStop').textContent = hhmm(a.programme_stop);
                const left = Math.max(0, Math.round((a.programme_stop - now) / 60));
                this.$('npLeft').textContent = a.archive && a.archive_time ? _t('timeline.archive', { time: hhmm(a.archive_time) })
                    : left ? _t('card.left', { n: left }) : '';
            } else if (vod || archiveSeek) {
                bar.style.width = '0';
                this.$('npStart').textContent = this.$('npStop').textContent = this.$('npLeft').textContent = '';
            } else {
                bar.style.width = '0';
                this.$('npStart').textContent = this.$('npStop').textContent = this.$('npLeft').textContent = '';
            }
        }

        // ---------- плейлист ----------

        async _loadData() {
            if (!this._tvId) {
                this.$('empty').hidden = false;
                this.$('empty').textContent = _t('card.noTvId');
                return;
            }
            try {
                const res = await fetch(this._config.data_url + '?t=' + Date.now(), { cache: 'no-store' });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const data = await res.json();
                this._data = data;
                // до пересчёта hass ниже: _renderPlayer ищет логотип и группу канала по имени
                this._byName = new Map(data.channels.map((c, i) => [c[0], i]));
                // media_player мог прийти только с данными — переоценить питание
                if (this._hass && !this._config.tv_entity) { this._lastTv = undefined; this.hass = this._hass; }
                this._loadedAt = Date.now();
                this.$('foldCount').textContent = data.channels.length;
                this.$('foldCount').hidden = !data.channels.length;
                // группы как на TV (ChannelStore.groupsOf): в конце «Без группы» (если есть) и всегда «Все каналы»;
                // в плейлисте без групп — только «Все каналы»
                this._groups = [];
                const seen = new Map();
                let ungrouped = 0;
                data.channels.forEach(c => {
                    const g = c[1] || NO_GROUP;
                    if (g === NO_GROUP) { ungrouped++; return; }
                    if (g === ALL_GROUP) return;
                    if (!seen.has(g)) { seen.set(g, 0); this._groups.push(g); }
                    seen.set(g, seen.get(g) + 1);
                });
                if (ungrouped && this._groups.length) { this._groups.push(NO_GROUP); seen.set(NO_GROUP, ungrouped); }
                this._groups.push(ALL_GROUP);
                this._groupCounts = seen;
                this._countGroups();
                this._analyzed = null;   // поиск пересчитает при первом запросе
                if (!this._group || !seen.has(this._group)) this._group = this._groupOf(this._curChannel) || this._groups[0];
                this._renderList();
                this._renderPlaylists();
                if (this._mode === 'vod' && !(data.playlists || []).some(p => p.kind === 'vod')) this._setMode('tv');
                const title = this._config.title || (data.tv && data.tv.name) || '';
                this.$('title').textContent = title;
                this.$('title').hidden = !title;
                if (!this._npLogo) { this._npLogo = undefined; this._renderPlayer(); }
            } catch (err) {
                this.$('empty').hidden = false;
                this.$('empty').textContent = _t('card.dataFailed', { error: err.message });
            }
        }

        _groupOf(name) {
            if (!this._data || !name || !this._byName.has(name)) return null;
            const g = this._data.channels[this._byName.get(name)][1] || NO_GROUP;
            return this._groupCounts && this._groupCounts.has(g) && g !== ALL_GROUP ? g : ALL_GROUP;
        }

        _logoFor(name) {
            if (!this._data || !name || !this._byName.has(name)) return '';
            return this._data.channels[this._byName.get(name)][2];
        }

        _renderChips() {
            const q = this.$('search').value.trim();
            const p = this._data && this._data.parental;
            const lock = g => (p && p.enabled && p.groups.indexOf(g) >= 0 ? `<ha-icon icon="mdi:${this._pin ? 'lock-open-variant' : 'lock'}"></ha-icon>` : '');
            this.$('chips').innerHTML = this._groups.map(g =>
                `<button data-group="${esc(g)}" class="${!q && g === this._group ? 'active' : ''}">${lock(g)}${esc(groupLabel(g))}<small>${this._groupCounts.get(g)}</small></button>`
            ).join('');
            this.$('foldNow').textContent = q ? '' : groupLabel(this._group);
            // в свёрнутом списке не прокручивать: scrollIntoView сдвинул бы страницу к карточке
            if (this._card.classList.contains('foldable') && !this.$('fold').classList.contains('open')) return;
            const active = this.$('chips').querySelector('.active');
            if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest', inline: 'center' });
        }

        /** collapse_channels: раскрыть/свернуть список; при раскрытии — догрузка плиток и активная группа в виду. */
        _toggleFold() {
            const fold = this.$('fold');
            const open = !fold.classList.contains('open');
            fold.classList.toggle('open', open);
            this.$('foldHead').setAttribute('aria-expanded', String(open));
            if (!open) return;
            if (this._io) {
                const s = this.$('sentinel');
                this._io.unobserve(s);
                this._io.observe(s);
            }
            const active = this.$('chips').querySelector('.active');
            if (active) this.$('chips').scrollLeft = active.offsetLeft - (this.$('chips').clientWidth - active.offsetWidth) / 2;
        }

        /** Индексы каналов для показа: группа или результаты поиска. */
        _computeList() {
            const q = this.$('search').value.trim();
            const all = this._data.channels;
            if (!q) {
                if (this._groupLocked(this._group)) return [];
                return all.map((c, i) => i).filter(i => (this._group === ALL_GROUP && !this._groupLocked(all[i][1])) || (all[i][1] || NO_GROUP) === this._group);
            }

            // сначала — простое вхождение подстроки, затем «похожие» через тот же ChannelMatch, что на TV
            const nq = norm(q);
            const direct = [];
            all.forEach((c, i) => { if (norm(c[0]).includes(nq)) direct.push(i); });
            const fuzzy = [];
            if (typeof ChannelMatch !== 'undefined' && nq.length >= 2) {
                if (!this._analyzed) this._analyzed = all.map(c => ChannelMatch.analyze(c[0], true));
                const qa = ChannelMatch.analyze(q, false);
                const inDirect = new Set(direct);
                all.forEach((c, i) => {
                    if (inDirect.has(i)) return;
                    const s = ChannelMatch.score(qa, this._analyzed[i]);
                    if (s >= 0.62) fuzzy.push([i, s]);
                });
                fuzzy.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
            }
            // защищённые каналы в поиске — только после PIN
            return direct.concat(fuzzy.slice(0, 60).map(x => x[0])).filter(i => !this._groupLocked(all[i][1]));
        }

        _renderList() {
            if (!this._data) return;
            const q = this.$('search').value.trim();
            this._renderChips();   // при поиске ни одна группа не подсвечена
            this._list = this._computeList();
            this._shown = 0;
            this.$('grid').innerHTML = '';
            const empty = this.$('empty');
            const locked = !q && this._groupLocked(this._group);
            this.$('pin').hidden = !locked;
            empty.hidden = this._list.length > 0 || locked;
            empty.textContent = _t(q ? 'vod.nothingFound' : 'home.groupEmpty');
            this._renderMore();
        }

        _renderMore() {
            if (!this._list || this._shown >= this._list.length) return;
            const part = this._list.slice(this._shown, this._shown + PAGE);
            this.$('grid').insertAdjacentHTML('beforeend', part.map(i => this._tileHtml(i)).join(''));
            this._shown += part.length;
            // IntersectionObserver сообщает только о СМЕНЕ видимости: если после порции плиток низ
            // списка всё ещё в зоне догрузки, нового события не будет и список «застрянет» на 60
            // плитках (так и было в HA). Переподписка заставляет его заново прислать текущее состояние.
            if (this._io) {
                const s = this.$('sentinel');
                this._io.unobserve(s);
                this._io.observe(s);
            }
        }

        /** Прогресс и «что идёт» на уже нарисованных плитках — раз в 30 с. */
        _refreshTiles() {
            if (!this._data) return;
            this.shadowRoot.querySelectorAll('.tile').forEach(t => {
                const html = this._progHtml(this._data.channels[+t.dataset.i]);
                const body = t.querySelector('.t-extra');
                if (body.innerHTML !== html) body.innerHTML = html;
            });
        }

        _nowProgramme(channel) {
            const list = this._data.programmes[channel[3]];
            if (!list) return null;
            const now = Date.now() / 1000;
            for (let k = 0; k < list.length; k++) {
                if (list[k][0] <= now && now < list[k][1]) return list[k];
                if (list[k][0] > now) break;
            }
            return null;
        }

        _progHtml(channel) {
            const p = this._nowProgramme(channel);
            if (!p) return '<div class="t-prog"></div>';
            const pct = Math.max(0, Math.min(100, (Date.now() / 1000 - p[0]) / (p[1] - p[0]) * 100));
            return `<div class="t-prog">${esc(p[2])}</div><div class="t-bar"><i style="width:${pct.toFixed(0)}%"></i></div>`;
        }

        _tileHtml(i) {
            const c = this._data.channels[i];
            const ini = initials(c[0]);
            const logo = c[2]
                ? `<img src="${esc(c[2])}" alt="" loading="lazy" decoding="async">`
                : ini;
            return `<button class="tile${c[0] === this._curChannel ? ' active' : ''}${c[4] ? ' has-arch' : ''}" data-i="${i}" title="${esc(c[0])}">
                ${c[4] ? `<span class="archive" title="${esc(_t('card.archiveDays', { days: c[4] }))}">${esc(_t('archive.badge', { days: c[4] }))}</span>` : ''}
                <div class="t-logo" data-initials="${ini}">${logo}</div>
                <div class="t-body"><div class="t-top"><div class="t-name"><span class="t-num">${i + 1}</span>${esc(c[0])}</div></div>
                <div class="t-extra">${this._progHtml(c)}</div></div></button>`;
        }

        _markActive() {
            this.shadowRoot.querySelectorAll('.tile').forEach(t => {
                t.classList.toggle('active', this._data && this._data.channels[+t.dataset.i][0] === this._curChannel);
            });
        }
    }

    /** Зарегистрированные телевизоры (аддон пишет /local/tizen-iptv/tvs.json). */
    function loadTvs() {
        return fetch('/local/tizen-iptv/tvs.json?t=' + Date.now(), { cache: 'no-store' })
            .then(r => (r.ok ? r.json() : [])).catch(() => []);
    }

    /** Визуальный редактор: телевизор из выпадающего списка + заголовок. */
    class TizenIptvCardEditor extends HTMLElement {
        setConfig(config) {
            this._config = Object.assign({}, config);
            this._render();
        }

        set hass(hass) { this._hass = hass; }

        connectedCallback() {
            if (this._tvs) return;
            loadTvs().then(list => { this._tvs = list; this._render(); });
        }

        _render() {
            if (!this._config) return;
            const tvs = this._tvs || [];
            const cur = this._config.tv_id || '';
            const opts = tvs.map(t => `<option value="${esc(t.tv_id)}"${t.tv_id === cur ? ' selected' : ''}>${esc(t.name)} — ${esc(t.model || '')} (${esc(t.tv_id)})</option>`);
            if (cur && !tvs.some(t => t.tv_id === cur)) opts.unshift(`<option value="${esc(cur)}" selected>${esc(cur)} (${esc(_t('card.edNotFound'))})</option>`);
            this.innerHTML = `<style>
                .ed { display: flex; flex-direction: column; gap: 14px; padding: 4px 0; }
                .ed label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--secondary-text-color); }
                .ed select, .ed input { font: inherit; font-size: 15px; padding: 8px 10px; border-radius: 8px; color: var(--primary-text-color);
                    border: 1px solid var(--divider-color, #ccc); background: var(--card-background-color, #fff); }
                .ed small { color: var(--secondary-text-color); }
              </style>
              <div class="ed">
                <label>${esc(_t('info.tv'))}
                  <select id="tv">${tvs.length || cur ? '' : `<option value="">— ${esc(_t('card.edNoTvs'))} —</option>`}${opts.join('')}</select>
                </label>
                <small>${esc(this._tvs ? _t(tvs.length ? 'card.edListHint' : 'card.edNoTvsHint') : _t('card.edLoading'))}</small>
                <label>${esc(_t('card.edTitle'))}
                  <input id="title" value="${esc(this._config.title || '')}">
                </label>
              </div>`;
            this.querySelector('#tv').addEventListener('change', e => this._set('tv_id', e.target.value));
            this.querySelector('#title').addEventListener('change', e => this._set('title', e.target.value.trim()));
        }

        _set(key, value) {
            const config = Object.assign({}, this._config);
            if (value) config[key] = value; else delete config[key];
            this._config = config;
            this.dispatchEvent(new CustomEvent('config-changed', { detail: { config }, bubbles: true, composed: true }));
        }
    }

    if (!customElements.get('tizen-iptv-card-editor')) customElements.define('tizen-iptv-card-editor', TizenIptvCardEditor);

    if (!customElements.get('tizen-iptv-card')) {
        customElements.define('tizen-iptv-card', TizenIptvCard);
        window.customCards = window.customCards || [];
        window.customCards.push({
            type: 'tizen-iptv-card',
            name: 'AssisTV',
            description: _t('card.description'),
            preview: false,
            documentationURL: 'https://github.com/indoor25/AssisTV'
        });
    }
})();
