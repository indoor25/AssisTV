/**
 * Родительский контроль (решения пользователя 16.09.2026): группы каналов под PIN-кодом.
 *
 *   /data/parental.json — { pin: {salt, hash} | null, groups: [имена групп] | null, key }
 *     pin     — PIN не хранится, только соль и sha256; нет PIN — защита выключена целиком;
 *     groups  — защищённые группы; null — ещё не выбирали, тогда по названию (взрослые, adult, xxx, 18+);
 *     key     — случайная строка: с ней аддон пересылает телевизору канал, для которого PIN уже проверен
 *               (карточка HA). Без неё телевизор защищённый канал по MQTT не включает — голос тоже.
 *   У каждого телевизора (реестр tvs.json) — adult_mode: 'lock' (группа с замком, открывается PIN-кодом)
 *   или 'hide' (защищённых каналов на этом TV нет совсем).
 *
 * PIN забыли — задают новый на странице аддона через панель IPTV в Home Assistant: старый не спрашивается,
 * защита — вход в HA (менять PIN и группы можно только через ingress, напрямую на :8765 — нет).
 * Перебор: 5 неверных PIN подряд — минута паузы (отдельно для телевизора и для карточки).
 */
const fs = require('fs');
const crypto = require('crypto');

const DEFAULT_GROUP_RE = /взросл|эрот|adult|xxx|18\s*\+|\+\s*18/i;
const MAX_FAILS = 5;
const PAUSE_MS = 60 * 1000;

function createParental({ file, log }) {
    let data = read();
    const fails = new Map();   // кто вводит -> {count, until}

    function read() {
        let d = null;
        try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* ещё нет */ }
        d = d && typeof d === 'object' ? d : {};
        if (!d.key) d.key = crypto.randomBytes(18).toString('hex');
        if (!('pin' in d)) d.pin = null;
        if (!Array.isArray(d.groups)) d.groups = null;
        return d;
    }

    function save() {
        fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2));
        fs.renameSync(file + '.tmp', file);
    }

    const hash = (salt, pin) => crypto.createHash('sha256').update(salt + ':' + pin).digest('hex');

    function enabled() { return !!data.pin; }

    function validPin(pin) { return /^\d{4}$/.test(String(pin || '')); }

    function setPin(pin) {
        if (!validPin(pin)) throw new Error('PIN — 4 цифры');
        const salt = crypto.randomBytes(8).toString('hex');
        data.pin = { salt, hash: hash(salt, pin) };
        save();
        fails.clear();
        log('родительский контроль: PIN задан');
    }

    function clearPin() {
        data.pin = null;
        save();
        log('родительский контроль: PIN удалён, защита выключена');
    }

    /** who — кто вводит ('tv:<id>' / 'card'). → {ok} | {ok:false, error:'wrong_pin'|'too_many'|'disabled', retry_in?, left?} */
    function check(pin, who) {
        if (!data.pin) return { ok: false, error: 'disabled' };
        const f = fails.get(who) || { count: 0, until: 0 };
        const now = Date.now();
        if (f.until > now) return { ok: false, error: 'too_many', retry_in: Math.ceil((f.until - now) / 1000) };
        if (validPin(pin) && hash(data.pin.salt, String(pin)) === data.pin.hash) {
            fails.delete(who);
            return { ok: true };
        }
        f.count++;
        if (f.count >= MAX_FAILS) {
            f.count = 0;
            f.until = now + PAUSE_MS;
            fails.set(who, f);
            log(`родительский контроль: ${who} — ${MAX_FAILS} неверных PIN, пауза ${PAUSE_MS / 1000} с`);
            return { ok: false, error: 'too_many', retry_in: PAUSE_MS / 1000 };
        }
        fails.set(who, f);
        return { ok: false, error: 'wrong_pin', left: MAX_FAILS - f.count };
    }

    /** Защищённые группы: выбранные на странице, а пока не выбирали — найденные по названию среди allGroups. */
    function groups(allGroups) {
        if (data.groups) return data.groups.slice();
        return (allGroups || []).filter(g => DEFAULT_GROUP_RE.test(g));
    }

    function setGroups(list) {
        data.groups = [...new Set((list || []).map(String).filter(Boolean))];
        save();
        log('родительский контроль: защищённые группы — ' + (data.groups.join(', ') || 'нет'));
    }

    function groupsChosen() { return !!data.groups; }

    /** Что получает телевизор (при регистрации и в iptv/<tv_id>/config). mode — adult_mode телевизора. */
    function forTv(mode, allGroups) {
        if (!enabled()) return { enabled: false, mode: 'lock', groups: [], key: '' };
        return { enabled: true, mode: mode === 'hide' ? 'hide' : 'lock', groups: groups(allGroups), key: data.key };
    }

    /** Для карточки HA (файл в /local виден без входа в HA — ключа там нет). */
    function forCard(mode, allGroups) {
        const p = forTv(mode, allGroups);
        return { enabled: p.enabled, mode: p.mode, groups: p.groups };
    }

    function key() { return data.key; }

    return { enabled, setPin, clearPin, check, groups, setGroups, groupsChosen, forTv, forCard, key, validPin };
}

module.exports = { createParental };
