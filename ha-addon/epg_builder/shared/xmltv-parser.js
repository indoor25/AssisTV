/**
 * XMLTV parser — ПОТОКОВЫЙ, разбирает документ по кускам.
 *
 * Почему не DOMParser по всему файлу, как было раньше: реальный источник
 * (epg.it999.ru/epg.xml.gz) в распакованном виде не помещается в одну JS-строку на TV —
 * `pako.inflate(..., {to:'string'})` падал с `RangeError: Invalid string length` на склейке
 * чанков, из-за чего весь старт приложения валился в чёрный экран. Поэтому текст сюда
 * приходит кусками, элементы <channel>/<programme> вырезаются из буфера по мере поступления
 * и разбираются регулярками (DOMParser на 90k+ элементов на телевизоре ещё и слишком медленный).
 *
 * Передачи вне временного окна отбрасываются сразу: даже разобранный EPG целиком не влезает
 * в память TV. Окно задаётся опциями from/to (по умолчанию -2ч..+24ч от текущего момента).
 *
 * opts.keepChannel(displayNames, id) — необязательный фильтр: в источнике каналов заметно
 * больше, чем в плейлисте (3247 против 1977 у нас), и передачи для чужих каналов всё равно
 * не к чему привязать. Отсев по нему убирает ~62% передач ещё до попадания в память.
 *
 * Returns: {
 *   channels: { [tvgId]: { displayName, icon } },
 *   programmes: { [tvgId]: [{ start, stop, title }] },   // с opts.compact — [[startSec, stopSec, title, info?]]
 *   lastStop: { [tvgId]: ms }   // только с opts.trackLastStop
 * }
 */
function createXmltvParser(opts) {
    opts = opts || {};
    const from = (opts.from || new Date(Date.now() - 2 * 3600 * 1000)).getTime();
    const to = (opts.to || new Date(Date.now() + 24 * 3600 * 1000)).getTime();

    const keepChannel = opts.keepChannel || null;
    // opts.mapTitle(title) → строка, которую хранить. Название — срез буфера, и V8 держит ради него в памяти
    // весь кусок XML: с передачами за неделю (аддон, архив) это почти весь распакованный файл и падение по
    // памяти. Аддон передаёт сюда копирование с дедупликацией (build.js loadEpg).
    const mapTitle = opts.mapTitle || null;
    // opts.mapInfo({desc, category, rating}) → что положить в передачу полем info (описание, жанр, возраст).
    // Без опции не разбираются вовсе: на TV описания не нужны, а в аддоне их ~100 тыс. — он пишет их в файл.
    const mapInfo = opts.mapInfo || null;
    // opts.compact — передача сразу как [startSec, stopSec, title] (+ info, если есть), без объекта и двух Date.
    // Так хранит аддон: на объекты большого источника (1,2 млн передач за две недели) уходило ~450 МБ — и падение.
    const compact = !!opts.compact;
    const keptIds = keepChannel ? Object.create(null) : null;

    const result = { channels: {}, programmes: {} };
    if (opts.trackLastStop) result.lastStop = {};   // { [tvgId]: ms }
    let buffer = '';

    function handleChannel(el) {
        const id = matchAttr(el, 'id');
        if (!id) return;

        // Имён у канала обычно НЕСКОЛЬКО ("4Ever Cinema HD", "4ever Cinema HD UA", ...), и
        // плейлист может совпадать с любым из них — по одному первому терялось ~30% совпадений
        // (1346 против 1920 из 1977 каналов), а вместе с ними и логотипы.
        const names = [];
        const nameRe = /<display-name[^>]*>([\s\S]*?)<\/display-name>/g;
        let m;
        while ((m = nameRe.exec(el)) !== null) names.push(decodeXml(m[1].trim()));
        if (!names.length) names.push(id);

        if (keepChannel && !keepChannel(names, id)) return;
        if (keptIds) keptIds[id] = true;

        const iconMatch = el.match(/<icon[^>]*\ssrc="([^"]*)"/);
        result.channels[id] = {
            displayName: names[0],
            displayNames: names,
            icon: iconMatch ? iconMatch[1] : null
        };
    }

    function handleProgramme(el) {
        const channelId = matchAttr(el, 'channel');
        if (!channelId) return;
        if (keptIds && !keptIds[channelId]) return;

        const start = parseXmltvTime(matchAttr(el, 'start'));
        const stop = parseXmltvTime(matchAttr(el, 'stop'));
        if (!start || !stop) return;
        // конец последней передачи канала за весь файл, а не только в окне: по нему видно, что
        // источник перестал обновлять канал (страница сопоставления в аддоне)
        if (result.lastStop && !(result.lastStop[channelId] >= stop.getTime())) result.lastStop[channelId] = stop.getTime();
        if (stop.getTime() < from || start.getTime() > to) return;

        const titleMatch = el.match(/<title[^>]*>([\s\S]*?)<\/title>/);
        const title = titleMatch ? decodeXml(titleMatch[1].trim()) : '';
        if (!result.programmes[channelId]) result.programmes[channelId] = [];
        let info;
        if (mapInfo) {
            const desc = el.match(/<desc[^>]*>([\s\S]*?)<\/desc>/);
            const category = el.match(/<category[^>]*>([\s\S]*?)<\/category>/);
            const rating = el.match(/<rating[^>]*>\s*<value>([\s\S]*?)<\/value>/);
            info = mapInfo({
                desc: desc ? decodeXml(desc[1].trim()) : '',
                category: category ? decodeXml(category[1].trim()) : '',
                rating: rating ? decodeXml(rating[1].trim()) : ''
            });
        }
        const t = mapTitle ? mapTitle(title) : title;
        let p;
        if (compact) {
            // массив создаётся сразу нужной длины: дописанный позже элемент раздувает его запас в разы
            const s = Math.floor(start.getTime() / 1000), e = Math.floor(stop.getTime() / 1000);
            p = info ? [s, e, t, info] : [s, e, t];
        } else {
            p = { start, stop, title: t };
            if (mapInfo) p.info = info;
        }
        result.programmes[channelId].push(p);
    }

    /**
     * Вырезает из буфера все полные элементы <channel>/<programme>; неполный хвост оставляет.
     *
     * Идём КУРСОРОМ (pos) и режем буфер ровно один раз в конце, а не на каждом элементе:
     * буфер тут — это кусок распакованного XML под мегабайт, и `buffer = buffer.slice(...)`
     * на каждый из тысяч элементов давало квадратичную сложность (разбор 386 МБ уходил
     * с десятка секунд в минуты и вешал загрузку EPG).
     */
    function drain() {
        let pos = 0;
        // Позиции тегов кешируются и обновляются только для того тега, который только что разобран.
        // Искать оба на каждой итерации нельзя: <channel> лежат в начале файла, и дальше каждый
        // из тысяч <programme> заново прочёсывал весь мегабайтный буфер в поисках отсутствующего
        // <channel — из-за этого разбор занимал ~2 минуты вместо нескольких секунд.
        let ci = buffer.indexOf('<channel ', pos);
        let pi = buffer.indexOf('<programme ', pos);

        for (;;) {
            if (ci < 0 && pi < 0) {
                // ничего интересного: держим короткий хвост на случай разрезанного тега
                buffer = buffer.length - pos > 4096 ? buffer.slice(-32) : buffer.slice(pos);
                return;
            }

            const isChannel = ci >= 0 && (pi < 0 || ci < pi);
            const start = isChannel ? ci : pi;
            const closeTag = isChannel ? '</channel>' : '</programme>';

            const gt = buffer.indexOf('>', start);
            if (gt < 0) { buffer = buffer.slice(start); return; } // тег ещё не дочитан

            let el;
            if (buffer.charCodeAt(gt - 1) === 47 /* '/' */) { // самозакрывающийся <channel .../>
                el = buffer.slice(start, gt + 1);
                pos = gt + 1;
            } else {
                const end = buffer.indexOf(closeTag, gt);
                if (end < 0) { buffer = buffer.slice(start); return; } // элемент ещё не дочитан
                el = buffer.slice(start, end + closeTag.length);
                pos = end + closeTag.length;
            }

            if (isChannel) {
                handleChannel(el);
                ci = buffer.indexOf('<channel ', pos);
                if (pi >= 0 && pi < pos) pi = buffer.indexOf('<programme ', pos);
            } else {
                handleProgramme(el);
                pi = buffer.indexOf('<programme ', pos);
                if (ci >= 0 && ci < pos) ci = buffer.indexOf('<channel ', pos);
            }
        }
    }

    return {
        push(chunk) { buffer += chunk; drain(); },
        end() { drain(); buffer = ''; return result; }
    };
}

// Регулярки нужных атрибутов компилируются один раз: элементов десятки тысяч, и
// `new RegExp(...)` на каждый разбор заметно дороже самого поиска.
const ATTR_RE = {
    id: /\sid="([^"]*)"/,
    channel: /\schannel="([^"]*)"/,
    start: /\sstart="([^"]*)"/,
    stop: /\sstop="([^"]*)"/
};

function matchAttr(el, name) {
    const m = el.match(ATTR_RE[name]);
    return m ? m[1] : null;
}

function decodeXml(s) {
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
        .replace(/&amp;/g, '&');
}

/** Разбор целиком — для небольших источников и тестов; внутри тот же потоковый парсер. */
function parseXMLTV(xmlText, opts) {
    const parser = createXmltvParser(opts);
    parser.push(xmlText);
    return parser.end();
}

// XMLTV time format: 20260913193000 +0300
function parseXmltvTime(str) {
    if (!str) return null;
    const m = str.match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?/);
    if (!m) return null;
    const [, y, mo, d, h, mi, s, tz] = m;
    let iso = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
    iso += tz ? `${tz.slice(0,3)}:${tz.slice(3)}` : 'Z';
    return new Date(iso);
}

/** Find the "now playing" programme for a channel at a given time */
function getCurrentProgramme(programmes, channelId, at = new Date()) {
    const list = programmes[channelId] || [];
    return list.find(p => p.start <= at && at < p.stop) || null;
}

if (typeof module !== 'undefined') {
    module.exports = { createXmltvParser, parseXMLTV, getCurrentProgramme };
}
