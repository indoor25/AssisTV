/**
 * Поиск по программе передач всех каналов и напоминания о передачах.
 *
 * Поиск — по названиям передач (описаний в памяти нет, они в файле): каждое слово запроса должно быть началом
 * какого-то слова названия, окончания у длинных слов отбрасываются («футбола» найдёт «Футбол. Лига чемпионов»).
 * Один и тот же эфир на дублях канала (HD / SD / orig) показывается один раз — на первом канале в порядке плейлиста.
 *
 * Напоминание — {id, epgId, title, channel, start, stop}; за LEAD_SEC до начала вызывается onDue(reminder): сервис
 * показывает плашку на телевизорах и публикует событие в MQTT (озвучивает его уже Home Assistant).
 * Хранятся в файле — перезапуск аддона напоминания не теряет.
 *
 * opts: {
 *   file           — где хранить напоминания
 *   getEpg()       — { epgProgrammes: {epgId: [[start, stop, title]]} } | null
 *   getChannels()  — [{name, group, epgId}] в порядке плейлиста, без защищённых групп
 *   dayOf(sec)     — 'YYYY-MM-DD' по местному времени
 *   onDue(reminder), log, now() — секунды (для тестов)
 * }
 */
const fs = require('fs');

const LEAD_SEC = 5 * 60;          // за сколько до начала напоминать
const TICK_MS = 20 * 1000;
const MAX_REMINDERS = 100;

function createGuide(opts) {
    const log = opts.log || (() => {});
    const now = opts.now || (() => Date.now() / 1000);
    let reminders = [];
    try { reminders = JSON.parse(fs.readFileSync(opts.file, 'utf8')).items || []; } catch (e) { /* файла ещё нет */ }
    let timer = null;

    function save() {
        fs.writeFileSync(opts.file + '.tmp', JSON.stringify({ items: reminders }, null, 2));
        fs.renameSync(opts.file + '.tmp', opts.file);
    }

    const words = s => String(s || '').toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    /**
     * У слова запроса окончание не сравнивается: «новости» ~ «новостей», «футбола» ~ «футбол». Чем короче слово,
     * тем меньше срезается — иначе «погода» находила «Погоню».
     */
    const stem = w => (w.length >= 7 ? w.slice(0, -2) : w.length >= 5 ? w.slice(0, -1) : w);

    /** Проверка названия по запросу; результат помнится — названий в разы меньше, чем передач. */
    function matcher(query) {
        const q = words(query).map(stem);
        const cache = new Map();
        return title => {
            let hit = cache.get(title);
            if (hit === undefined) {
                const t = words(title);
                hit = q.length > 0 && q.every(w => t.some(x => x.startsWith(w)));
                cache.set(title, hit);
            }
            return hit;
        };
    }

    /**
     * Передачи, которые идут сейчас или начнутся до toSec. query — что искать в названии;
     * epgId — только этот канал EPG; day — только этот день ('YYYY-MM-DD').
     * → {total, items: [{channel, epgId, start, stop, title, live, also}]} — сначала то, что идёт, дальше по времени;
     *   also — на скольких ещё каналах тот же эфир.
     */
    function search(query, { toSec, epgId, day, limit = 30 } = {}) {
        const epg = opts.getEpg();
        if (!epg) return { total: 0, items: [] };
        const t = now();
        const match = matcher(query);
        const seenEpg = new Set();
        const byAir = new Map();   // название + начало → передача (дубли каналов)
        for (const ch of opts.getChannels()) {
            if (!ch.epgId || seenEpg.has(ch.epgId) || (epgId && ch.epgId !== epgId)) continue;
            seenEpg.add(ch.epgId);
            const list = epg.epgProgrammes[ch.epgId] || [];
            let lo = 0, hi = list.length;   // первая передача, которая ещё не кончилась
            while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid][1] <= t) lo = mid + 1; else hi = mid; }
            for (let i = lo; i < list.length; i++) {
                const p = list[i];
                if (toSec && p[0] >= toSec) break;
                if (!match(p[2])) continue;
                if (day && opts.dayOf(Math.max(p[0], t)) !== day) continue;
                const key = p[2].toLowerCase() + '\u0001' + p[0];
                const same = byAir.get(key);
                if (same) { same.also++; continue; }
                byAir.set(key, { channel: ch.name, epgId: ch.epgId, start: p[0], stop: p[1], title: p[2], live: p[0] <= t, also: 0 });
            }
        }
        const items = [...byAir.values()].sort((a, b) => (b.live - a.live) || (a.start - b.start));
        return { total: items.length, items: items.slice(0, limit) };
    }

    const refOf = item => item.epgId + '@' + item.start;

    /** Передача по ссылке из результатов поиска («<epgId>@<начало>») — название и канал берутся из EPG заново. */
    function byRef(ref) {
        const m = /^(.*)@(\d+)$/.exec(String(ref || ''));
        const epg = opts.getEpg();
        if (!m || !epg) return null;
        const p = (epg.epgProgrammes[m[1]] || []).find(x => x[0] === Number(m[2]));
        const ch = p && opts.getChannels().find(c => c.epgId === m[1]);
        return p && ch ? { channel: ch.name, epgId: m[1], start: p[0], stop: p[1], title: p[2] } : null;
    }

    /** → {ok, reminder, existed} | {ok: false, error: 'already_started'} */
    function add(item) {
        if (item.start <= now()) return { ok: false, error: 'already_started', reminder: item };
        const id = refOf(item);
        const old = reminders.find(r => r.id === id);
        if (old) return { ok: true, reminder: old, existed: true };
        const reminder = { id, epgId: item.epgId, title: item.title, channel: item.channel, start: item.start, stop: item.stop, createdAt: Math.floor(now()) };
        reminders.push(reminder);
        reminders.sort((a, b) => a.start - b.start);
        if (reminders.length > MAX_REMINDERS) reminders.length = MAX_REMINDERS;
        save();
        log(`напоминание: «${reminder.title}» на ${reminder.channel}, начало ${new Date(reminder.start * 1000).toISOString()}`);
        return { ok: true, reminder };
    }

    /** Ещё не сработавшие, по времени. */
    function list() {
        return reminders.filter(r => !r.fired);
    }

    /** Убрать по id или по словам из названия/канала; пустой запрос — все. → убранные */
    function remove(query) {
        const q = String(query || '').trim();
        const match = matcher(q);
        const gone = list().filter(r => !q || r.id === q || match(r.title + ' ' + r.channel));
        if (!gone.length) return [];
        reminders = reminders.filter(r => !gone.includes(r));
        save();
        return gone;
    }

    function tick() {
        const t = now();
        let changed = false;
        for (const r of reminders) {
            if (r.fired || r.start - LEAD_SEC > t) continue;
            r.fired = true;
            changed = true;
            // аддон был выключен и передача уже идёт давно — напоминать поздно
            if (t - r.start < 10 * 60) {
                try { opts.onDue(r); } catch (e) { log('напоминание: ОШИБКА ' + (e.stack || e.message)); }
            }
        }
        const kept = reminders.filter(r => !r.fired || t - r.start < 3600);
        if (kept.length !== reminders.length) { reminders = kept; changed = true; }
        if (changed) save();
    }

    function start() {
        clearInterval(timer);
        timer = setInterval(tick, TICK_MS);
        if (timer.unref) timer.unref();
    }

    return { search, byRef, refOf, add, list, remove, tick, start, LEAD_SEC };
}

module.exports = { createGuide };
