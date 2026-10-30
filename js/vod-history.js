/**
 * Что смотрели: позиция в фильме/серии (чтобы «Продолжить»), просмотренное, последняя серия сериала
 * и выбранное качество. Хранится в localStorage отдельным ключом.
 *
 * Ключ — составной id фильма («portal:48357»): у каждого источника свои номера. Записи, сделанные до
 * появления плагинов, лежат под голым номером — их читает keyOf, поэтому «Продолжить» не теряется;
 * новые пишутся уже с источником.
 */
const VodHistory = (() => {
    const KEY = 'tizeniptv.vod.v1';
    const MAX_ITEMS = 300;
    const MIN_RESUME_MS = 30 * 1000;       // меньше — начинать сначала, продолжать нечего

    let data = load();

    /** Под каким ключом запись лежит на самом деле: новым составным или старым (без источника). */
    function keyOf(id) {
        if (id == null) return null;
        const s = String(id);
        if (data.pos[s] || data.last[s]) return s;
        const old = VodSources.splitId(s);
        const bare = old.localId;
        return (data.pos[bare] || data.last[bare]) ? bare : s;
    }

    function load() {
        try {
            const d = JSON.parse(localStorage.getItem(KEY));
            if (d && d.pos) return Object.assign({ last: {}, quality: 'auto' }, d);
        } catch (e) { /* пусто или битое — начинаем заново */ }
        return { pos: {}, last: {}, quality: 'auto' };
    }

    function save() {
        try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { console.warn('[VodHistory] save failed', e); }
    }

    /** pos[id] = [позиция мс, длительность мс, когда, просмотрено 0/1] */
    function setPosition(id, posMs, durMs) {
        if (id == null || !(posMs >= 0)) return;
        const fid = keyOf(id);
        const watched = durMs > 0 && (posMs >= durMs * 0.95 || durMs - posMs < 90 * 1000);
        const prev = data.pos[fid];
        if (!watched && posMs < MIN_RESUME_MS && !prev) return;   // только начали — хранить нечего
        // пересматривают просмотренное: отметка остаётся, пока не ушли дальше начала
        const keepWatched = !!(prev && prev[3]) && posMs < MIN_RESUME_MS;
        data.pos[fid] = [watched ? 0 : Math.round(posMs), Math.round(durMs || 0), Date.now(), watched || keepWatched ? 1 : 0];
        const fids = Object.keys(data.pos);
        if (fids.length > MAX_ITEMS) {
            fids.sort((a, b) => data.pos[a][2] - data.pos[b][2]);
            fids.slice(0, fids.length - MAX_ITEMS).forEach(f => delete data.pos[f]);
        }
        save();
    }

    /** С какого места продолжать (мс), 0 — сначала. */
    function getResume(id) {
        const p = data.pos[keyOf(id)];
        return p && p[0] >= MIN_RESUME_MS ? p[0] : 0;
    }

    /** 0..1 — сколько просмотрено (для полоски на плитке), просмотренное целиком — 1. */
    function getProgress(id) {
        const p = data.pos[keyOf(id)];
        if (!p) return 0;
        if (p[3] && !p[0]) return 1;
        return p[1] > 0 ? Math.min(1, p[0] / p[1]) : 0;
    }

    function isWatched(id) { const p = data.pos[keyOf(id)]; return !!(p && p[3]); }

    function setLastEpisode(seriesId, episodeId) {
        if (seriesId == null) return;
        data.last[keyOf(seriesId)] = episodeId;
        save();
    }
    /** → id последней серии; у старых записей он без источника — вернём его в нынешнем виде. */
    function getLastEpisode(seriesId) {
        const ep = data.last[keyOf(seriesId)];
        return ep == null ? ep : VodSources.makeId(VodSources.splitId(seriesId).type, VodSources.splitId(ep).localId);
    }

    function getQuality() { return data.quality || 'auto'; }
    function setQuality(q) { data.quality = q; save(); }

    return { setPosition, getResume, getProgress, isWatched, setLastEpisode, getLastEpisode, getQuality, setQuality };
})();

if (typeof module !== 'undefined') module.exports = { VodHistory };
