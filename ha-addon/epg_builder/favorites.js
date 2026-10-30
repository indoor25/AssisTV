/**
 * Избранное — общее на все телевизоры и карточку HA (решение пользователя 20.09.2026).
 *
 *   /data/favorites.json — { items: [{id, src, fid, title, year, kind, poster, posterLocal, quality, addedAt}] }
 *
 * id — составной: «portal:48357» (источник и его собственный id), src — тип источника. Записи, сделанные
 * до появления плагинов, лежат без id и src — они читаются как portal (VodSources.splitId), поэтому старое
 * избранное ничего не теряет. fid остаётся рядом: его шлёт карточка HA и старые команды vod_play.
 *
 * Один и тот же фильм из двух источников — две разные записи: у них разные идентификаторы, а часто и
 * разная озвучка.
 *
 * Храним не только id, но и название с годом: идентификаторы источников живут не вечно, а избранное —
 * долго. Если фильм по id не открылся, server.js включает его запасным путём — поиском по этому названию
 * в том же источнике (action vod_play). Поэтому title здесь обязателен.
 *
 * poster — ссылка источника (её показывает телевизор), posterLocal — копия в /local/tizen-iptv/posters
 * (её показывает карточка HA: портал отдаёт постеры только по http, а HA открывают и по https).
 *
 * Новые — первыми, больше MAX_ITEMS не держим.
 */
const fs = require('fs');
const path = require('path');

function requireShared(name) {
    const local = path.join(__dirname, 'shared', name);
    return require(fs.existsSync(local) ? local : path.join(__dirname, '..', '..', 'js', name));
}
const { VodSources } = requireShared('vod-sources.js');

const MAX_ITEMS = 200;

function createFavorites({ file, log }) {
    let items = read();

    function read() {
        try {
            const d = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (d && Array.isArray(d.items)) return d.items.filter(i => i && idOf(i) != null && i.title);
        } catch (e) { /* ещё нет */ }
        return [];
    }

    function save() {
        fs.writeFileSync(file + '.tmp', JSON.stringify({ items }, null, 2));
        fs.renameSync(file + '.tmp', file);
    }

    /** id записи или команды: новые шлют id, старые (и карточка HA) — fid без источника. */
    function idOf(x) {
        if (!x) return null;
        if (x.id != null && x.id !== '') return String(x.id);
        if (x.fid == null) return null;
        return VodSources.makeId(x.src, x.fid);
    }

    function list() { return items.slice(); }

    function has(id) { return id != null && items.some(i => VodSources.sameId(idOf(i), id)); }

    function find(id) { return items.find(i => VodSources.sameId(idOf(i), id)) || null; }

    /**
     * on: true — добавить, false — убрать, не задано — переключить.
     * item — {id | fid (+src), title, year, kind, poster, quality}.
     * → в избранном ли фильм после вызова.
     */
    function set(item, on) {
        const id = idOf(item);
        if (id == null) throw new Error('no_fid');
        const { type, localId } = VodSources.splitId(id);
        const want = on == null ? !has(id) : !!on;
        const prev = find(id);
        if (!want) {
            if (!prev) return false;
            items = items.filter(i => !VodSources.sameId(idOf(i), id));
            save();
            log(`избранное: убрано «${prev.title}» (${id}), осталось ${items.length}`);
            return false;
        }
        const title = String(item.title || (prev && prev.title) || '').trim();
        if (!title) throw new Error('no_title');
        const entry = {
            id,
            src: type,
            fid: localId,
            title,
            year: item.year != null ? item.year : (prev && prev.year) || null,
            kind: item.kind === 'series' ? 'series' : 'movie',
            poster: item.poster || (prev && prev.poster) || null,
            posterLocal: item.posterLocal || (prev && prev.posterLocal) || null,
            quality: item.quality || (prev && prev.quality) || '',
            addedAt: (prev && prev.addedAt) || Date.now()
        };
        items = [entry].concat(items.filter(i => !VodSources.sameId(idOf(i), id))).slice(0, MAX_ITEMS);
        save();
        log(`избранное: добавлено «${title}» (${id}), всего ${items.length}`);
        return true;
    }

    /** Локальный постер докачивается уже после ответа — ждать его карточке незачем. */
    function setPosterLocal(id, local) {
        const it = find(id);
        if (!it || !local || it.posterLocal === local) return;
        it.posterLocal = local;
        save();
    }

    return { list, has, find, set, setPosterLocal, idOf, MAX_ITEMS };
}

module.exports = { createFavorites };
