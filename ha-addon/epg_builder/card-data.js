/**
 * Данные и файлы для карточки Home Assistant (custom:tizen-iptv-card).
 *
 * Карточка живёт на странице HA (часто по https через cloudflared), поэтому до порта 8765 аддона
 * ей не достучаться — всё нужное кладётся в /homeassistant/www/tizen-iptv/, это /local/tizen-iptv/
 * на том же адресе, что и сам HA:
 *   channels-<tv_id>.json  — плейлист телевизора (порядок, группы, логотипы) + передачи на ближайшие
 *                            часы + список плейлистов аддона
 *   tvs.json               — зарегистрированные телевизоры (выпадающий список в редакторе карточки)
 *   tizen-iptv-card.js     — сама карточка (js/channel-match.js + card/tizen-iptv-card.js)
 *
 * Порядок и логотипы берутся из топика iptv/<tv_id>/channels, который публикует телевизор (там
 * пользовательская сортировка и вручную заменённые логотипы). Пока его нет — порядок плейлиста
 * и логотипы из EPG.
 */
const fs = require('fs');
const path = require('path');

const WWW_DIR = process.env.WWW_DIR || '/homeassistant/www/tizen-iptv';
// Передачи в channels.json — только чтобы показать «что идёт сейчас» на плитках: файл пересобирается
// каждые 30 мин, карточка перечитывает его каждые 15, так что 4 часов вперёд хватает с запасом
// (при 9 часах файл был ~1 МБ — тяжело для телефона через интернет).
const PAST_SEC = 10 * 60;
const FUTURE_SEC = 4 * 3600;

/** http://epg.one/img/1.png отдаёт 302 на http — на https-странице HA картинка не покажется */
function httpsLogo(url) {
    if (!url) return '';
    return url.replace(/^https?:\/\/(cdn\.)?epg\.one\//, 'https://cdn.epg.one/');
}

/**
 * bundle — собранный M3U-плейлист (build.js: channels/match/channels_epg/programmes) или null,
 * tv — { updatedAt, channels: [[имя, группа, логотип]] } из iptv/<tv_id>/channels или null,
 * extra — что ещё положить в файл (список плейлистов, какой это телевизор).
 */
function buildCardData(bundle, tv, extra) {
    const now = Math.floor(Date.now() / 1000);
    const epg = bundle || { programmes: {} };
    const match = epg.match || {};
    const epgChannels = epg.channels_epg || {};
    const playlistOrder = bundle ? bundle.channels.map(c => [c.name, c.group || '']) : [];
    const source = tv && tv.channels && tv.channels.length ? tv.channels : playlistOrder;

    // дней архива по имени канала — для метки «А N» на плитках; только где архив подтверждён запросом (archive.js)
    const archive = {};
    if (bundle) bundle.channels.forEach(c => { if (c.catchup && c.catchup.days > 0 && c.catchup.available) archive[c.name] = c.catchup.days; });

    const programmes = {};
    const channels = source.map(([name, group, tvLogo]) => {
        const epgId = match[name] || '';
        const icon = epgId && epgChannels[epgId] ? epgChannels[epgId].icon : '';
        if (epgId && !programmes[epgId] && epg.programmes[epgId]) {
            programmes[epgId] = epg.programmes[epgId].filter(p => p[1] > now - PAST_SEC && p[0] < now + FUTURE_SEC);
        }
        return [name, group || '', httpsLogo(tvLogo || icon), epgId, archive[name] || 0];
    });

    return Object.assign({
        generatedAt: now,
        source: source === (tv && tv.channels) ? 'tv' : 'playlist',
        tvUpdatedAt: tv ? tv.updatedAt : null,
        channels,
        programmes
    }, extra || {});
}

function writeAtomic(file, content) {
    fs.writeFileSync(file + '.tmp', content);
    fs.renameSync(file + '.tmp', file);
}

/** fileName: channels-<tv_id>.json (у каждого телевизора своя карточка) или tvs.json. */
function writeCardData(data, fileName) {
    fs.mkdirSync(WWW_DIR, { recursive: true });
    const json = JSON.stringify(data);
    writeAtomic(path.join(WWW_DIR, fileName), json);
    return json.length;
}

/**
 * Карточка = общий модуль поиска каналов (тот же, что в плеере) + код карточки.
 *
 * HA отдаёт /local с Cache-Control на 31 день, а ресурс дашборда прописывается один раз. Поэтому
 * ресурс — неизменный loader.js, который узнаёт хеш текущей сборки из version.json (без кеша) и
 * импортирует tizen-iptv-card.js?v=<хеш>: новая версия карточки доходит до браузера и телефона сама.
 */
function installCard(log) {
    // общие файлы плеера: поиск каналов, переводы (i18n.js + словари) — из shared/ или, на компьютере, из исходников
    const sharedFile = name => {
        const local = path.join(__dirname, 'shared', name);
        return fs.existsSync(local) ? local : path.join(__dirname, '..', '..', name.startsWith('lang/') ? '' : 'js', name);
    };
    const parts = ['channel-match.js', 'i18n.js', 'lang/ru.js', 'lang/en.js', 'lang/uk.js', 'lang/de.js'].map(sharedFile)
        .concat(path.join(__dirname, 'card', 'tizen-iptv-card.js'));
    fs.mkdirSync(WWW_DIR, { recursive: true });
    const bundle = '// Собрано аддоном epg_builder — не править здесь, правки в ha-addon/epg_builder/card/\n' +
        parts.map(f => fs.readFileSync(f, 'utf8')).join('\n');
    const hash = require('crypto').createHash('sha1').update(bundle).digest('hex').slice(0, 10);
    writeAtomic(path.join(WWW_DIR, 'tizen-iptv-card.js'), bundle);
    writeAtomic(path.join(WWW_DIR, 'version.json'), JSON.stringify({ hash }));
    writeAtomic(path.join(WWW_DIR, 'loader.js'),
        '// Ресурс дашборда HA для custom:tizen-iptv-card (см. ha-addon/epg_builder/card-data.js)\n' +
        "fetch('/local/tizen-iptv/version.json?t=' + Date.now(), { cache: 'no-store' })\n" +
        "    .then(r => r.json()).catch(() => ({ hash: Date.now() }))\n" +
        "    .then(v => import('/local/tizen-iptv/tizen-iptv-card.js?v=' + v.hash));\n");
    log(`карточка HA: ${path.join(WWW_DIR, 'tizen-iptv-card.js')} (${bundle.length} байт, версия ${hash})`);
}

module.exports = { buildCardData, writeCardData, installCard, WWW_DIR };
