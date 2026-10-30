#!/usr/bin/env node
/**
 * Проверка источников фильмов (плагинов): node tools/vod-sources-test.js
 *
 * Сети не требуется — сервисы и аддон отвечают заглушками. Части:
 *   1. реестр: разбор адреса <тип>::[k:v;k:v]<url>, составные id, совместимость со старыми записями;
 *      плагины в аддоне (plugins.js + песочница): старая папка и установка файлом, манифест, сломанный не
 *      мешает остальным; избранное: старые записи без источника, один фильм из двух источников;
 *   2. vod.js аддона: поиск и карточка через песочницу, составные id, список озвучек;
 *   3. телевизор: скачивание копий плагинов у аддона, кеш по sha1, работа без аддона;
 *   4. пример плагина из docs/vod-plugins.md работает — инструкция не разошлась с кодом.
 * Протокол видеопортала проверяется в закрытом репозитории плагинов (tools/portal-test.js).
 *
 * Выход с кодом 1, если что-то не так.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const ADDON = path.join(ROOT, 'ha-addon', 'epg_builder');
const EXAMPLE_DIR = path.join(ROOT, 'docs');   // здесь лежит vod-plugin-example.js

let passed = 0;
const ok = (c, n) => { assert.ok(c, n); passed++; };
const eq = (a, b, n) => { assert.deepStrictEqual(a, b, n + ` (получили ${JSON.stringify(a)})`); passed++; };
const fresh = (...p) => {
    const file = path.join(...p);
    delete require.cache[require.resolve(file)];
    return require(file);
};

// ───────────────────────── 1. реестр, плагины, избранное ─────────────────────────

async function testRegistry() {
    const { VodSources } = fresh(ROOT, 'js', 'vod-sources.js');

    eq(VodSources.parseUrl('portal::[key:ABC]http://h/api/v1/'),
        { type: 'portal', params: { key: 'ABC' }, url: 'http://h/api/v1/' }, 'старый адрес портала');
    eq(VodSources.parseUrl('portal::[key:ABC;reviews:own]http://h/'),
        { type: 'portal', params: { key: 'ABC', reviews: 'own' }, url: 'http://h/' }, 'несколько параметров');
    eq(VodSources.parseUrl('jellyfin::http://h:8096/'),
        { type: 'jellyfin', params: {}, url: 'http://h:8096/' }, 'источник без параметров');
    eq(VodSources.parseUrl('http://host/playlist.m3u8'), null, 'обычный M3U — не источник');
    ok(VodSources.isSourceUrl('portal::[key:X]http://h/'), 'isSourceUrl: портал');
    ok(!VodSources.isSourceUrl('http://h/list.m3u'), 'isSourceUrl: M3U');

    eq(VodSources.splitId('portal:48357'), { type: 'portal', localId: '48357' }, 'разбор составного id');
    eq(VodSources.splitId('48357'), { type: 'portal', localId: '48357' }, 'старый id без источника = portal');
    eq(VodSources.splitId(48357), { type: 'portal', localId: '48357' }, 'числовой id');
    eq(VodSources.makeId('portal', 48357), 'portal:48357', 'сборка id');
    ok(VodSources.sameId('48357', 'portal:48357'), 'старый и новый id — один фильм');
    ok(!VodSources.sameId('portal:48357', 'jellyfin:48357'), 'одинаковый номер у разных источников — разные фильмы');

    // ───── плагины в аддоне: песочница, старая папка, установка файлом ─────
    const { createPlugins } = fresh(ADDON, 'plugins.js');
    const { createSandbox } = fresh(ADDON, 'sandbox.js');
    const logs = [];
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-plugins-'));
    const dirs = { builtinDir: path.join(tmp, 'builtin'), legacyDir: path.join(tmp, 'legacy'), userDir: path.join(tmp, 'user') };
    Object.values(dirs).forEach(d => fs.mkdirSync(d));
    const sandbox = createSandbox({ log: m => logs.push(m) });
    const plugins = createPlugins(Object.assign({ stateFile: path.join(tmp, 'plugins.json'), sandbox, VodSources, log: m => logs.push(m) }, dirs));
    await plugins.load();
    eq(plugins.report(), [], 'плагинов нет — пустой список');

    // плагин в старой папке подхватывается, строка из опций переносится в его настройки
    fs.copyFileSync(path.join(EXAMPLE_DIR, 'vod-plugin-example.js'), path.join(dirs.legacyDir, 'example.js'));
    await plugins.load();
    eq(plugins.report().map(p => [p.type, p.origin, p.error]), [['example', 'legacy', null]], 'плагин из старой папки');
    plugins.importLegacy([{ name: 'Кино', url: 'example::[key:K1]http://example.invalid/' }]);
    eq(plugins.sources().map(s => [s.name, s.src, s.url, s.offline]), [['Кино', 'example', 'example::[key:K1]http://example.invalid/', true]],
        'строка из опций стала настройками плагина');
    eq(plugins.managedTypes(), ['example'], 'тип ведёт раздел «Плагины»');
    ok(plugins.code('example').includes("VodSources.register('example'"), 'код отдаётся телевизору');
    eq(plugins.code('нет-такого'), null, 'несуществующий плагин — null');

    // установка файлом: манифест читается в песочнице, новый — выключен
    const r = await plugins.install("VodSources.register('stub2', { meta: { name: 'Заглушка', version: '2.0' }, create: () => ({ root: async () => ({ categories: [] }) }) });");
    eq([r.type, r.meta.version, r.updated], ['stub2', '2.0', false], 'установлен из кода');
    ok(fs.existsSync(path.join(dirs.userDir, 'stub2.js')), 'файл лёг в папку плагинов');
    ok(!plugins.sources().some(s => s.src === 'stub2'), 'новый плагин выключен, пока не настроен');
    await plugins.update('stub2', { enabled: true, settings: { url: 'http://s/' } });
    ok(plugins.sources().some(s => s.src === 'stub2' && !s.offline), 'включили — появился, без копии на TV');
    await assert.rejects(() => plugins.update('stub2', { settings: { url: 'http://s/;x' } }), /bad_value/, 'значение с «;»');
    passed++;
    await assert.rejects(() => plugins.install('var x = 1;'), /no_register/, 'не плагин');
    passed++;

    // сломанный плагин не валит остальные
    fs.writeFileSync(path.join(dirs.userDir, 'broken.js'), 'это не javascript (((');
    await plugins.load();
    ok(plugins.report().find(p => p.type === 'broken').error, 'про сломанный плагин сказано в отчёте');
    ok(plugins.sources().some(s => s.src === 'example') && plugins.sources().some(s => s.src === 'stub2'), 'сломанный не мешает остальным');
    ok(!plugins.list().some(p => p.type === 'broken'), 'сломанный телевизору не раздаётся');
    eq(plugins.list({ offlineOnly: true }).map(p => p.type), ['example'], 'копии на TV — только у разрешённых');

    await plugins.remove('stub2');
    ok(!fs.existsSync(path.join(dirs.userDir, 'stub2.js')) && !plugins.sources().some(s => s.src === 'stub2'), 'удаление');
    sandbox.stop();

    const ex = (() => { const V = fresh(ROOT, 'js', 'vod-sources.js').VodSources;
        new Function('VodSources', fs.readFileSync(path.join(EXAMPLE_DIR, 'vod-plugin-example.js'), 'utf8'))(V);
        return { V, c: V.create('example::[key:K1]http://example.invalid/') }; })();
    eq(ex.c.sourceType, 'example', 'клиент знает свой тип');
    eq(ex.c.params, { key: 'K1' }, 'параметры из адреса дошли до плагина');
    assert.throws(() => ex.V.create('unknown::http://h/'), /не установлен/, 'неизвестный тип');
    passed++;
    assert.throws(() => ex.V.create('http://h/x.m3u'), /не похож на источник/, 'M3U не источник');
    passed++;
    eq(ex.V.makeUrl('example', 'http://h/', { key: 'K', empty: '' }), 'example::[key:K]http://h/', 'makeUrl — обратное parseUrl');
    const userDir = tmp;

    // ───── избранное: старые записи и два источника ─────
    const favFile = path.join(userDir, 'favorites.json');
    fs.writeFileSync(favFile, JSON.stringify({
        items: [{ fid: 48357, title: 'Матрица', year: 1999, kind: 'movie', addedAt: 1 }]   // запись «до плагинов»
    }));
    const { createFavorites } = fresh(ADDON, 'favorites.js');
    const fav = createFavorites({ file: favFile, log: () => {} });
    eq(fav.list().length, 1, 'старое избранное прочиталось');
    ok(fav.has('portal:48357'), 'старая запись находится по составному id');
    ok(fav.has(48357), 'и по старому fid тоже');
    ok(!fav.has('example:48357'), 'у другого источника тот же номер — это не она');

    fav.set({ id: 'example:48357', title: 'Интерстеллар', year: 2014 }, true);
    eq(fav.list().length, 2, 'одинаковый номер из другого источника — отдельная запись');
    eq(fav.find('example:48357').src, 'example', 'источник записан');
    eq(fav.find('portal:48357').title, 'Матрица', 'старая запись не затронута');

    fav.set({ fid: 48357, title: 'Матрица' }, false);   // карточка HA шлёт fid без источника
    ok(!fav.has('portal:48357'), 'удаление по старому fid работает');
    ok(fav.has('example:48357'), 'чужая запись при этом осталась');

    const again = createFavorites({ file: favFile, log: () => {} });
    eq(again.list().length, 1, 'запись пережила перезапуск');
    eq(again.list()[0].id, 'example:48357', 'и сохранилась с составным id');

    fs.rmSync(userDir, { recursive: true, force: true });
}

// ───────────────────────── 2. vod.js аддона ─────────────────────────

async function testAddonVod() {
    const { createSandbox } = fresh(ADDON, 'sandbox.js');
    const sandbox = createSandbox();
    const loaded = await sandbox.load([{ type: 'example', code: fs.readFileSync(path.join(EXAMPLE_DIR, 'vod-plugin-example.js'), 'utf8') }]);
    ok(loaded.example && loaded.example.ok, 'плагин-пример загрузился в песочницу');
    // заглушки ниже (poster-test, second) регистрируются прямо здесь; их клиенты — асинхронные, как из песочницы
    const { VodSources } = fresh(ADDON, 'shared', 'vod-sources.js');
    const clientFor = (url, type) => {
        if (!VodSources.has(type)) return sandbox.client(url, type);
        const c = VodSources.create(url);
        const out = { sourceType: type };
        ['root', 'page', 'details', 'searchRequest', 'filterRequest', 'itemById'].forEach(m => { out[m] = async (...a) => c[m](...a); });
        return out;
    };

    const { createVod } = fresh(ADDON, 'vod.js');
    const vod = createVod({
        getSourceUrls: () => ['example::[key:K1;reviews:kinopoisk]http://example.invalid/'],
        clientFor,
        wwwDir: path.join(os.tmpdir(), 'iptv-www-test'),
        log: () => {},
        tmdb: { enabled: () => false },
        kp: { enabled: () => false }
    });

    const r = await vod.search('интерстеллар');
    eq(r.src, 'example', 'поиск сказал, в каком источнике искал');
    eq(r.results.length, 1, 'нашёлся один фильм');
    eq(r.results[0].id, 'example:1', 'id составной');
    eq(r.results[0].src, 'example', 'источник указан');
    eq(r.results[0].fid, '1', 'собственный номер источника рядом');
    ok(r.best, 'уверенное совпадение есть');

    const r2 = await vod.search('такого фильма нет');
    eq(r2.results, [], 'ничего не нашлось');
    eq(r2.best, null, 'best пустой');

    const d = await vod.details('example:1');
    eq(d.id, 'example:1', 'карточка знает составной id');
    eq(d.streams.map(s => s.name), ['Дубляж', 'Netflix', '1+1studio'], 'озвучки перечислены');
    eq(d.streams.map(s => s.id), [56, 111, 232], 'у озвучек свои id');

    const one = await vod.details('example:2');
    eq(one.streams, [], 'одна ссылка — список озвучек пустой (кнопка «Смотреть», как раньше)');
    eq(one.kind, 'movie', 'это фильм');

    const ser = await vod.details('example:3');
    eq(ser.kind, 'series', 'это сериал');
    eq(ser.episodes.map(e => e.id), ['example:3-1', 'example:3-2'], 'у серий составные id');

    await assert.rejects(() => vod.details('portal:48357'), /no_portal/, 'источник не настроен — no_portal');
    passed++;
    await assert.rejects(() => vod.details('48357'), /no_portal/, 'старый id без источника ищется у portal');
    passed++;

    // ── скачивание постера и защита избранного от очистки кеша ──
    VodSources.register('poster-test', {
        create() {
            return {
                async root() { return {}; },
                searchRequest() { return {}; },
                async page() { return { items: [{ fid: '1', title: 'Тестовый постер', poster: 'https://poster.test/1.jpg' }] }; },
                itemById(fid) { return { fid }; },
                async details(item) { return { item, streams: [] }; }
            };
        }
    });
    const posterDir = path.join(os.tmpdir(), `iptv-poster-cache-${process.pid}`);
    fs.rmSync(posterDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(posterDir, 'posters'), { recursive: true });
    for (let i = 0; i < 600; i++) {
        const file = path.join(posterDir, 'posters', `old_${i}.jpg`);
        fs.writeFileSync(file, 'old');
        fs.utimesSync(file, new Date(1000 + i * 1000), new Date(1000 + i * 1000));
    }
    const posterVod = createVod({
        getSourceUrls: () => ['poster-test::http://poster.test/'], clientFor, wwwDir: posterDir,
        log: () => {}, tmdb: { enabled: () => false }, kp: { enabled: () => false }
    });
    posterVod.setPinnedPosters(['poster-test:1']);
    const originalFetch = global.fetch;
    let posterFetches = 0;
    global.fetch = async () => { posterFetches++; return { ok: true, arrayBuffer: async () => Buffer.from('poster-bytes') }; };
    try {
        const result = await posterVod.search('тестовый постер');
        eq(result.results[0].poster, '/local/tizen-iptv/posters/poster-test_1.jpg', `адрес скачанного постера канонический (fetch=${posterFetches})`);
        eq(fs.readFileSync(path.join(posterDir, 'posters', 'poster-test_1.jpg'), 'utf8'), 'poster-bytes', 'скачанный постер записан в кеш');
        ok(fs.existsSync(path.join(posterDir, 'posters', 'poster-test_1.jpg')), 'постер избранного пережил очистку переполненного кеша');
        eq(posterVod.cachedPoster('poster-test:1'), '/local/tizen-iptv/posters/poster-test_1.jpg', 'найден локальный постер из кеша');
    } finally {
        global.fetch = originalFetch;
        fs.rmSync(posterDir, { recursive: true, force: true });
    }

    // ── качество в запросе ──
    const { parseQuery, parseQuality } = fresh(ADDON, 'vod.js');
    const pq = s => { const p = parseQuery(s); return [p.text, p.quality, p.hdr]; };
    eq(pq('включи матрицу в 4К'), ['матрицу', '2160', false], '«в 4К» — качество, а не название');
    eq(pq('матрица full hd'), ['матрица', '1080', false], 'full hd');
    eq(pq('дюна 1080p hdr'), ['дюна', '1080', true], '1080p и HDR');
    eq(pq('дюна в лучшем качестве'), ['дюна', 'max', false], 'в лучшем качестве');
    eq(pq('хороший доктор'), ['хороший доктор', null, false], '«хороший» без слова «качество» — название');
    eq(pq('дюна 2021'), ['дюна', null, false], 'год качеством не считается');
    eq(parseQuality('4K'), { quality: '2160', hdr: false }, 'поле качества: 4K');
    eq(parseQuality('hd'), { quality: '720', hdr: false }, 'поле качества: hd');
    eq(parseQuality('best'), { quality: 'max', hdr: false }, 'поле качества: best');
    eq(parseQuality('ерунда'), { quality: null, hdr: false }, 'поле качества: непонятное — не просили');

    // ── поиск по всем источникам по очереди ──
    const asked = [];
    const SECOND = [
        { type: 'stream', fid: 'd', title: 'Дежавю', year: 2006 },
        { type: 'stream', fid: 'm', title: 'Матрица', year: 1999 },
        { type: 'stream', fid: 'm4', title: 'Матрица', year: 1999, uhd: true },
        { type: 'stream', fid: 'i', title: 'Интерстеллар', year: 2014 },
        { type: 'stream', fid: 'o', title: 'Интер', year: 2020 }
    ];
    VodSources.register('second', {
        create() {
            return {
                async root() { return {}; },
                searchRequest(root, text) { return { query: text }; },
                async page(request) {
                    asked.push(request.query);
                    return { items: SECOND.filter(f => f.title.toLowerCase().includes(request.query)) };
                },
                itemById(id) { return { fid: id }; },
                async details() { throw new Error('не нужно'); }
            };
        }
    });
    const both = createVod({
        getSourceUrls: () => ['example::[key:K1]http://example.invalid/', 'second::http://second.invalid/'],
        clientFor,
        wwwDir: path.join(os.tmpdir(), 'iptv-www-test'),
        log: () => {},
        tmdb: { enabled: () => false },
        kp: {
            enabled: () => true,
            enrich: async ({ title }) => /дежавю/i.test(title)
                ? { id: 1, kind: 'movie', title: 'Дежавю', year: 2006, rating: 7.5, votes: 1000, genres: ['фантастика'], description: 'Агент расследует взрыв парома.' }
                : null
        }
    });

    const a1 = await both.searchAll('интерстеллар');
    eq(a1.best.id, 'example:1', 'есть в первом источнике — берётся из него');
    eq(a1.tried, ['example'], 'второй источник при этом не опрашивается');
    eq(asked, [], 'запросов во второй источник не было');

    const a2 = await both.searchAll('дежавю');
    eq(a2.best.id, 'second:d', 'нет в первом — нашлось во втором');
    eq(a2.tried, ['example', 'second'], 'искали в обоих по порядку');

    const a3 = await both.searchAll('такого фильма нет');
    eq([a3.best, a3.results], [null, []], 'нет нигде — пусто');
    eq(a3.tried, ['example', 'second'], 'обошли все источники');

    const weak = await both.searchAll('интер');
    eq(weak.best.id, 'second:o', 'в первом совпало лишь частично («Интерстеллар») — берётся точное из второго');
    eq(weak.tried, ['example', 'second'], 'слабое совпадение не остановило обход');
    eq(weak.all.slice(0, 2).map(x => x.id), ['second:o', 'example:1'], 'all — похожие из обоих источников, лучшие первыми');

    const first = await both.search('дежавю');
    eq(first.results, [], 'search без источника по-прежнему ищет только в первом');

    eq((await both.searchAll('матрица')).best.id, 'second:m', 'без просьбы о качестве — обычная версия');
    const uhd = await both.searchAll('матрица в 4к');
    eq([uhd.best.id, uhd.quality], ['second:m4', '2160'], '«в 4К» — запись 4K, качество вернулось отдельно');
    eq((await both.searchAll('матрица', { quality: '4K' })).best.id, 'second:m4', 'качество отдельным полем');
    eq((await both.searchAll('матрица', { quality: '720p' })).best.id, 'second:m', 'просили 720 — обычная версия');

    // ── рейтинг и описание ──
    const inf = await both.info('дежавю');
    eq([inf.title, inf.year, inf.kpRating, inf.available, inf.id], ['Дежавю', 2006, 7.5, true, 'second:d'],
        'рейтинг из каталога, заодно — где фильм можно включить');
    ok(/паром/.test(inf.description), 'описание на месте');
    eq(await both.info('такого фильма нет'), null, 'каталоги фильм не знают — null');
    sandbox.stop();
}

// ───────────────────────── 3. телевизор скачивает копии плагинов ─────────────────────────

async function testTvLoader() {
    const store = {};
    global.localStorage = {
        getItem: k => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: k => { delete store[k]; }
    };
    global.I18n = { t: (k, p) => k + (p ? JSON.stringify(p) : '') };

    const exampleCode = fs.readFileSync(path.join(EXAMPLE_DIR, 'vod-plugin-example.js'), 'utf8');
    const stubCode = "VodSources.register('stub', { create: () => ({ itemById: id => ({ fid: id }) }) });";
    const served = {
        '/vod-sources.json': { sources: [{ type: 'example', sha1: 'aaa1' }, { type: 'stub', sha1: 'bbb2' }] },
        '/vod-sources/example.js': exampleCode,
        '/vod-sources/stub.js': stubCode
    };
    let hits = [];
    let offline = false;
    global.fetch = async (url) => {
        const p = url.replace('http://addon', '');
        hits.push(p);
        if (offline) throw new Error('сеть недоступна');
        const body = served[p];
        if (body === undefined) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
        return { ok: true, status: 200, json: async () => body, text: async () => String(body) };
    };

    const load = () => {
        global.VodSources = fresh(ROOT, 'js', 'vod-sources.js').VodSources;
        return fresh(ROOT, 'js', 'addon-client.js').AddonClient;
    };

    let client = load();
    let r = await client.loadVodSources('http://addon');
    eq(r.loaded.sort(), ['example', 'stub'], 'оба плагина выполнились');
    eq(r.failed, [], 'ошибок нет');
    eq(r.fromCache, false, 'взяты с аддона');
    ok(hits.includes('/vod-sources/example.js'), 'код плагина скачан');
    ok(store['tizeniptv.addon.sources.v1'], 'код положен в кеш');
    eq(global.VodSources.create('example::[key:ABC]http://h/').sourceType, 'example', 'выполненный из скачанного кода плагин рабочий');

    hits = [];
    client = load();
    r = await client.loadVodSources('http://addon');
    eq(r.loaded.sort(), ['example', 'stub'], 'плагины снова выполнились');
    eq(hits.filter(h => h.endsWith('.js')), [], 'код взят из кеша, сеть не трогали');

    hits = [];
    served['/vod-sources.json'] = { sources: [{ type: 'example', sha1: 'NEW' }, { type: 'stub', sha1: 'bbb2' }] };
    client = load();
    await client.loadVodSources('http://addon');
    eq(hits.filter(h => h.endsWith('.js')), ['/vod-sources/example.js'], 'перекачан только изменившийся плагин');

    offline = true;
    client = load();
    r = await client.loadVodSources('http://addon');
    eq(r.fromCache, true, 'аддон недоступен — помечено, что из кеша');
    eq(r.loaded.sort(), ['example', 'stub'], 'плагины из кеша выполнились');
    ok(r.error, 'ошибка сети названа');
    offline = false;

    served['/vod-sources.json'] = { sources: [{ type: 'example', sha1: 'aaa1' }, { type: 'broken', sha1: 'ccc3' }] };
    served['/vod-sources/broken.js'] = 'это не javascript (((';
    delete store['tizeniptv.addon.sources.v1'];
    client = load();
    r = await client.loadVodSources('http://addon');
    eq(r.loaded, ['example'], 'рабочий плагин загрузился');
    eq(r.failed.map(f => f.type), ['broken'], 'сломанный попал в failed');

    served['/vod-sources.json'] = { sources: [{ type: 'silent', sha1: 'ddd4' }] };
    served['/vod-sources/silent.js'] = 'var x = 1;';
    delete store['tizeniptv.addon.sources.v1'];
    client = load();
    r = await client.loadVodSources('http://addon');
    eq(r.loaded, [], 'плагин без register не загружен');
    ok(/register/.test(r.failed[0].error), 'сказано, что register не вызван');

    client = load();
    r = await client.loadVodSources('');
    eq(r.fromCache, true, 'без адреса аддона — только кеш');
}

// ───────────────────────── 4. пример плагина из инструкции работает ─────────────────────────

/**
 * Минимальный плагин напечатан в docs/vod-plugins.md — берём его прямо оттуда и гоняем на
 * выдуманном сервисе. Так инструкция не разойдётся с кодом: сломается формат — упадёт этот прогон.
 */
async function testDocExample() {
    const { VodSources } = fresh(ROOT, 'js', 'vod-sources.js');
    const md = fs.readFileSync(path.join(ROOT, 'docs', 'vod-plugins.md'), 'utf8');
    const code = md.split('```js').slice(1).map(b => b.split('```')[0])
        .filter(b => b.includes("VodSources.register('example'") && b.includes('itemById')).pop();
    ok(code, 'в инструкции есть полный пример плагина');

    const json = o => ({ ok: true, status: 200, json: async () => o });
    const fakeFetch = async (url, opts) => {
        eq((opts.headers || {})['X-Api-Key'], 'МОЙ_КЛЮЧ', 'ключ из настроек ушёл в заголовке');
        const u = url.replace('http://service', '');
        if (u === '/categories') return json([{ id: 7, name: 'Фильмы' }, { id: 8, name: 'Сериалы' }]);
        if (u.startsWith('/movies?cat=')) {
            const page = +(/page=(\d+)/.exec(u) || [, 1])[1];
            return json({
                total: 3, has_more: page < 2,
                items: [{ id: 100 + page, name: 'Фильм ' + page, release_year: 2000 + page }]
            });
        }
        if (u.startsWith('/search?q=')) return json({ total: 1, has_more: false, items: [{ id: 555, name: 'Интерстеллар', release_year: 2014 }] });
        if (u === '/movies/555') {
            return json({
                id: 555, name: 'Интерстеллар', release_year: 2014, overview: 'Про космос.', runtime: 169,
                sources: [
                    { id: 56, dub_name: 'Дубляж', url: 'http://s/dub.m3u8', qualities: { auto: 'http://s/a.m3u8', 1080: 'http://s/1080.m3u8' } },
                    { id: 111, dub_name: 'Netflix', url: 'http://s/nf.m3u8' }
                ]
            });
        }
        if (u === '/movies/900') return json({ id: 900, name: 'Сериал', is_series: true, episodes: [{ id: 901, name: 'Серия 1' }] });
        return { ok: false, status: 404, json: async () => ({}) };
    };

    new Function('VodSources', 'fetch', code)(VodSources, fakeFetch);
    const c = VodSources.create('example::[key:МОЙ_КЛЮЧ]http://service/');

    const root = await c.root();
    eq(root.categories.map(x => x.title), ['Фильмы', 'Сериалы'], 'категории из сервиса');
    const p1 = await c.page(root.categories[0].request);
    eq(p1.items[0].fid, '101', 'страница разобрана');
    eq(p1.count, 3, 'всего элементов');
    const p2 = await c.page(p1.nextRequest);
    eq(p2.items[0].title, 'Фильм 2', 'догрузка следующей страницы');
    eq(p2.nextRequest, null, 'дальше страниц нет');

    const s = await c.page(c.searchRequest(root, 'интерстеллар'));
    eq(s.items[0].fid, '555', 'поиск нашёл');
    const d = await c.details(s.items[0]);
    eq(d.item.duration, 169, 'длительность в карточке');
    eq(d.streams.map(x => x.name), ['Дубляж', 'Netflix'], 'две озвучки');
    eq(d.streams[0].variants['1080'], 'http://s/1080.m3u8', 'качества у озвучки');
    eq(d.episodes, [], 'у фильма серий нет');
    eq((await c.details({ fid: '900', request: { id: 900 } })).episodes.map(e => e.title), ['Серия 1'], 'серии сериала');
    eq((await c.details(c.itemById('555'))).item.title, 'Интерстеллар', 'карточка открылась по одному номеру (избранное)');
}

(async () => {
    await testRegistry();
    await testAddonVod();
    await testTvLoader();
    await testDocExample();
    console.log(`OK — ${passed} проверок`);
})().catch(err => {
    console.error('УПАЛО:', err && err.message ? err.message : err);
    process.exit(1);
});
