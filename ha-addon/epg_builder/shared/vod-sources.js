/**
 * Реестр источников фильмов (плагинов). Один и тот же файл работает в плеере на телевизоре, в аддоне
 * (Node) и в карточке Home Assistant.
 *
 * Плагин — один файл без DOM и без переводов, он отдаёт только данные; рисует всё ядро (js/vod-ui.js,
 * карточка HA). Плагины живут в аддоне и оттуда же раздаются телевизорам, поэтому ради нового источника
 * не нужно пересобирать приложение TV (см. ha-addon/epg_builder/plugins.js).
 *
 * Плагин регистрирует себя сам:
 *
 *   VodSources.register('portal', {
 *       meta: {                          // манифест: страница аддона показывает его и рисует форму настроек
 *           name: 'Видеопортал', version: '1.0.0', author: '…', homepage: 'https://…', api: 1,
 *           settings: [                  // поля формы; url — адрес сервиса, остальные уходят в params
 *               { key: 'url', label: 'Адрес API', required: true },
 *               { key: 'key', label: 'Ключ', type: 'password' }
 *           ]
 *       },
 *       create(url, params) { return {
 *           root(),                      // {categories, search, filters} — главная источника
 *           page(request),               // {items, count, nextRequest} — страница списка
 *           details(item),               // {item, episodes, streams:[{id, name, variants}]}
 *           searchRequest(root, text),   // запрос поиска (непрозрачный токен, ядро в него не смотрит)
 *           filterRequest([…]),          // запрос выбранных фильтров
 *           itemById(localId),           // id → элемент, годный для details()
 *           reviews(localId)             // необязательный: свои рецензии вместо Кинопоиска
 *       }; }
 *   });
 *
 * Адрес источника в настройках аддона: <тип>::[ключ:значение;ключ:значение]<url>, например
 * portal::[key:КЛЮЧ]http://host/api/v1/ — тип выбирает плагин, пары в скобках он получает как params
 * (ключ, логин, «свои отзывы или Кинопоиск» и т. п.; ядро в них не заглядывает). Значение с «;» внутри
 * не поддерживается — разделитель пар.
 *
 * Наружу (избранное, история просмотра, MQTT, карточка HA) идентификатор уходит составным:
 * «portal:48357» — тип источника и его собственный id. Правило совместимости: идентификатор без типа
 * означает portal, поэтому избранное и история, записанные до появления плагинов, читаются как были.
 */
const VodSources = (() => {
    const URL_RE = /^\s*([a-z0-9_-]+)::(?:\[([^\]]*)\])?\s*(\S+)\s*$/i;
    // записи без типа остались от времён единственного источника — это он
    const DEFAULT_TYPE = 'portal';

    const types = {};

    /** '<тип>::[k:v;k:v]<url>' → {type, params, url}; не наш адрес (обычный M3U) — null. */
    function parseUrl(url) {
        const m = URL_RE.exec(url || '');
        if (!m) return null;
        const params = {};
        String(m[2] || '').split(';').forEach(pair => {
            if (!pair) return;
            const i = pair.indexOf(':');
            if (i > 0) params[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
        });
        return { type: m[1].toLowerCase(), params, url: m[3] };
    }

    /** Адрес источника (а не обычный M3U-плейлист)? Тип при этом может быть и не установлен. */
    function isSourceUrl(url) { return !!parseUrl(url); }

    function register(type, impl) {
        if (!type || !impl || typeof impl.create !== 'function') throw new Error('vod: плагин без create()');
        types[String(type).toLowerCase()] = impl;
    }

    /** Манифест плагина (meta из register) или пустой. */
    function meta(type) {
        const impl = types[String(type || '').toLowerCase()];
        return impl && impl.meta && typeof impl.meta === 'object' ? JSON.parse(JSON.stringify(impl.meta)) : {};
    }

    /** ('portal', 'http://h/api/', {key: 'K'}) → 'portal::[key:K]http://h/api/' — обратное parseUrl. */
    function makeUrl(type, url, params) {
        const pairs = Object.keys(params || {}).filter(k => params[k] !== '' && params[k] != null)
            .map(k => k + ':' + params[k]);
        return String(type).toLowerCase() + '::' + (pairs.length ? '[' + pairs.join(';') + ']' : '') + String(url || '').trim();
    }

    function has(type) { return !!types[String(type || '').toLowerCase()]; }

    /** Установленные типы источников. */
    function list() { return Object.keys(types); }

    /**
     * Клиент источника по адресу из настроек. Клиенту добавляются sourceType и params — по ним ядро
     * собирает составные id и решает, какой источник спрашивать.
     */
    function create(url) {
        const parsed = parseUrl(url);
        if (!parsed) throw new Error('vod: адрес не похож на источник: ' + url);
        const impl = types[parsed.type];
        if (!impl) throw new Error('vod: источник «' + parsed.type + '» не установлен');
        return Object.assign({}, impl.create(parsed.url, parsed.params), {
            sourceType: parsed.type,
            params: parsed.params
        });
    }

    /** 'portal:48357' → {type: 'portal', localId: '48357'}; '48357' → тот же portal (старые записи). */
    function splitId(id) {
        const s = String(id == null ? '' : id);
        const i = s.indexOf(':');
        if (i <= 0) return { type: DEFAULT_TYPE, localId: s };
        return { type: s.slice(0, i).toLowerCase(), localId: s.slice(i + 1) };
    }

    /** ('portal', 48357) → 'portal:48357'. */
    function makeId(type, localId) { return String(type || DEFAULT_TYPE) + ':' + String(localId); }

    /** Один и тот же фильм? Сравнение с учётом старых записей без типа. */
    function sameId(a, b) {
        const x = splitId(a);
        const y = splitId(b);
        return x.type === y.type && x.localId === y.localId;
    }

    return { register, has, list, meta, makeUrl, create, parseUrl, isSourceUrl, splitId, makeId, sameId, DEFAULT_TYPE };
})();

if (typeof module !== 'undefined') module.exports = { VodSources };
