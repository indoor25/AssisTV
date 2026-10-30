/**
 * Поиск канала по имени «как сказали голосом» — для iptv/set_channel.
 *
 * Голосовой ассистент ошибается не так, как человек за клавиатурой: пишет латинские названия
 * кириллицей («дискавери», «вижу тв»), числа словами («россия один», «плюс четыре»), теряет или
 * путает окончания («перви канал»), не произносит HD/orig/код страны. Поэтому сравнение идёт не по
 * исходным строкам, а по «звучанию»:
 *   1. обе строки приводятся к одному фонетическому латинскому виду (транслит + упрощения:
 *      o→a, c→k/s, j→zh, y→i, двойные буквы — одна), числа словами → цифры, «ти ви» → tv;
 *   2. маркеры качества/региона (HD, FHD, orig, UA, DE, «(Томск)»…) — необязательные слова: их
 *      отсутствие в запросе не штрафуется, а вот лишнее «+4» у канала — штрафуется, поэтому
 *      «первый канал» выберет «Первый канал», а не «Первый канал +4»;
 *   3. балл = лучшее из сходства «слитно» (Левенштейн по строке без пробелов) и пословного
 *      сходства в обе стороны (все ли слова запроса есть у канала и все ли значимые слова канала
 *      есть в запросе); числа весят больше букв — «матч футбол 2» не должен включить «футбол 3».
 * Из почти равных по баллу кандидатов выбирается первый в пользовательской сортировке — так
 * пользователь сам решает, какой из дублей («Первый канал HD» / «… orig») главный.
 *
 * Один и тот же файл работает в плеере (глобальная ChannelMatch) и в Node (тесты).
 */
const ChannelMatch = (() => {
    const MIN_SCORE = 0.7;       // ниже — считаем, что канала нет (лучше «не нашёл», чем случайный)
    const TIE_EPS = 0.02;        // кандидаты ближе этого к лучшему — «равные», решает сортировка

    const CYR = {
        а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i',
        к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
        // э → a: кириллицей так записывают английское «a» («экшн», «энимал»)
        х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'i', ь: '', э: 'a', ю: 'yu', я: 'ya',
        і: 'i', ї: 'i', є: 'e', ґ: 'g', ў: 'u',
        // латиница с диакритикой (немецкий, французский…) — иначе буква просто выпадала бы
        ä: 'a', ö: 'o', ü: 'u', ß: 'ss', à: 'a', á: 'a', â: 'a', å: 'a', é: 'e', è: 'e', ê: 'e', ë: 'e',
        í: 'i', ì: 'i', î: 'i', ï: 'i', ó: 'o', ò: 'o', ô: 'o', ø: 'o', ú: 'u', ù: 'u', û: 'u', ç: 's', ñ: 'n'
    };

    const NUMBERS = {
        ноль: 0, нуль: 0, один: 1, одна: 1, одно: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5,
        шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10, одиннадцать: 11, двенадцать: 12,
        тринадцать: 13, четырнадцать: 14, пятнадцать: 15, шестнадцать: 16, семнадцать: 17,
        восемнадцать: 18, девятнадцать: 19, двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50,
        шестьдесят: 60, семьдесят: 70, восемьдесят: 80, девяносто: 90, сто: 100,
        // українська
        тысяча: 1000,
        дві: 2, чотири: 4, "п'ять": 5, шість: 6, сім: 7, вісім: 8, "дев'ять": 9
    };

    // Слова, которые ничего не различают: их нет смысла требовать ни в запросе, ни в названии
    // (сравниваются ДО фонетики и после отрезания окончаний: «канала» → «канал»)
    const STOP = new Set(['канал', 'телеканал', 'channel', 'ченел', 'ченнел', 'чэнел', 'tv', 'тв', 'the',
        // слова-обёртки из голосовой фразы, если автоматизация их не отрезала
        'включи', 'включить', 'поставь', 'переключи', 'переключить', 'покажи', 'давай', 'пожалуйста', 'мне']);
    // Маркеры качества/версии — необязательны (сравниваются с исходным словом, до фонетики)
    const MARKERS = new Set(['hd', 'fhd', 'uhd', 'sd', '4k', '8k', 'hdr', 'orig', 'original', 'hevc', 'fps', 'hq', 'int', 'international']);

    function levenshtein(a, b) {
        const m = a.length, n = b.length;
        if (m === 0) return n;
        if (n === 0) return m;
        const dp = new Array(n + 1);
        for (let j = 0; j <= n; j++) dp[j] = j;
        for (let i = 1; i <= m; i++) {
            let prev = dp[0];
            dp[0] = i;
            for (let j = 1; j <= n; j++) {
                const tmp = dp[j];
                dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
                prev = tmp;
            }
        }
        return dp[n];
    }

    function similarity(a, b) {
        const maxLen = Math.max(a.length, b.length);
        return maxLen === 0 ? 1 : 1 - levenshtein(a, b) / maxLen;
    }

    /**
     * Грубое отрезание русских окончаний — чтобы «первого канала» совпало с «Первый канал».
     * Применяется одинаково к запросу и к названию, поэтому точность стемминга не важна,
     * важно только, чтобы разные формы одного слова сводились к одной основе.
     */
    function stem(w) {
        if (!/^[а-яёіїєґ]+$/.test(w)) return w;
        const adj = w.match(/^(.{3,}?)(ого|его|ому|ему|ыми|ими|ый|ий|ой|ая|яя|ое|ее|ые|ие|ую|юю)$/);
        if (adj) return adj[1];
        const noun = w.match(/^(.{4,}?)(ом|ем|ам|ах|а|я|у|ю|е|ы|и)$/);
        return noun ? noun[1] : w;
    }

    /** Одно слово → фонетическая латиница. */
    function phoneticWord(w) {
        if (/^\d+$/.test(w) || /^\+\d+$/.test(w)) return w;
        let s = '';
        for (const ch of w) s += CYR[ch] !== undefined ? CYR[ch] : ch;
        return s
            .replace(/[^a-z0-9+]/g, '')
            .replace(/^eu/, 'ev')                 // euro → евро
            .replace(/ew/g, 'u')                  // news → ньюс
            .replace(/tion/g, 'shn')              // action → экшн, national → нэшнл
            .replace(/g(?=[eiy])/g, 'zh')         // geographic → джиографик
            .replace(/dzh|dj/g, 'zh')
            .replace(/j/g, 'zh')
            .replace(/ph/g, 'f')
            .replace(/th/g, 't')
            .replace(/ck/g, 'k')
            .replace(/c(?=[eiy])/g, 's')
            .replace(/c/g, 'k')
            .replace(/q/g, 'k')
            .replace(/x/g, 'ks')
            .replace(/w/g, 'v')
            .replace(/kh/g, 'h')
            .replace(/yu/g, 'u')
            .replace(/ya/g, 'a')
            .replace(/y/g, 'i')
            .replace(/o/g, 'a')
            .replace(/([a-z])\1+/g, '$1');
    }

    /**
     * Строка → { tokens: [{t, optional}], compact }.
     * isChannel: у названия канала коды стран в конце («HD DE») и регион в скобках — необязательны.
     */
    function analyze(raw, isChannel) {
        let s = String(raw || '').toLowerCase().replace(/ё/g, 'е');
        const optional = new Set();
        if (isChannel) {
            // регион в скобках «(Томск)» и код страны последним словом («… HD PL») — необязательны
            const paren = s.match(/\(([^)]*)\)/g) || [];
            paren.forEach(p => p.replace(/[()]/g, '').split(/\s+/).forEach(x => x && optional.add(phoneticWord(x))));
            const m = String(raw).match(/\s([A-Z]{2})\s*$/);
            if (m) optional.add(m[1].toLowerCase());
        }
        // \b в JS не видит границ кириллических слов — поэтому (^|\s)…(?=\s|$)
        s = s
            .replace(/(^|\s)(ти\s*ви|тиви|тэ\s*вэ|тэвэ)(?=\s|$)/g, '$1тв')
            .replace(/(^|\s)(эйч|аш|эч)\s*ди(?=\s|$)/g, '$1hd')
            .replace(/(^|\s)плюс\s*/g, '$1+')
            .replace(/[!?.,:;«»"()/\\|_–—-]/g, ' ')
            .replace(/&/g, ' ');

        // числа словами → цифры, «двадцать четыре» → 24; «+ четыре» → «+4»
        const words = s.split(/\s+/).filter(Boolean);
        const out = [];
        for (let i = 0; i < words.length; i++) {
            let w = words[i];
            let plus = '';
            if (w.charAt(0) === '+' && w.length > 1) { plus = '+'; w = w.slice(1); }
            else if (w === '+' && i + 1 < words.length) { plus = '+'; w = words[++i]; }
            if (NUMBERS[w] !== undefined) {
                let n = NUMBERS[w];
                if (n >= 20 && n % 10 === 0 && n < 100 && NUMBERS[words[i + 1]] !== undefined && NUMBERS[words[i + 1]] < 10) {
                    n += NUMBERS[words[++i]];
                }
                w = String(n);
            }
            // «2x2» оставляем как есть; «тнт4» → «тнт 4», «tv1000» → «tv 1000»
            const split = w.match(/^([^\d+]+)(\d+)$/);
            if (split && !plus) { out.push(split[1], split[2]); continue; }
            // «1+1» в названии → «1» «+1» — так же, как разберётся сказанное «один плюс один»
            const sum = w.match(/^(\d+)\+(\d+)$/);
            if (sum && !plus) { out.push(sum[1], '+' + sum[2]); continue; }
            out.push(plus + w);
        }
        // «два на два», «2 икс 2» → «2x2»
        for (let i = 0; i + 2 < out.length; i++) {
            if (/^\d+$/.test(out[i]) && /^(на|икс|x|х)$/.test(out[i + 1]) && /^\d+$/.test(out[i + 2])) {
                out.splice(i, 3, out[i] + 'x' + out[i + 2]);
            }
        }

        const tokens = [];
        out.forEach(w => {
            const st = stem(w);
            if (STOP.has(st) || STOP.has(w)) return;
            const t = phoneticWord(st);
            if (!t) return;
            tokens.push({ t, optional: MARKERS.has(w) || optional.has(t) || optional.has(phoneticWord(w)) });
        });
        return {
            tokens,
            compact: tokens.filter(x => !x.optional).map(x => x.t).join('')
        };
    }

    const isNum = t => /\d/.test(t);
    const weight = t => (isNum(t) ? 4 : t.length);

    /** abbr — разрешить однобуквенное сокращение (только внутри названия из нескольких слов). */
    function tokenSim(a, b, abbr) {
        if (a === b) return 1;
        if (isNum(a) || isNum(b)) return 0;     // числа — только точное совпадение
        // однобуквенное сокращение в названии: «Россия К» ← «россия культура»
        if (abbr && ((b.length === 1 && a.length > 2 && a.charAt(0) === b) ||
                     (a.length === 1 && b.length > 2 && b.charAt(0) === a))) return 0.7;
        let s = similarity(a, b);
        // одно слово — заметное начало другого («хистори» / «history»): не ниже 0.85
        const short = a.length < b.length ? a : b, long = a.length < b.length ? b : a;
        if (short.length >= 4 && short.length / long.length >= 0.7 && long.startsWith(short)) s = Math.max(s, 0.85);
        return s;
    }

    /** Насколько слова `from` покрыты словами `to` (0..1), с весами. firstBoost — первое слово
     *  весит вдвое: у названия оно главное («Россия 1 +1» — это прежде всего «Россия»). */
    function coverage(from, to, firstBoost, abbr) {
        let sum = 0, total = 0;
        from.forEach((f, i) => {
            const w = weight(f) * (firstBoost && i === 0 ? 2 : 1);
            let best = 0;
            to.forEach(x => { best = Math.max(best, tokenSim(f, x, abbr)); });
            sum += w * best;
            total += w;
        });
        return total ? sum / total : 1;
    }

    function score(q, c) {
        if (!q.tokens.length || !c.tokens.length) return 0;
        const qAll = q.tokens.map(x => x.t);
        const cAll = c.tokens.map(x => x.t);
        const cCore = c.tokens.filter(x => !x.optional).map(x => x.t);
        const qCore = q.tokens.filter(x => !x.optional).map(x => x.t);

        // все слова запроса должны найтись у канала (маркеры в запросе — тоже, «hd» сказали — ищем hd)
        const abbr = cCore.length >= 2;
        const qInC = coverage(qAll, cAll, false, abbr);
        // значимые слова канала — в запросе (лишнее «+4» или «футбол» у канала снижает балл)
        const cInQ = cCore.length ? coverage(cCore, qAll, true, abbr) : 1;
        const byWords = 0.55 * qInC + 0.45 * cInQ;

        const qCompact = qCore.join('');
        const byString = qCompact && c.compact ? similarity(qCompact, c.compact) : 0;
        // Слитное сравнение не видит разницы в числах — не даём ему перебить пословное, если числа разные
        const numsQ = qAll.filter(isNum).join(','), numsC = cCore.filter(isNum).join(',');
        let penalty = 0;
        q.tokens.forEach(x => {
            // сказали «HD» — у канала без HD чуть ниже балл, чтобы из дублей выбрался HD
            if (x.optional) { if (!cAll.includes(x.t)) penalty += 0.03; return; }
            // слово запроса, которого у канала нет совсем («такого канала НЕТ» → «Тооку») — сильный штраф.
            // На слитное сравнение не действует: «москвадоверие» — одно «лишнее» слово, но строка та же
            if (cAll.every(t => tokenSim(x.t, t) < 0.5)) penalty += 0.15;
        });
        const optPenalty = q.tokens.filter(x => x.optional && !cAll.includes(x.t)).length * 0.03;
        let s = byWords - penalty;
        if (numsQ === numsC) s = Math.max(s, byString - optPenalty);
        return Math.max(0, Math.min(1, s));
    }

    const cache = new WeakMap();
    function analyzed(channel) {
        let a = cache.get(channel);
        if (!a || a.name !== channel.name) {
            a = { name: channel.name, info: analyze(channel.name, true) };
            cache.set(channel, a);
        }
        return a.info;
    }

    /**
     * channels — в пользовательском порядке (ChannelStore.getAll()).
     * → { channel, score, exact, alternatives: [имена близких кандидатов] } или { channel: null, … }
     */
    function find(query, channels) {
        const text = String(query || '').trim();
        if (!text) return { channel: null, score: 0, alternatives: [] };
        const lower = text.toLowerCase();
        const exact = channels.find(c => c.name.toLowerCase().trim() === lower);
        if (exact) return { channel: exact, score: 1, exact: true, alternatives: [] };

        const q = analyze(text, false);
        const scored = [];
        channels.forEach((c, idx) => {
            const s = score(q, analyzed(c));
            if (s >= MIN_SCORE - 0.15) scored.push({ c, s, idx });
        });
        if (!scored.length) return { channel: null, score: 0, alternatives: [] };

        const best = scored.reduce((m, x) => (x.s > m ? x.s : m), 0);
        // из почти равных — первый в сортировке пользователя
        const top = scored.filter(x => x.s >= best - TIE_EPS).sort((a, b) => a.idx - b.idx)[0];
        const alternatives = scored
            .filter(x => x !== top)
            .sort((a, b) => b.s - a.s || a.idx - b.idx)
            .slice(0, 3)
            .map(x => x.c.name);
        const ok = top.s >= MIN_SCORE;
        return {
            channel: ok ? top.c : null,
            score: Math.round(top.s * 100) / 100,
            exact: false,
            alternatives: ok ? alternatives : [top.c.name].concat(alternatives).slice(0, 3)
        };
    }

    return { find, analyze, score, MIN_SCORE };
})();

if (typeof module !== 'undefined') module.exports = ChannelMatch;
