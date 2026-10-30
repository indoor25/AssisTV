/**
 * Переводы интерфейса. Тексты — в lang/<код>.js (ru, en, uk, de), по ключу: I18n.t('home.settings').
 *
 * Подстановки: '{name}' → params.name; число с формой слова: '{n} {n|канал|канала|каналов}' — формы
 * по правилам языка (ru/uk: 1, 2–4, 5+; en/de: 1, остальные). Нет фразы в выбранном языке — берётся
 * английская, потом русская, потом сам ключ (на экране видно, чего не хватает).
 *
 * Язык: I18n.setLanguage('auto' | 'ru' | …). 'auto' — язык телевизора (браузера); его нет среди
 * переводов — английский. Работает и в Node (аддон): require('./i18n').I18n, словари — I18n.add().
 */
const I18n = (() => {
    const FALLBACK = 'en';
    const NAMES = { ru: 'Русский', en: 'English', uk: 'Українська', de: 'Deutsch' };
    const LOCALES = { ru: 'ru-RU', en: 'en-GB', uk: 'uk-UA', de: 'de-DE' };
    const dicts = {};
    let lang = FALLBACK;

    function add(code, dict) {
        dicts[code] = Object.assign(dicts[code] || {}, dict);
    }

    /** Код языка из 'ru-RU', 'uk_UA', 'de' и т.п.; неизвестный — null. */
    function normalize(code) {
        const c = String(code || '').toLowerCase().split(/[-_]/)[0];
        if (c === 'ua') return 'uk';
        return NAMES[c] ? c : null;
    }

    function systemLanguage() {
        const list = (typeof navigator !== 'undefined' && (navigator.languages || [navigator.language])) || [];
        for (const l of list) {
            const c = normalize(l);
            if (c) return c;
        }
        return FALLBACK;
    }

    function setLanguage(code) {
        lang = code === 'auto' || !code ? systemLanguage() : (normalize(code) || FALLBACK);
        return lang;
    }

    /** Форма слова: ru/uk — 3 формы (1 / 2–4 / 5+), остальные — 2 (1 / прочие). */
    function pluralIndex(n, forms) {
        n = Math.abs(Number(n)) || 0;
        if (forms === 3) {
            const m10 = n % 10, m100 = n % 100;
            if (m10 === 1 && m100 !== 11) return 0;
            if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 1;
            return 2;
        }
        return n === 1 ? 0 : 1;
    }

    function format(s, params) {
        if (!params) return s;
        return s.replace(/\{(\w+)(?:\|([^}]*))?\}/g, (m, name, forms) => {
            const v = params[name];
            if (forms === undefined) return v === undefined || v === null ? m : String(v);
            const list = forms.split('|');
            return list[Math.min(pluralIndex(v, list.length), list.length - 1)];
        });
    }

    function lookup(key, code) {
        const d = dicts[code];
        return d && Object.prototype.hasOwnProperty.call(d, key) ? d[key] : undefined;
    }

    /** code — язык для этой фразы (аддон отвечает на языке запроса), иначе текущий. */
    function t(key, params, code) {
        const c = code ? (normalize(code) || lang) : lang;
        let s = lookup(key, c);
        if (s === undefined) s = lookup(key, FALLBACK);
        if (s === undefined) s = lookup(key, 'ru');
        if (s === undefined) return key;
        return format(s, params);
    }

    /** Есть ли фраза (в каком-нибудь языке). */
    function has(key) {
        return Object.keys(dicts).some(c => lookup(key, c) !== undefined);
    }

    return {
        add, t, has, setLanguage, normalize, systemLanguage,
        language: () => lang,
        /** для toLocaleTimeString и т.п. */
        locale: () => LOCALES[lang] || 'en-GB',
        /** [{code, name}] — языки, для которых есть словарь */
        languages: () => Object.keys(NAMES).filter(c => dicts[c]).map(c => ({ code: c, name: NAMES[c] })),
        languageName: (c) => NAMES[c] || c
    };
})();

if (typeof module !== 'undefined') module.exports = { I18n };
