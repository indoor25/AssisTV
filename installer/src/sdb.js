'use strict';
// Минимальный клиент sdb (Smart Development Bridge) — по сети, без Tizen Studio.
// Протокол тот же, что у adb: пакет = заголовок 24 байта + данные.
//   command, arg0, arg1, длина данных, сумма байтов данных, command ^ 0xFFFFFFFF
// Умеет ровно то, что нужно установщику: выполнить команду (shell:), прочитать sysinfo:,
// отправить файл (sync:).

const net = require('net');

const cmd = (s) => Buffer.from(s, 'ascii').readUInt32LE(0);
const CNXN = cmd('CNXN'), OPEN = cmd('OPEN'), OKAY = cmd('OKAY'), CLSE = cmd('CLSE'), WRTE = cmd('WRTE');
const MAX_DATA = 4096;

function packet(command, arg0, arg1, data) {
    const body = data ? (Buffer.isBuffer(data) ? data : Buffer.from(data)) : Buffer.alloc(0);
    const head = Buffer.alloc(24);
    let sum = 0;
    for (let i = 0; i < body.length; i++) sum = (sum + body[i]) >>> 0;
    head.writeUInt32LE(command, 0);
    head.writeUInt32LE(arg0 >>> 0, 4);
    head.writeUInt32LE(arg1 >>> 0, 8);
    head.writeUInt32LE(body.length, 12);
    head.writeUInt32LE(sum, 16);
    head.writeUInt32LE((command ^ 0xFFFFFFFF) >>> 0, 20);
    return Buffer.concat([head, body]);
}

class Stream {
    constructor(sdb, localId) {
        this.sdb = sdb;
        this.localId = localId;
        this.remoteId = 0;
        this.chunks = [];
        this.closed = false;
        this.onData = null;
        this._opened = null;
        this._ack = null;
        this._end = [];
    }

    _settle() {
        if (this._opened) { this._opened(this.remoteId !== 0); this._opened = null; }
        if (this._ack) { this._ack(); this._ack = null; }
    }

    // одна порция ≤ MAX_DATA; ждём подтверждения OKAY (не дождались за 5 с — идём дальше)
    _writeChunk(buf) {
        return new Promise((resolve, reject) => {
            if (this.closed) return reject(new Error('stream closed'));
            const timer = setTimeout(() => { this._ack = null; resolve(); }, 5000);
            this._ack = () => { clearTimeout(timer); resolve(); };
            this.sdb.socket.write(packet(WRTE, this.localId, this.remoteId, buf));
        });
    }

    async write(buf) {
        for (let i = 0; i < buf.length; i += MAX_DATA) await this._writeChunk(buf.subarray(i, i + MAX_DATA));
    }

    data() { return Buffer.concat(this.chunks); }

    // ждать закрытия потока (или условия done(текст)); возвращает всё, что пришло
    wait(timeoutMs, done) {
        return new Promise((resolve) => {
            const finish = () => { clearTimeout(timer); this.onData = null; resolve(this.data()); };
            const timer = setTimeout(finish, timeoutMs);
            if (this.closed) return finish();
            this._end.push(finish);
            if (done) this.onData = () => { if (done(this.data().toString('utf8'))) finish(); };
        });
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        try { this.sdb.socket.write(packet(CLSE, this.localId, this.remoteId)); } catch (e) { /* соединение уже закрыто */ }
        this.sdb.streams.delete(this.localId);
    }
}

class Sdb {
    constructor(host, port) {
        this.host = host;
        this.port = port || 26101;
        this.socket = null;
        this.streams = new Map();
        this.nextId = 1;
        this.buf = Buffer.alloc(0);
        this.connected = false;
        this.banner = '';
    }

    connect(timeoutMs = 6000) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const fail = (code, e) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this.close();
                const err = new Error(code);
                err.code = code;
                err.cause = e;
                reject(err);
            };
            const timer = setTimeout(() => fail(this.socket && this.socket.connecting ? 'timeout' : 'no_answer'), timeoutMs);
            this.socket = net.connect({ host: this.host, port: this.port });
            this.socket.setNoDelay(true);
            this.socket.on('connect', () => this.socket.write(packet(CNXN, 0x01000000, MAX_DATA, 'host::\0')));
            this.socket.on('data', (d) => {
                this.buf = Buffer.concat([this.buf, d]);
                this._parse((p) => {
                    if (p.command === CNXN && !settled) {
                        settled = true;
                        clearTimeout(timer);
                        this.connected = true;
                        this.banner = p.data.toString('utf8').replace(/\0/g, '');
                        resolve(this);
                    }
                });
            });
            this.socket.on('error', (e) => fail(e.code === 'ECONNREFUSED' ? 'refused' : e.code === 'ECONNRESET' ? 'reset' : 'network', e));
            // TV молча закрывает соединение, если адрес компьютера не совпал с Host PC IP
            this.socket.on('close', () => { this._drop(); fail('rejected'); });
        });
    }

    _drop() {
        this.connected = false;
        for (const s of this.streams.values()) {
            s.closed = true;
            s._settle();
            s._end.forEach((f) => f());
        }
        this.streams.clear();
    }

    _parse(onControl) {
        while (this.buf.length >= 24) {
            const len = this.buf.readUInt32LE(12);
            if (this.buf.length < 24 + len) return;
            const p = {
                command: this.buf.readUInt32LE(0),
                arg0: this.buf.readUInt32LE(4),
                arg1: this.buf.readUInt32LE(8),
                data: Buffer.from(this.buf.subarray(24, 24 + len))
            };
            this.buf = this.buf.subarray(24 + len);
            if (p.command === CNXN) { onControl(p); continue; }
            const s = this.streams.get(p.arg1);
            if (!s) continue;
            if (p.command === OKAY) {
                if (!s.remoteId) s.remoteId = p.arg0;
                s._settle();
            } else if (p.command === WRTE) {
                s.chunks.push(p.data);
                this.socket.write(packet(OKAY, s.localId, s.remoteId || p.arg0));
                if (s.onData) s.onData();
            } else if (p.command === CLSE) {
                s.closed = true;
                this.streams.delete(s.localId);
                s._settle();
                s._end.forEach((f) => f());
            }
        }
    }

    open(service, timeoutMs = 8000) {
        return new Promise((resolve, reject) => {
            if (!this.connected) return reject(new Error('not connected'));
            const s = new Stream(this, this.nextId++);
            this.streams.set(s.localId, s);
            const timer = setTimeout(() => { s._opened = null; reject(new Error('open timeout: ' + service)); }, timeoutMs);
            s._opened = (ok) => {
                clearTimeout(timer);
                if (ok) resolve(s); else reject(new Error('service refused: ' + service));
            };
            this.socket.write(packet(OPEN, s.localId, 0, service + '\0'));
        });
    }

    // выполнить команду оболочки TV и вернуть её вывод
    async shell(command, timeoutMs = 15000, done) {
        const s = await this.open('shell:' + command);
        const out = await s.wait(timeoutMs, done);
        s.close();
        return out.toString('utf8');
    }

    // версия платформы Tizen, например «6.5» (структура sysinfo: поля по 64 байта)
    async platformVersion() {
        try {
            const s = await this.open('sysinfo:');
            const out = await s.wait(4000, () => s.data().length >= 256);
            s.close();
            const v = out.subarray(192, 256).toString('utf8').replace(/\0.*$/s, '').trim();
            return /^\d+(\.\d+)*$/.test(v) ? v : '';
        } catch (e) {
            return '';
        }
    }

    async duid() {
        const out = (await this.shell('0 getduid', 8000, (t) => /\S{8,}\s+$/.test(t))).trim();
        const m = out.split(/\s+/).pop();
        if (!m || !/^[A-Z0-9]{8,}$/i.test(m)) throw new Error('DUID: ' + out);
        return m;
    }

    // отправить файл на TV (служба sync: SEND → DATA… → DONE → ответ OKAY/FAIL)
    async push(remotePath, data, onProgress) {
        const s = await this.open('sync:');
        const word = (name, n) => { const b = Buffer.alloc(8); b.write(name, 0, 'ascii'); b.writeUInt32LE(n >>> 0, 4); return b; };
        const spec = Buffer.from(remotePath + ',33261', 'utf8'); // 0100755
        await s.write(Buffer.concat([word('SEND', spec.length), spec]));
        const CHUNK = 32 * 1024;
        for (let i = 0; i < data.length; i += CHUNK) {
            const part = data.subarray(i, i + CHUNK);
            await s.write(Buffer.concat([word('DATA', part.length), part]));
            if (onProgress) onProgress(Math.min(1, (i + part.length) / data.length));
        }
        await s.write(word('DONE', Math.floor(Date.now() / 1000)));
        const out = await s.wait(20000, () => s.data().length >= 8);
        const tag = out.subarray(0, 4).toString('ascii');
        if (tag === 'FAIL') {
            const text = out.subarray(8).toString('utf8');
            s.close();
            throw new Error('push failed: ' + text);
        }
        try { await s.write(word('QUIT', 0)); } catch (e) { /* TV уже закрыл поток */ }
        s.close();
        if (tag !== 'OKAY') throw new Error('push: no answer from TV');
    }

    close() {
        if (this.socket) {
            this.socket.removeAllListeners('close');
            this.socket.on('error', () => {});
            this.socket.destroy();
            this.socket = null;
        }
        this._drop();
    }
}

module.exports = { Sdb };
