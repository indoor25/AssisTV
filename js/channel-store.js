/**
 * Owns the merged channel list: playlist data + EPG match + user overrides
 * (custom sort order, custom logo, manual EPG-id mapping).
 * Persists overrides in localStorage so they survive playlist refreshes.
 */
const ChannelStore = (() => {
    const STORAGE_KEY = 'tizeniptv.overrides.v1';
    let channels = [];       // merged, ordered list — the single source of truth for UI + API
    let epg = { channels: {}, programmes: {} };
    let overrides = loadOverrides();
    // Per-channel logo/epgId as computed from playlist+EPG alone, before any override is applied.
    // Setters need this to recompute an "effective" value in place (e.g. clearing a logo override
    // must fall back to this, not to nothing) without forcing a full reload() to see the change.
    let baseByKey = {};

    function loadOverrides() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
        } catch (e) {
            return {};
        }
    }

    function saveOverrides() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
    }

    /** channelKey: prefer tvg-id, fall back to name (lowercased, trimmed) — this is what the API matches on too */
    function keyFor(channel) {
        return (channel.id || channel.name).toLowerCase().trim();
    }

    /**
     * Normalizes a channel name for cross-source matching (playlist name vs EPG display-name).
     * Сама реализация — в js/channel-name.js: ту же нормализацию использует аддон HA при сборке EPG.
     */
    const normalizeName = normalizeChannelName;

    /**
     * xmltvData — либо разобранный XMLTV (programmes — объекты с Date), либо готовый EPG с
     * бэкенда (ha-addon/epg_builder): там уже есть `match` (имя в плейлисте → epgId), а передачи
     * лежат компактно массивами [startSec, stopSec, title] и превращаются в объекты лениво,
     * при первом обращении к каналу (см. getProgrammesFor).
     */
    function load(m3uChannels, xmltvData) {
        epg = xmltvData || epg;
        const readyMatch = epg.match || {};

        // Build a lookup of EPG channels by normalized display-name, since our playlist has
        // no tvg-id to match on directly. Индексируем по ВСЕМ display-name канала: в источнике
        // их несколько на канал, и плейлист нередко совпадает не с первым (иначе теряется
        // около трети каналов вместе с их логотипами).
        const epgByNormalizedName = {};
        Object.entries(epg.channels).forEach(([epgId, info]) => {
            const names = info.displayNames || [info.displayName || epgId];
            names.forEach(name => {
                const norm = normalizeName(name);
                if (!epgByNormalizedName[norm]) epgByNormalizedName[norm] = epgId; // first match wins
            });
        });

        baseByKey = {};
        channels = m3uChannels.map((ch, idx) => {
            const key = keyFor(ch);
            const ov = overrides[key] || {};

            const matchedEpgId = ch.id || readyMatch[ch.name] ||
                epgByNormalizedName[normalizeName(ch.name)] || null;
            const epgEntry = matchedEpgId ? epg.channels[matchedEpgId] : null;
            const baseLogo = ch.logo || (epgEntry && epgEntry.icon) || null;

            baseByKey[key] = { logo: baseLogo, epgId: matchedEpgId };

            return {
                ...ch,
                key,
                logo: ov.logo || baseLogo,
                epgId: ov.epgId || matchedEpgId,
                sortIndex: ov.sortIndex !== undefined ? ov.sortIndex : idx,
                group: ov.group || ch.group
            };
        });
        channels.sort((a, b) => a.sortIndex - b.sortIndex);
        emitChanged();
        return channels;
    }

    function getAll() { return channels; }

    // Список, порядок или логотипы поменялись — для публикации плейлиста в Home Assistant (mqtt-bridge.js)
    const changeListeners = [];
    function onChanged(cb) { changeListeners.push(cb); }
    function emitChanged() { changeListeners.forEach(cb => cb()); }

    /**
     * Канал по имени «как сказали голосом»: точное имя, иначе фонетическое сравнение с учётом
     * опечаток, чисел словами, транслита и HD/orig (js/channel-match.js).
     * → { channel | null, score, exact, alternatives }
     */
    function findByName(name) {
        return ChannelMatch.find(name, channels);
    }

    function getByName(name) { return findByName(name).channel; }

    /** logoUrl: pass null/'' to clear the override and fall back to the playlist/EPG logo. */
    function setLogoOverride(key, logoUrl) {
        overrides[key] = { ...(overrides[key] || {}), logo: logoUrl };
        saveOverrides();
        const ch = channels.find(c => c.key === key);
        if (ch) ch.logo = logoUrl || (baseByKey[key] && baseByKey[key].logo) || null;
        emitChanged();
    }

    function setEpgOverride(key, epgId) {
        overrides[key] = { ...(overrides[key] || {}), epgId };
        saveOverrides();
        const ch = channels.find(c => c.key === key);
        if (ch) ch.epgId = epgId || (baseByKey[key] && baseByKey[key].epgId) || null;
    }

    /** orderedKeys: every channel's key, in the desired new order. Re-sorts the live list in
     *  place so getAll() reflects it immediately — not just on the next load(). */
    function setSortOrder(orderedKeys) {
        orderedKeys.forEach((key, idx) => {
            overrides[key] = { ...(overrides[key] || {}), sortIndex: idx };
        });
        saveOverrides();

        const indexByKey = new Map(orderedKeys.map((key, idx) => [key, idx]));
        channels.forEach(c => {
            if (indexByKey.has(c.key)) c.sortIndex = indexByKey.get(c.key);
        });
        channels.sort((a, b) => a.sortIndex - b.sortIndex);
        emitChanged();
    }

    function getCurrentProgrammeFor(channel) {
        const now = typeof AppClock !== 'undefined' ? AppClock.now() : new Date();
        return getProgrammesFor(channel).find(p => p.start <= now && now < p.stop) || null;
    }

    /** Full programme list for a channel (for the EPG grid), not just "what's on now". */
    function getProgrammesFor(channel) {
        const list = (channel.epgId && epg.programmes[channel.epgId]) || [];
        // компактный формат бэкенда — разворачиваем один раз на канал и кладём обратно
        if (list.length && Array.isArray(list[0])) {
            const expanded = list.map(p => ({
                start: new Date(p[0] * 1000),
                stop: new Date(p[1] * 1000),
                title: p[2]
            }));
            epg.programmes[channel.epgId] = expanded;
            return expanded;
        }
        return list;
    }

    /**
     * Сколько дней архива у канала (0 — нет). У нашего провайдера это tvg-rec="N" в M3U (у ~1040 из 1977
     * каналов), но примерно у половины из них архива на деле нет — аддон проверяет каждый запросом и ставит
     * catchup.available (ha-addon/epg_builder/archive.js). Архив считается, только если он подтверждён.
     */
    function archiveDays(channel) {
        const c = channel && channel.catchup;
        return c && c.days > 0 && c.available === true ? c.days : 0;
    }

    /** Метка архива для списков: <span class="archive-badge">А7</span> или null. */
    function archiveBadge(channel) {
        const days = archiveDays(channel);
        if (!days) return null;
        const el = document.createElement('span');
        el.className = 'archive-badge';
        el.textContent = I18n.t('archive.badge', { days });
        return el;
    }

    // ───────────── группы для показа (главный экран, боковой список, список групп) ─────────────
    // Решение пользователя 16.09.2026: в конце всегда «Все каналы» (все подряд, по номерам); каналы без группы —
    // группа «Без группы» перед ней; в плейлисте нет групп вовсе — только «Все каналы». Карточка HA — так же.
    const ALL_GROUP = 'Все каналы';
    const NO_GROUP = 'Без группы';   // так m3u-parser.js называет группу канала без group-title/#EXTGRP
    // Эти два названия — внутренние имена (их знают аддон и карточка); на экран — только через groupLabel.

    /** Название группы для показа: служебные — на языке интерфейса, остальные — как в плейлисте. */
    function groupLabel(g) {
        if (g === ALL_GROUP) return I18n.t('groups.all');
        if (g === NO_GROUP) return I18n.t('groups.none');
        return g;
    }

    /** Группы в порядке первого появления в сортировке каналов, «Без группы» и «Все каналы» — в конце. */
    function groupsOf(channels) {
        const groups = [];
        let ungrouped = false;
        channels.forEach(ch => {
            const g = ch.group || NO_GROUP;
            if (g === NO_GROUP) ungrouped = true;
            else if (g !== ALL_GROUP && groups.indexOf(g) < 0) groups.push(g);
        });
        if (ungrouped && groups.length) groups.push(NO_GROUP);
        groups.push(ALL_GROUP);
        return groups;
    }

    /** Показывать ли канал в группе group. В «Все каналы» нет каналов под замком родительского контроля (js/parental.js). */
    function inGroup(channel, group) {
        if (group === ALL_GROUP) return typeof Parental === 'undefined' || !Parental.isLocked(channel);
        return (channel.group || NO_GROUP) === group;
    }

    /** Группа канала среди groups (groupsOf): его своя, а если её там нет (плейлист без групп) — «Все каналы». */
    function shownGroupOf(channel, groups) {
        const g = channel.group || NO_GROUP;
        return groups.indexOf(g) >= 0 ? g : ALL_GROUP;
    }

    return {
        groupsOf, inGroup, shownGroupOf, groupLabel, ALL_GROUP,
        load, getAll, getByName, findByName, normalizeName, onChanged,
        setLogoOverride, setEpgOverride, setSortOrder,
        getCurrentProgrammeFor, getProgrammesFor, keyFor, archiveDays, archiveBadge
    };
})();
