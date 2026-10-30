/**
 * Родительский контроль на телевизоре (решения пользователя 16.09.2026). Настраивается в аддоне
 * (ha-addon/epg_builder/parental.js): PIN, защищённые группы и режим этого TV. Приходит при регистрации
 * (reg.parental) и потом в retained iptv/<tv_id>/config: {enabled, mode: 'lock'|'hide', groups, key}.
 *
 *   mode 'hide' — каналов защищённых групп на этом TV нет совсем (отсеиваются до ChannelStore.load).
 *   mode 'lock' — группы видны с замком; пока PIN не введён: группа не открывается, её каналов нет в
 *                 «Все каналы», CH+/CH− их пропускают, номер канала спрашивает PIN, при старте не включаются.
 *                 PIN проверяет аддон; открыто — до выключения TV (приложение ушло в фон — снова закрыто).
 *   MQTT set_channel защищённый канал не включает никогда, кроме запроса с key — его подставляет аддон,
 *   когда PIN ввели в карточке HA. Голосу ключа не даёт никто.
 */
const Parental = (() => {
    const OFF = { enabled: false, mode: 'lock', groups: [], key: '' };
    let cfg = OFF;
    let unlocked = false;

    /** p — reg.parental / config.parental. → что поменялось: {changed, hideChanged} */
    function configure(p) {
        const next = p && p.enabled ? {
            enabled: true,
            mode: p.mode === 'hide' ? 'hide' : 'lock',
            groups: Array.isArray(p.groups) ? p.groups.map(String) : [],
            key: String(p.key || '')
        } : OFF;
        const hideSet = c => (c.enabled && c.mode === 'hide' ? c.groups.slice().sort().join('\n') : '');
        const changed = JSON.stringify(next) !== JSON.stringify(cfg);
        const hideChanged = hideSet(next) !== hideSet(cfg);
        cfg = next;
        // защиту выключили — замок не нужен; включили заново — снова закрыто
        if (!cfg.enabled) unlocked = false;
        return { changed, hideChanged };
    }

    function enabled() { return cfg.enabled; }
    function isProtectedGroup(group) { return cfg.enabled && cfg.groups.indexOf(group) >= 0; }
    function isProtected(channel) { return !!channel && isProtectedGroup(channel.group); }
    /** Канал нельзя показывать и включать с пульта без PIN (в режиме 'hide' — нельзя совсем). */
    function isLocked(channel) { return isProtected(channel) && (!unlocked || cfg.mode === 'hide'); }
    function isGroupLocked(group) { return isProtectedGroup(group) && (!unlocked || cfg.mode === 'hide'); }

    /** Каналы плейлиста до ChannelStore.load: в режиме 'hide' защищённых нет. */
    function visibleChannels(list) {
        if (!cfg.enabled || cfg.mode !== 'hide') return list;
        return list.filter(ch => cfg.groups.indexOf(ch.group) < 0);
    }

    /** Ключ из MQTT set_channel — PIN уже проверен аддоном (карточка HA). */
    function keyMatches(key) { return cfg.enabled && !!cfg.key && key === cfg.key; }

    function unlock() { unlocked = true; }
    function lock() { const was = unlocked; unlocked = false; return was; }
    function isUnlocked() { return unlocked; }

    /** Значок замка (SVG — эмодзи на прошивках TV есть не везде). open — открытый замок. */
    function lockIcon(open) {
        const span = document.createElement('span');
        span.className = 'lock-icon' + (open ? ' open' : '');
        span.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="' +
            (open ? 'M12 17a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm6-9h-1V6a5 5 0 0 0-9.8-1.4l1.9.6A3 3 0 0 1 15 6v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2z'
                : 'M12 17a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm6-9h-1V6A5 5 0 0 0 7 6v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2zM9 6a3 3 0 0 1 6 0v2H9V6z') +
            '"/></svg>';
        return span;
    }

    return {
        configure, enabled, isProtectedGroup, isProtected, isLocked, isGroupLocked, visibleChannels,
        keyMatches, unlock, lock, isUnlocked, lockIcon
    };
})();

if (typeof module !== 'undefined') module.exports = { Parental };
