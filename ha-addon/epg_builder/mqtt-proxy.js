/**
 * MQTT для телевизоров через аддон: ws://<аддон>:8765/mqtt, логин — tv_id, пароль — токен привязки
 * (pairing.js). Аддон открывает к Mosquitto своё соединение со своим логином (его выдаёт Supervisor) —
 * поэтому пароль брокера на телевизоры больше не уходит, а телевизор может только своё:
 *
 *   публиковать — iptv/<tv_id>/…, iptv/card/request (выбор из плашки), homeassistant/<тип>/tizen_iptv_<tv_id>/…
 *                 (MQTT Discovery своего прибора);
 *   подписываться — iptv/<tv_id>/…, iptv/playlists.
 *
 * Брокером остаётся Mosquitto: retained, last will, QoS — всё его. Прокси разбирает только пакеты от
 * телевизора (подменяет логин в CONNECT, проверяет топики PUBLISH/SUBSCRIBE и will); от брокера байты идут
 * как есть. Чужой топик — соединение закрывается: настоящий плеер так не делает.
 */
const net = require('net');
const tls = require('tls');
const mqttPacket = require('mqtt-packet');
const { WebSocketServer } = require('ws');

const PATH = '/mqtt';

function canPublish(id, topic) {
    return topic.startsWith(`iptv/${id}/`) || topic === 'iptv/card/request' ||
        new RegExp(`^homeassistant/[a-z_]+/tizen_iptv_${id}/`).test(topic);
}

function canSubscribe(id, filter) {
    // подстановочные знаки — только внутри своих топиков
    return filter === 'iptv/playlists' || filter.startsWith(`iptv/${id}/`);
}

/**
 * server — http.Server аддона; authenticate(username, password) → tv_id | null;
 * upstream() → {url, username, password} брокера (mqtt://host:port или mqtts://…) или null.
 */
function attachMqttProxy({ server, authenticate, upstream, log = () => {} }) {
    const wss = new WebSocketServer({
        noServer: true,
        // mqtt.js в браузере просит подпротокол mqtt
        handleProtocols: (protocols) => (protocols.has('mqtt') ? 'mqtt' : protocols.has('mqttv3.1') ? 'mqttv3.1' : false)
    });
    const byTv = new Map();   // tv_id -> Set(ws) — чтобы закрыть при сбросе привязки

    server.on('upgrade', (req, socket, head) => {
        if (req.url.split('?')[0] !== PATH) { socket.destroy(); return; }
        wss.handleUpgrade(req, socket, head, ws => handle(ws, req));
    });

    function handle(ws, req) {
        const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        const parser = mqttPacket.parser();
        let up = null;
        let tvId = null;
        let opts = { protocolVersion: 4 };
        let closed = false;

        function close(reason) {
            if (closed) return;
            closed = true;
            if (reason) log(`MQTT-прокси: ${tvId || ip} — ${reason}`);
            try { ws.close(); } catch (e) { /* уже */ }
            if (up) up.destroy();
            if (tvId && byTv.has(tvId)) byTv.get(tvId).delete(ws);
        }

        function refuse(code, reason) {
            // CONNACK с отказом: 4 — неверный логин/пароль (v3.1.1), у v5 — 0x86
            const v5 = opts.protocolVersion === 5;
            try { ws.send(mqttPacket.generate({ cmd: 'connack', returnCode: v5 ? 0x86 : code, reasonCode: v5 ? 0x86 : undefined, sessionPresent: false }, opts)); } catch (e) { /* ничего */ }
            close(reason);
        }

        function forward(packet) {
            if (up && !up.destroyed) up.write(mqttPacket.generate(packet, opts));
        }

        parser.on('packet', packet => {
            if (closed) return;
            if (!tvId) {
                if (packet.cmd !== 'connect') return close('первый пакет не CONNECT');
                opts = { protocolVersion: packet.protocolVersion || 4 };
                parser.settings.protocolVersion = opts.protocolVersion;
                const id = authenticate(String(packet.username || ''), packet.password ? packet.password.toString() : '');
                if (!id) return refuse(4, 'неверный токен');
                if (packet.will && !canPublish(id, packet.will.topic)) return refuse(5, `чужой will ${packet.will.topic}`);
                const u = upstream();
                if (!u) return refuse(3, 'нет подключения к брокеру');
                tvId = id;
                if (!byTv.has(id)) byTv.set(id, new Set());
                byTv.get(id).add(ws);
                const target = new URL(u.url);
                const port = +target.port || (target.protocol === 'mqtts:' ? 8883 : 1883);
                up = target.protocol === 'mqtts:'
                    ? tls.connect({ host: target.hostname, port, rejectUnauthorized: false })
                    : net.connect({ host: target.hostname, port });
                up.on('data', d => { if (!closed) ws.send(d); });
                up.on('error', err => close('брокер: ' + err.message));
                up.on('close', () => close());
                packet.username = u.username;
                packet.password = u.password == null ? undefined : Buffer.from(String(u.password));
                forward(packet);
                return;
            }
            if (packet.cmd === 'publish' && !canPublish(tvId, packet.topic)) return close(`чужой топик ${packet.topic}`);
            if (packet.cmd === 'subscribe') {
                const bad = (packet.subscriptions || []).find(s => !canSubscribe(tvId, s.topic));
                if (bad) return close(`подписка на чужое ${bad.topic}`);
            }
            if (packet.cmd === 'connect') return close('второй CONNECT');
            forward(packet);
        });
        parser.on('error', err => close('битый пакет: ' + err.message));

        ws.on('message', data => { if (!closed) parser.parse(Buffer.isBuffer(data) ? data : Buffer.from(data)); });
        ws.on('close', () => close());
        ws.on('error', () => close());
    }

    /** Привязку сбросили — рвём соединения этого телевизора. */
    function disconnectTv(id) {
        for (const ws of byTv.get(id) || []) { try { ws.close(); } catch (e) { /* уже */ } }
        byTv.delete(id);
    }

    return { disconnectTv, PATH };
}

module.exports = { attachMqttProxy, canPublish, canSubscribe };
