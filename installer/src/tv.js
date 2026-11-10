'use strict';
// Поиск телевизоров Samsung в домашней сети и их сведения (REST телевизора, порт 8001).

const os = require('os');
const net = require('net');

const unxml = (s) => s.replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// открыт ли порт — быстрый отсев адресов, где телевизора нет
function portOpen(ip, port, timeoutMs) {
    return new Promise((resolve) => {
        const s = net.connect({ host: ip, port });
        const done = (v) => { s.destroy(); resolve(v); };
        s.setTimeout(timeoutMs, () => done(false));
        s.on('connect', () => done(true));
        s.on('error', () => done(false));
    });
}

async function getJson(url, timeoutMs, method) {
    const res = await fetch(url, { method: method || 'GET', signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, json: await res.json().catch(() => null) };
}

// сведения о телевизоре или null, если по адресу не Samsung TV
async function probe(ip, timeoutMs = 1500) {
    let r;
    try { r = await getJson('http://' + ip + ':8001/api/v2/', timeoutMs); } catch (e) { return null; }
    const d = r.json && r.json.device;
    if (!d) return null;
    const model = String(d.model || '');
    const year = /^(\d\d)_/.test(model) ? 2000 + Number(model.slice(0, 2)) : 0;
    return {
        ip,
        // Samsung отдаёт имя с HTML-мнемониками: 55&quot; Neo QLED
        name: unxml(String(d.name || r.json.name || d.modelName || 'Samsung TV')),
        modelName: String(d.modelName || ''),
        year,
        // '1' / '0' / '' (старые прошивки не сообщают)
        developerMode: d.developerMode === undefined ? '' : String(d.developerMode),
        developerIP: d.developerIP === undefined ? '' : String(d.developerIP),
        power: String(d.PowerState || '')
    };
}

function localAddresses() {
    const out = [];
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs)) {
        for (const a of ifs[name] || []) {
            if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
        }
    }
    return out;
}

// обойти все адреса /24 каждой своей сети
async function scan(onFound) {
    const seen = new Set();
    const targets = [];
    for (const addr of localAddresses()) {
        const base = addr.split('.').slice(0, 3).join('.');
        if (seen.has(base)) continue;
        seen.add(base);
        for (let i = 1; i < 255; i++) if (base + '.' + i !== addr) targets.push(base + '.' + i);
    }
    const found = [];
    let next = 0;
    const worker = async () => {
        while (next < targets.length) {
            const ip = targets[next++];
            const tv = (await portOpen(ip, 8001, 800)) ? await probe(ip, 3000) : null;
            if (tv) { found.push(tv); if (onFound) onFound(tv); }
        }
    };
    await Promise.all(Array.from({ length: 128 }, worker));
    found.sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
    return found;
}

// адрес этого компьютера, с которого он виден телевизору (его и вписывают в Host PC IP)
function pcAddressFor(tvIp) {
    return new Promise((resolve) => {
        const s = net.connect({ host: tvIp, port: 8001 });
        const done = (v) => { s.destroy(); resolve(v); };
        s.setTimeout(3000, () => done(''));
        s.on('connect', () => done(s.localAddress || ''));
        s.on('error', () => done(''));
    });
}

// стоит ли приложение на телевизоре (true / false; null — телевизор не ответил)
async function isInstalled(ip, appId) {
    try {
        const r = await getJson('http://' + ip + ':8001/api/v2/applications/' + encodeURIComponent(appId), 5000);
        if (r.status === 404) return false;
        return !!(r.status === 200 && r.json && r.json.id);
    } catch (e) {
        return null;
    }
}

async function launch(ip, appId) {
    try {
        const r = await getJson('http://' + ip + ':8001/api/v2/applications/' + encodeURIComponent(appId), 8000, 'POST');
        return r.status >= 200 && r.status < 300;
    } catch (e) {
        return false;
    }
}

module.exports = { probe, scan, pcAddressFor, launch, isInstalled, localAddresses };
