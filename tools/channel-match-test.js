/**
 * Регрессионный тест поиска канала по «голосовому» имени (js/channel-match.js).
 *   node tools/channel-match-test.js
 * channel-names.txt — имена каналов реального плейлиста в его порядке (порядок важен: из почти
 * равных кандидатов выбирается первый). Обновить: взять строки #EXTINF плейлиста после запятой.
 * Запускать после любой правки channel-match.js — все случаи должны быть OK.
 */
const fs = require('fs');
const path = require('path');
const M = require('../js/channel-match.js');
const channels = fs.readFileSync(path.join(__dirname, 'channel-names.txt'), 'utf8')
    .split('\n').map(s => s.trim()).filter(Boolean).map(name => ({ name }));

// [запрос, ожидаемый канал или null — не должен найти ничего]; '~a|b' — подходит любой из вариантов
const cases = [
    ['Первый канал HD', 'Первый канал HD'],
    ['первый канал', 'Первый канал'],
    ['перви канал', 'Первый канал'],
    ['перви канал hd', 'Первый канал HD'],
    ['первый канал эйч ди', 'Первый канал HD'],
    ['первый канал плюс четыре', 'Первый канал +4'],
    ['первого канала', 'Первый канал'],
    ['россия один', 'Россия 1'],
    ['росия 1', 'Россия 1'],
    ['россия двадцать четыре', 'Россия 24'],
    ['россия 24', 'Россия 24'],
    ['россия культура', 'Россия К'],
    ['дискавери', 'Discovery Channel'],
    ['дискавери ченел', 'Discovery Channel'],
    ['дискавери сайнс', 'Discovery Science PL'],
    ['вижу тв тысяча экшн', '~Viju TV1000 Action HD|Viju TV1000 Action'],
    ['виджу экшн', '~Viju TV1000 Action HD|Viju TV1000 Action'],
    ['нэшнл джиографик', '~National Geographic HD DE|National Geographic Wild'],
    ['энимал планет', '~Animal Planet|Animal Planet HD'],
    ['евроспорт', '~Eurosport 1|Eurosport 1 HD'],
    ['евроспорт два', '~Eurosport 2 HD UK|Eurosport 2 HD SE|Eurosport 2 HD orig'],
    ['тнт', 'ТНТ'],
    ['тнт четыре', 'ТНТ4'],
    ['тнт 4', 'ТНТ4'],
    ['нтв', 'НТВ'],
    ['россия один плюс четыре', 'Россия 1 +4'],
    ['первого канала плюс два', 'Первый канал +2'],
    ['матч футбол', 'Матч! Футбол 1'],
    ['viju tv1000', 'Viju TV1000'],
    ['вижу тв тысяча', '~Viju TV1000|Viju TV1000 HD'],
    ['включи пожалуйста первый канал', 'Первый канал'],
    ['спас', 'СПАС'],
    ['мульт', 'Мульт'],
    
    ['футбол', 'Футбол'],
    ['абракадабра', null],
    ['новости', null],
    ['стс', 'СТС'],
    ['рен тв', 'РЕН ТВ'],
    ['рен', 'РЕН ТВ'],
    ['пятница', 'Пятница!'],
    ['пятый канал', 'Пятый канал'],
    ['карусель', 'Карусель'],
    ['домашний', 'Домашний'],
    ['звезда', 'Звезда'],
    ['тв три', 'ТВ-3'],
    ['ю тв', 'Ю ТВ'],
    ['матч арена', 'Матч! Арена'],
    ['два на два', '2x2'],
    ['2x2', '2x2'],
    ['никелодеон', 'Nickelodeon'],
    ['картун нетворк', 'Cartoon Network HD'],
    ['мир двадцать четыре', 'Мир 24'],
    ['суббота', 'Суббота!'],
    ['дождь', 'Дождь'],
    ['хистори', '~History FHD|History HD|History 2 HD'],
    ['евроньюс', 'Euronews Россия'],
    ['перший', 'Перший UA'],
    ['один плюс один', '~1+1 Україна FHD UA|1+1 Марафон UA|1+1 International UA'],
    ['такого канала нет', null],
    ['погода', null],
    ['включи что-нибудь', null]
];

let fail = 0;
cases.forEach(([q, want]) => {
    const r = M.find(q, channels);
    const got = r.channel ? r.channel.name : null;
    const okSet = want && want[0] === '~' ? want.slice(1).split('|') : [want];
    const ok = okSet.includes(got);
    if (!ok) fail++;
    console.log((ok ? 'OK   ' : 'FAIL ') + q.padEnd(32) + ' → ' + String(got).padEnd(28) + ' ' + r.score +
        (ok ? '' : '   ждали: ' + want + '   варианты: ' + r.alternatives.join(' / ')));
});
console.log(`\n${cases.length - fail}/${cases.length}`);
process.exitCode = fail ? 1 : 0;
