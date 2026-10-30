#!/usr/bin/env node
/**
 * Проверка поиска по программе передач и напоминаний (ha-addon/epg_builder/guide.js) и таймера сна плеера
 * (js/sleep-timer.js) на заглушках: node tools/guide-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createGuide } = require('../ha-addon/epg_builder/guide');

let failed = 0;
let count = 0;
function check(name, cond, extra) {
    count++;
    if (!cond) { failed++; console.log('  ОШИБКА: ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

// ───────────── поиск и напоминания ─────────────
const T0 = 1800000000;            // «сейчас»
let clock = T0;
const H = 3600;
const epg = {
    epgProgrammes: {
        match: [[T0 - 2 * H, T0 - H, 'Новости спорта'], [T0 - H, T0 + H, 'Футбол. Лига чемпионов. Финал'], [T0 + H, T0 + 2 * H, 'Все на Матч!'],
            [T0 + 26 * H, T0 + 28 * H, 'Футбол. Чемпионат России']],
        one: [[T0 - H, T0 + 1800, 'Время покажет'], [T0 + 1800, T0 + 3 * H, 'Иван Васильевич меняет профессию'], [T0 + 3 * H, T0 + 4 * H, 'Новости']],
        oneHd: [[T0 - H, T0 + 1800, 'Время покажет'], [T0 + 1800, T0 + 3 * H, 'Иван Васильевич меняет профессию']],
        adult: [[T0, T0 + H, 'Футбол для взрослых']]
    }
};
const channels = [
    { name: 'Матч ТВ', group: 'спорт', epgId: 'match' },
    { name: 'Первый канал', group: 'общие', epgId: 'one' },
    { name: 'Первый канал HD', group: 'HD', epgId: 'oneHd' },
    { name: 'Первый канал orig', group: 'HD', epgId: 'one' },   // тот же канал EPG — дубль
    { name: 'Без программы', group: 'общие', epgId: null }
];
const file = path.join(os.tmpdir(), 'guide-test-' + process.pid + '.json');
const due = [];
const day = sec => (sec < T0 + 20 * H ? 'D1' : 'D2');
const make = () => createGuide({ file, getEpg: () => epg, getChannels: () => channels, dayOf: day, onDue: r => due.push(r), now: () => clock });
let guide = make();

let r = guide.search('футбол');
check('футбол: две передачи', r.total === 2, r);
check('футбол: сначала та, что идёт', r.items[0].live === true && r.items[0].title.indexOf('Лига') > 0, r.items[0]);
check('футбол: вторая — завтра, не идёт', r.items[1].live === false && r.items[1].start === T0 + 26 * H);
check('канала взрослой группы в поиске нет (его нет среди каналов)', !r.items.some(x => x.epgId === 'adult'));
check('окончание не мешает: «футбола»', guide.search('футбола').total === 2);
check('по дню: завтра одна', guide.search('футбол', { day: 'D2' }).total === 1);
check('по дню: то, что идёт, — сегодня', guide.search('футбол', { day: 'D1' }).items[0].live === true);
check('прошедшее не находится', guide.search('новости спорта').total === 0);
r = guide.search('иван васильевич');
check('дубли каналов: один результат', r.total === 1, r);
check('дубли: первый канал плейлиста и счётчик остальных', r.items[0].channel === 'Первый канал' && r.items[0].also === 1, r.items[0]);
check('все слова обязательны', guide.search('иван петрович').total === 0);
check('падеж не мешает: «новостей» находит «Новости», «новая» — нет', guide.search('новостей').total === 1 && guide.search('новая').total === 0);
check('только этот канал', guide.search('новости', { epgId: 'one' }).total === 1 && guide.search('новости', { epgId: 'match' }).total === 0);
check('граница по времени', guide.search('футбол', { toSec: T0 + 2 * H }).total === 1);
check('пустой запрос ничего не находит', guide.search('').total === 0);
check('предел списка, total — сколько всего', guide.search('футбол', { limit: 1 }).items.length === 1 && guide.search('футбол', { limit: 1 }).total === 2);

const film = guide.search('иван васильевич').items[0];
const ref = guide.refOf(film);
check('ссылка на передачу', ref === 'one@' + (T0 + 1800));
check('передача по ссылке', guide.byRef(ref).title === film.title && guide.byRef(ref).channel === 'Первый канал');
check('ссылка на то, чего нет', guide.byRef('one@123') === null && guide.byRef('чушь') === null);

check('идущую не напомнить', guide.add(guide.search('футбол').items[0]).error === 'already_started');
let a = guide.add(film);
check('напоминание поставлено', a.ok && !a.existed && guide.list().length === 1);
check('ссылка у напоминания та же, что у передачи', guide.refOf(guide.list()[0]) === ref && guide.list()[0].id === ref);
check('повторно — то же самое', guide.add(film).existed === true && guide.list().length === 1);
check('файл записан', JSON.parse(fs.readFileSync(file, 'utf8')).items.length === 1);

guide.tick();
check('рано: до начала 30 минут — молчит', due.length === 0);
clock = film.start - guide.LEAD_SEC - 1;
guide.tick();
check('за 5 мин 1 с — ещё молчит', due.length === 0);
clock = film.start - guide.LEAD_SEC + 1;
guide.tick();
check('за 5 минут — сработало', due.length === 1 && due[0].title === film.title, due);
guide.tick();
check('второй раз не срабатывает', due.length === 1);
check('в списке его больше нет', guide.list().length === 0);

// перезапуск аддона: напоминание в файле переживает, сработавшее не повторяется
clock = T0;
const later = guide.search('чемпионат россии').items[0];   // просто «чемпионат» найдёт и «Лигу чемпионов»
guide.add(later);
guide = make();
check('после перезапуска напоминание на месте', guide.list().length === 1 && guide.list()[0].title === later.title);
clock = later.start + 30 * 60;   // аддон был выключен, передача идёт уже полчаса
guide.tick();
check('опоздали на полчаса — не напоминаем', due.length === 1 && guide.list().length === 0);
clock = later.start + 2 * H;
guide.tick();
check('старые записи убираются из файла', JSON.parse(fs.readFileSync(file, 'utf8')).items.length === 0);

clock = T0;
guide.add(later);
guide.add(guide.search('все на матч').items[0]);
check('убрать по слову из названия', guide.remove('россии').length === 1 && guide.list().length === 1);
check('убрать то, чего нет', guide.remove('абракадабра').length === 0);
check('убрать всё', guide.remove('').length === 1 && guide.list().length === 0);
fs.rmSync(file, { force: true });

// ───────────── таймер сна ─────────────
let volume = 20;
let muted = false;
const volumes = [];
global.TvAudio = {
    getState: () => ({ volume, muted }),
    setVolume: v => { volume = v; volumes.push(v); }
};
const realNow = Date.now;
let fake = 1000000;
Date.now = () => fake;
const timers = [];
const realSetInterval = global.setInterval;
const realClearInterval = global.clearInterval;
global.setInterval = fn => { timers.push(fn); return fn; };
global.clearInterval = fn => { const i = timers.indexOf(fn); if (i >= 0) timers.splice(i, 1); };
const { SleepTimer } = require('../js/sleep-timer');
const events = { change: 0, countdown: [], finish: 0, volumeAtFinish: null };
SleepTimer.init({
    onChange: () => events.change++,
    onCountdown: s => events.countdown.push(s),
    onFinish: () => { events.finish++; events.volumeAtFinish = volume; }
});
const advance = sec => { for (let i = 0; i < sec; i++) { fake += 1000; timers.slice().forEach(fn => fn()); } };

check('сон: по кругу выкл → 15', SleepTimer.next() === 15 && SleepTimer.isActive());
check('сон: 15 → 30', SleepTimer.next() === 30);
advance(16 * 60);
check('сон: осталось 14 минут', SleepTimer.remainingMin() === 14, SleepTimer.remainingMin());
check('сон: с 14 минут следующая ступень — 15', SleepTimer.next() === 15);
check('сон: 120 → выкл', SleepTimer.set(120) === 120 && SleepTimer.next() === 0 && !SleepTimer.isActive());
check('сон: таймеров не осталось', timers.length === 0);

SleepTimer.set(2);
check('сон: когда выключится', SleepTimer.untilSec() === Math.round((fake + 120000) / 1000));
advance(59);
check('сон: до последней минуты громкость не трогается', volumes.length === 0 && !SleepTimer.isFading());
advance(31);
check('сон: идёт снижение', SleepTimer.isFading() && volume === 10, volume);
check('сон: отсчёт на экране', events.countdown[events.countdown.length - 1] === 30, events.countdown.slice(-1));
advance(30);
check('сон: время вышло — onFinish один раз', events.finish === 1);
check('сон: в момент остановки звук почти на нуле', events.volumeAtFinish <= 1, events.volumeAtFinish);
check('сон: громкость возвращена после остановки', volume === 20, volume);
check('сон: таймер снят', !SleepTimer.isActive() && !SleepTimer.isFading() && timers.length === 0);
check('сон: отсчёт убран', events.countdown[events.countdown.length - 1] === null);

volumes.length = 0;
SleepTimer.set(1);
advance(20);
check('сон: отмена во время снижения возвращает громкость', volume < 20);
SleepTimer.cancel();
check('сон: отменён, громкость прежняя', volume === 20 && !SleepTimer.isActive() && events.finish === 1);

muted = true;
volumes.length = 0;
SleepTimer.set(1);
advance(30);
check('сон: при выключенном звуке громкость не трогаем', volumes.length === 0);
advance(31);
check('сон: и после конца тоже', volumes.length === 0 && events.finish === 2);

Date.now = realNow;
global.setInterval = realSetInterval;
global.clearInterval = realClearInterval;

console.log(failed ? `\nПРОВАЛЕНО ${failed} из ${count}` : `OK: ${count} проверок`);
process.exit(failed ? 1 : 0);
