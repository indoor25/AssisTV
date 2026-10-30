/**
 * Что в доме смотрят по телевизору: сколько времени шёл каждый канал и каждая передача. Нужно для «что посмотреть
 * сегодня вечером?» — подборка строится по каналам, которые действительно включают, а не по всему плейлисту.
 *
 * Считает сам аддон по состоянию плееров (iptv/<tv_id>/state): раз в TICK_SEC каждому телевизору, где идёт эфир
 * или запись канала, прибавляется время. Фильмы портала сюда не входят — у них свой список просмотренного.
 * Старое понемногу забывается: раз в сутки счётчики умножаются на DECAY, чтобы летние привычки не мешали зимним.
 *
 * opts: { file, log, now() — мс (для тестов) }
 */
const fs = require('fs');

const TICK_SEC = 60;
const SAVE_MS = 10 * 60 * 1000;
const DECAY = 0.97;             // в сутки: за месяц вес падает до 40 %
const MAX_TITLES = 600;
const MIN_TITLE_SEC = 15 * 60;  // передачу «смотрели», если она шла не меньше стольких секунд

function createHistory(opts) {
    const log = opts.log || (() => {});
    const now = opts.now || (() => Date.now());
    let data = { channels: {}, titles: {}, decayedAt: now() };
    try { data = Object.assign(data, JSON.parse(fs.readFileSync(opts.file, 'utf8'))); } catch (e) { /* файла ещё нет */ }
    let dirty = false;
    let savedAt = now();

    const titleKey = t => String(t || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

    function save() {
        try {
            fs.writeFileSync(opts.file + '.tmp', JSON.stringify(data));
            fs.renameSync(opts.file + '.tmp', opts.file);
            dirty = false;
            savedAt = now();
        } catch (e) { log('watch-history: ' + e.message); }
    }

    function decay() {
        const days = Math.floor((now() - data.decayedAt) / 86400000);
        if (days < 1) return;
        const k = Math.pow(DECAY, days);
        for (const set of [data.channels, data.titles]) {
            for (const key of Object.keys(set)) {
                set[key].sec = Math.round(set[key].sec * k);
                if (set[key].sec < 60) delete set[key];
            }
        }
        data.decayedAt += days * 86400000;
        dirty = true;
    }

    /**
     * Прошло sec секунд; states — состояния плееров, которые сейчас на связи ([{channel, programme, state, vod_title}]).
     * Пауза и стоп временем просмотра не считаются.
     */
    function tick(states, sec = TICK_SEC) {
        decay();
        for (const s of states) {
            if (!s || !s.channel || s.vod_title || (s.state !== 'playing' && s.state !== 'buffering')) continue;
            const ch = data.channels[s.channel] || (data.channels[s.channel] = { sec: 0, last: 0 });
            ch.sec += sec;
            ch.last = now();
            const key = titleKey(s.programme);
            if (key) {
                const t = data.titles[key] || (data.titles[key] = { title: s.programme, sec: 0, last: 0 });
                t.sec += sec;
                t.last = now();
            }
            dirty = true;
        }
        const keys = Object.keys(data.titles);
        if (keys.length > MAX_TITLES) {
            keys.sort((a, b) => data.titles[a].last - data.titles[b].last).slice(0, keys.length - MAX_TITLES).forEach(k => delete data.titles[k]);
        }
        if (dirty && now() - savedAt >= SAVE_MS) save();
    }

    /** Каналы по убыванию времени просмотра: [{name, minutes}]. */
    function topChannels(limit = 25) {
        return Object.keys(data.channels).map(name => ({ name, minutes: Math.round(data.channels[name].sec / 60) }))
            .filter(c => c.minutes >= 5).sort((a, b) => b.minutes - a.minutes).slice(0, limit);
    }

    /** Эту передачу (по названию) уже смотрели? */
    function watchedTitle(title) {
        const t = data.titles[titleKey(title)];
        return !!t && t.sec >= MIN_TITLE_SEC;
    }

    /** Что смотрят чаще всего: [{title, minutes}]. */
    function topTitles(limit = 15) {
        return Object.values(data.titles).filter(t => t.sec >= MIN_TITLE_SEC)
            .sort((a, b) => b.sec - a.sec).slice(0, limit).map(t => ({ title: t.title, minutes: Math.round(t.sec / 60) }));
    }

    return { tick, topChannels, topTitles, watchedTitle, save, TICK_SEC };
}

module.exports = { createHistory };
