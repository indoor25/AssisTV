/**
 * Процесс-песочница для плагинов-источников (запускает sandbox.js). Node с --experimental-permission:
 * читать можно только папку приложения, писать файлы, запускать программы и потоки нельзя; окружение
 * пустое — токена Supervisor у плагина нет. Сеть есть: плагину нужно ходить к своему сервису.
 *
 * Код плагинов приходит сообщением (сами файлы лежат там, куда песочнице не дотянуться).
 *   → {id, op: 'load', plugins: [{type, code}]}           ← {id, result: {<тип>: {ok, meta?, error?}}}
 *   → {id, op: 'probe', code}                              ← {id, result: [{type, meta}]} — файл перед установкой
 *   → {id, op: 'call', url, method, args}                  ← {id, result} | {id, error}
 */
const path = require('path');

function requireShared(name) {
    try { return require(path.join(__dirname, 'shared', name)); } catch (e) {
        return require(path.join(__dirname, '..', '..', 'js', name));   // запуск из репозитория
    }
}

const METHODS = ['root', 'page', 'details', 'searchRequest', 'filterRequest', 'itemById', 'reviews'];
let VodSources = null;
let clients = new Map();   // адрес источника -> клиент

function load(plugins) {
    // каждый load — с чистого листа: убранный плагин не должен остаться зарегистрированным
    const file = require.resolve(path.join(__dirname, 'shared', 'vod-sources.js'), { paths: [__dirname] });
    delete require.cache[file];
    VodSources = requireShared('vod-sources.js').VodSources;
    clients = new Map();
    const out = {};
    for (const p of plugins) {
        try {
            new Function('VodSources', p.code)(VodSources);
            if (!VodSources.has(p.type)) throw new Error(`не вызвал VodSources.register('${p.type}', …)`);
            out[p.type] = { ok: true, meta: VodSources.meta(p.type) };
        } catch (e) {
            out[p.type] = { ok: false, error: e.message };
        }
    }
    return out;
}

/** Новый файл перед установкой: какие типы он регистрирует и его манифест (в отдельном реестре). */
function probe(code) {
    const file = require.resolve(path.join(__dirname, 'shared', 'vod-sources.js'), { paths: [__dirname] });
    const keep = require.cache[file];
    delete require.cache[file];
    const fresh = requireShared('vod-sources.js').VodSources;
    if (keep) require.cache[file] = keep; else delete require.cache[file];
    new Function('VodSources', code)(fresh);
    return fresh.list().map(type => ({ type, meta: fresh.meta(type) }));
}

async function call(url, method, args) {
    if (METHODS.indexOf(method) < 0) throw new Error('unknown_method');
    let c = clients.get(url);
    if (!c) { c = VodSources.create(url); clients.set(url, c); }
    if (typeof c[method] !== 'function') throw new Error('not_supported');
    return c[method](...(args || []));
}

process.on('message', async msg => {
    try {
        const result = msg.op === 'load' ? load(msg.plugins || [])
            : msg.op === 'probe' ? probe(String(msg.code || ''))
                : await call(msg.url, msg.method, msg.args);
        // через IPC уходит только JSON: функции и прочее из ответа плагина отбрасываются
        process.send({ id: msg.id, result: result === undefined ? null : JSON.parse(JSON.stringify(result)) });
    } catch (e) {
        process.send({ id: msg.id, error: (e && e.message) || String(e) });
    }
});
process.on('unhandledRejection', () => { /* ошибка плагина — уже ушла ответом */ });
