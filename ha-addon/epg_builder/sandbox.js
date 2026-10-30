/**
 * Песочница плагинов: отдельный процесс plugin-host.js с ограниченными правами (без файлов, без токена
 * Supervisor). Аддон зовёт методы источника через client(url) — те же root/page/details…, только все
 * асинхронные. Процесс упал или завис — перезапускается, плагины загружаются заново.
 */
const path = require('path');
const { fork } = require('child_process');

const CALL_TIMEOUT_MS = 30000;
const SUPPORTS_PERMISSION = (() => {
    const [major, minor] = process.versions.node.split('.').map(Number);
    return major > 20 || (major === 20 && minor >= 0);
})();

function createSandbox({ log = () => {} } = {}) {
    let child = null;
    let seq = 0;
    const waiting = new Map();
    let plugins = [];          // последнее, что загружали — для перезапуска
    let loaded = null;         // Promise результата load

    function start() {
        const dir = __dirname;
        const execArgv = SUPPORTS_PERMISSION
            ? ['--experimental-permission', '--allow-fs-read=' + path.join(dir, '*'), '--no-warnings', '--max-old-space-size=128']
            : ['--max-old-space-size=128'];
        child = fork(path.join(dir, 'plugin-host.js'), [], {
            execArgv,
            // пустое окружение: ни SUPERVISOR_TOKEN, ни паролей MQTT; TZ — чтобы даты у плагина были местные
            env: process.env.TZ ? { TZ: process.env.TZ } : {},
            stdio: ['ignore', 'inherit', 'inherit', 'ipc']
        });
        const me = child;
        child.on('message', m => {
            const w = waiting.get(m.id);
            if (!w) return;
            waiting.delete(m.id);
            clearTimeout(w.timer);
            if (m.error != null) w.reject(new Error(m.error)); else w.resolve(m.result);
        });
        child.on('exit', (code, signal) => {
            if (child !== me) return;
            child = null;
            for (const w of waiting.values()) { clearTimeout(w.timer); w.reject(new Error('plugin_host_exit')); }
            waiting.clear();
            if (code || signal) log(`плагины: процесс песочницы завершился (${code || signal}), перезапуск при следующем вызове`);
            loaded = null;
        });
    }

    function send(msg, timeoutMs = CALL_TIMEOUT_MS) {
        if (!child) start();
        const id = ++seq;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                waiting.delete(id);
                reject(new Error('plugin_timeout'));
                // зависший плагин держит процесс — перезапускаем, чтобы не мешал остальным
                if (child) { try { child.kill(); } catch (e) { /* уже */ } }
            }, timeoutMs);
            waiting.set(id, { resolve, reject, timer });
            child.send(Object.assign({ id }, msg));
        });
    }

    /** plugins: [{type, code}] → {<тип>: {ok, meta?, error?}}. */
    function load(list) {
        plugins = list;
        loaded = send({ op: 'load', plugins: list });
        return loaded;
    }

    /** Какие типы регистрирует файл и с каким манифестом (сам файл ещё не установлен). */
    function probe(code) { return send({ op: 'probe', code }, 10000); }

    async function call(url, method, args) {
        if (!loaded) loaded = send({ op: 'load', plugins });   // после перезапуска процесса
        await loaded;
        return send({ op: 'call', url, method, args });
    }

    /** Клиент источника: методы плагина, все — Promise. sourceType — тип из адреса. */
    function client(url, sourceType) {
        const c = { sourceType, url };
        ['root', 'page', 'details', 'searchRequest', 'filterRequest', 'itemById', 'reviews']
            .forEach(m => { c[m] = (...args) => call(url, m, args); });
        return c;
    }

    function stop() { if (child) { const c = child; child = null; c.kill(); } }

    return { load, probe, call, client, stop, permissionModel: SUPPORTS_PERMISSION };
}

module.exports = { createSandbox };
