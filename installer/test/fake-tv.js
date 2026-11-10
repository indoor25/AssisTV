'use strict';
// Поддельный телевизор для проверки установщика без настоящего TV:
// REST на 8001 (сведения, запуск приложения) и sdbd (CNXN, shell:, sysinfo:, sync:).
//   node test/fake-tv.js [версия Tizen]   — запустить отдельно на 127.0.0.1 (8001 и 26101)

const net = require('net');
const http = require('http');

const cmd = (s) => Buffer.from(s, 'ascii').readUInt32LE(0);
const CNXN = cmd('CNXN'), OPEN = cmd('OPEN'), OKAY = cmd('OKAY'), CLSE = cmd('CLSE'), WRTE = cmd('WRTE');

function packet(command, a0, a1, data) {
    const body = data ? Buffer.from(data) : Buffer.alloc(0);
    const h = Buffer.alloc(24);
    h.writeUInt32LE(command, 0); h.writeUInt32LE(a0 >>> 0, 4); h.writeUInt32LE(a1 >>> 0, 8); h.writeUInt32LE(body.length, 12);
    h.writeUInt32LE((command ^ 0xFFFFFFFF) >>> 0, 20);
    return Buffer.concat([h, body]);
}

// opts: { platform, duid, installOutput(packageId, file) → строка, developerMode, developerIP, rest: false — без REST }
function start(opts) {
    const o = Object.assign({ platform: '6.5', duid: 'FAKEDUID12345', developerMode: '1', developerIP: '127.0.0.1', host: '127.0.0.1', sdbPort: 26101, restPort: 8001 }, opts);
    const tv = { files: {}, commands: [], launched: [], installed: [] };

    const sdbd = net.createServer((sock) => {
        let buf = Buffer.alloc(0), nextRemote = 100;
        const streams = new Map(); // remoteId → { localId, service, sync }
        sock.on('error', () => {});
        sock.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            while (buf.length >= 24) {
                const len = buf.readUInt32LE(12);
                if (buf.length < 24 + len) return;
                const c = buf.readUInt32LE(0), a0 = buf.readUInt32LE(4), a1 = buf.readUInt32LE(8), data = Buffer.from(buf.subarray(24, 24 + len));
                buf = buf.subarray(24 + len);
                if (c === CNXN) { sock.write(packet(CNXN, 0x01000000, 4096, 'device::\0')); continue; }
                if (c === OPEN) {
                    const service = data.toString('utf8').replace(/\0/g, '');
                    const id = nextRemote++;
                    const st = { localId: a0, service, sync: Buffer.alloc(0) };
                    streams.set(id, st);
                    sock.write(packet(OKAY, id, a0));
                    const reply = (text) => { sock.write(packet(WRTE, id, a0, text)); sock.write(packet(CLSE, id, a0)); streams.delete(id); };
                    if (service === 'sysinfo:') {
                        const info = Buffer.alloc(64 * 12);
                        info.write('fake', 0); info.write('tv', 64); info.write('2.2.0', 128); info.write(o.platform, 192);
                        reply(info);
                    } else if (service.startsWith('shell:')) {
                        const line = service.slice(6);
                        tv.commands.push(line);
                        if (line === '0 getduid') reply(o.duid + '\n');
                        else if (line.startsWith('0 vd_appinstall ')) {
                            const parts = line.split(' ');
                            const pkgId = parts[2], file = parts[3];
                            const out = o.installOutput ? o.installOutput(pkgId, tv.files[file])
                                : tv.files[file] ? 'app_id[' + pkgId + '] install start\napp_id[' + pkgId + '] installing[50]\napp_id[' + pkgId + '] install completed\nspend time for wascmd is [1234]ms\n'
                                    : 'app_id[' + pkgId + '] install failed[118, -1]\nspend time for wascmd is [10]ms\n';
                            if (/install completed/.test(out)) tv.installed.push(pkgId);
                            reply(out);
                        } else if (line.startsWith('0 vd_appuninstall ')) reply('app_id[' + line.split(' ')[2] + '] uninstall completed\nspend time for wascmd is [100]ms\n');
                        else reply('unknown\n');
                    }
                    continue;
                }
                const st = streams.get(a1);
                if (!st) continue;
                if (c === WRTE) {
                    sock.write(packet(OKAY, a1, st.localId));
                    if (st.service !== 'sync:') continue;
                    st.sync = Buffer.concat([st.sync, data]);
                    // разбор SEND / DATA / DONE / QUIT
                    for (;;) {
                        if (st.sync.length < 8) break;
                        const tag = st.sync.subarray(0, 4).toString('ascii'), n = st.sync.readUInt32LE(4);
                        if (tag === 'SEND' || tag === 'DATA') {
                            if (st.sync.length < 8 + n) break;
                            const body = Buffer.from(st.sync.subarray(8, 8 + n));
                            st.sync = st.sync.subarray(8 + n);
                            if (tag === 'SEND') { st.path = body.toString('utf8').split(',')[0]; st.parts = []; } else st.parts.push(body);
                        } else if (tag === 'DONE') {
                            st.sync = st.sync.subarray(8);
                            tv.files[st.path] = Buffer.concat(st.parts);
                            const okay = Buffer.alloc(8); okay.write('OKAY');
                            sock.write(packet(WRTE, a1, st.localId, okay));
                        } else {
                            st.sync = st.sync.subarray(8);
                        }
                    }
                } else if (c === CLSE) {
                    streams.delete(a1);
                }
            }
        });
    });

    const rest = http.createServer((req, res) => {
        const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (req.url === '/api/v2/') return json(200, { name: '[TV] Fake', device: { name: 'Fake TV', modelName: 'QE55FAKE', model: '22_FAKE', developerMode: o.developerMode, developerIP: o.developerIP, PowerState: 'on' } });
        const m = req.url.match(/^\/api\/v2\/applications\/(.+)$/);
        if (m && req.method === 'POST') { tv.launched.push(decodeURIComponent(m[1])); return json(200, {}); }
        if (m && req.method === 'GET') {
            const id = decodeURIComponent(m[1]);
            const has = (o.installedApps || []).includes(id) || tv.installed.some((p) => id.startsWith(p + '.'));
            return has ? json(200, { id, name: id, running: false, version: '1.0', visible: false }) : json(404, { message: 'Not found' });
        }
        json(404, {});
    });

    tv.ready = Promise.all([
        new Promise((r) => sdbd.listen(o.sdbPort, o.host, r)),
        o.rest === false ? null : new Promise((r) => rest.listen(o.restPort, o.host, r))
    ]).then(() => ({ sdbPort: sdbd.address().port }));
    tv.close = () => { sdbd.close(); if (o.rest !== false) rest.close(); };
    tv.options = o;
    return tv;
}

module.exports = { start };

if (require.main === module) {
    const tv = start({ platform: process.argv[2] || '6.5' });
    tv.ready.then(() => console.log('fake TV: REST 127.0.0.1:8001, sdb 127.0.0.1:26101, Tizen ' + tv.options.platform));
}
