/**
 * Привязка телевизора к аддону по коду (как Bluetooth): новый плеер присылает /tvs/register без токена —
 * аддон заводит заявку с кодом из 6 цифр, телевизор показывает код на экране, на странице аддона в HA
 * (только через панель — ingress) заявку с тем же кодом подтверждают. Следующий опрос телевизора получает
 * токен, дальше он ходит с ним: Authorization: Bearer <токен> в HTTP и паролем в MQTT (mqtt-proxy.js).
 *
 * Токен на диске не хранится — только sha256 (у записи телевизора tokenHash). Потерял токен (сбросили
 * приложение) — привязка заново. Заявки живут в памяти TTL_MS: перезапуск аддона их теряет, телевизор
 * просто получит новый код.
 */
const crypto = require('crypto');

const TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 10;          // больше заявок разом не держим — чтобы их нельзя было завалить запросами

function makeToken() {
    return crypto.randomBytes(24).toString('base64url');
}

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function makeCode() {
    return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function createPairing({ log = () => {} } = {}) {
    const pending = new Map();     // duid -> {id, duid, model, ip, code, createdAt, expiresAt, token?}

    function sweep() {
        const now = Date.now();
        for (const [duid, p] of pending) if (p.expiresAt <= now) pending.delete(duid);
    }

    /** Заявка телевизора (повторный опрос — та же заявка и тот же код). → заявка или null, если их слишком много. */
    function request({ duid, model, ip }) {
        sweep();
        let p = pending.get(duid);
        if (!p) {
            if (pending.size >= MAX_PENDING) return null;
            p = { id: crypto.randomBytes(6).toString('hex'), duid, model, ip, code: makeCode(), createdAt: Date.now() };
            pending.set(duid, p);
            log(`привязка: заявка ${model || duid} (${ip}), код ${p.code}`);
        }
        p.model = model || p.model;
        p.ip = ip;
        // пока телевизор опрашивает, заявка не протухает; подтверждённая ждёт его не дольше TTL
        if (!p.token) p.expiresAt = Date.now() + TTL_MS;
        return p;
    }

    /** Заявки для страницы аддона. */
    function list() {
        sweep();
        return [...pending.values()].filter(p => !p.token)
            .map(p => ({ id: p.id, duid: p.duid, model: p.model, ip: p.ip, code: p.code, createdAt: p.createdAt }));
    }

    function byId(id) {
        sweep();
        return [...pending.values()].find(p => p.id === id) || null;
    }

    /** Подтвердили на странице: токен выдаётся телевизору при следующем опросе. → заявка с token или null. */
    function approve(id) {
        const p = byId(id);
        if (!p || p.token) return p;
        p.token = makeToken();
        p.expiresAt = Date.now() + TTL_MS;
        log(`привязка: подтверждена ${p.model || p.duid} (${p.ip})`);
        return p;
    }

    function reject(id) {
        const p = byId(id);
        if (p) { pending.delete(p.duid); log(`привязка: отклонена ${p.model || p.duid} (${p.ip})`); }
        return !!p;
    }

    /** Токен ушёл телевизору — заявка больше не нужна. */
    function done(duid) { pending.delete(duid); }

    return { request, list, approve, reject, done, byId };
}

module.exports = { createPairing, makeToken, hashToken, TTL_MS };
