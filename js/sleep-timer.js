/**
 * Таймер сна: «выключить телевизор через N минут» — кнопка в панели плеера (▼) и команда sleep из
 * Home Assistant (голосом через аддон).
 *
 * Последнюю минуту на экране висит отсчёт, а громкость плавно уходит в ноль — чтобы звук не обрывался
 * на полуслове. Любая кнопка пульта в эту минуту отменяет выключение и возвращает громкость.
 * Сам телевизор приложение выключить не может: в конце оно останавливает воспроизведение, возвращает
 * громкость (при следующем включении она должна быть прежней) и зовёт handlers.onFinish — app.js просит
 * аддон выключить TV (MQTT iptv/<tv_id>/tv/power_off).
 *
 * handlers: onChange() — таймер поставили/сняли; onCountdown(seconds | null) — отсчёт последней минуты
 * (null — убрать); onFinish() — время вышло.
 */
const SleepTimer = (() => {
    const FADE_SEC = 60;
    const CHOICES = [0, 15, 30, 45, 60, 90, 120];   // по кругу кнопкой в панели плеера, минуты

    let until = 0;            // когда выключать (мс, по часам устройства), 0 — таймер не стоит
    let ticker = null;
    let baseVolume = null;    // громкость до начала снижения
    let lastVolume = null;
    let handlers = {};

    function init(h) { handlers = h || {}; }

    function isActive() { return until > 0; }
    function remainingSec() { return until ? Math.max(0, Math.ceil((until - Date.now()) / 1000)) : 0; }
    function remainingMin() { return Math.ceil(remainingSec() / 60); }
    /** Когда выключится (unix-сек) или null — для состояния в HA. */
    function untilSec() { return until ? Math.round(until / 1000) : null; }
    function isFading() { return baseVolume !== null; }

    function restoreVolume() {
        if (baseVolume === null) return;
        const v = baseVolume;
        const changed = lastVolume !== baseVolume;
        baseVolume = null;
        lastVolume = null;
        // −1 — громкость не трогали (звук был выключен или TV не даёт ей управлять)
        if (v >= 0 && changed) { try { TvAudio.setVolume(v); } catch (e) { /* не вышло — оставляем как есть */ } }
    }

    function stopTicker() {
        clearInterval(ticker);
        ticker = null;
        if (handlers.onCountdown) handlers.onCountdown(null);
    }

    /** minutes > 0 — поставить (заново, если уже стоял), 0 — снять. → сколько минут стоит */
    function set(minutes) {
        const m = Math.max(0, Math.round(Number(minutes) || 0));
        stopTicker();
        restoreVolume();
        until = m > 0 ? Date.now() + m * 60000 : 0;
        if (until) ticker = setInterval(tick, 1000);
        if (handlers.onChange) handlers.onChange();
        return m;
    }

    function cancel() { if (until) set(0); }

    /** Следующее значение по кругу: выкл → 15 → 30 → … → 120 → выкл. → минуты */
    function next() {
        const cur = remainingMin();
        const idx = CHOICES.findIndex(c => c > cur);
        return set(until && idx > 0 ? CHOICES[idx] : until ? 0 : CHOICES[1]);
    }

    function tick() {
        const left = remainingSec();
        if (left <= 0) {
            stopTicker();
            until = 0;
            // сначала тишина (onFinish останавливает поток), потом прежняя громкость — её не услышат
            try { if (handlers.onFinish) handlers.onFinish(); } finally { restoreVolume(); }
            if (handlers.onChange) handlers.onChange();
            return;
        }
        if (left > FADE_SEC) return;
        if (baseVolume === null) {
            const st = TvAudio.getState();
            // без звука или громкость недоступна — снижать нечего, остаётся только отсчёт
            baseVolume = st.volume !== null && !st.muted ? st.volume : -1;
            lastVolume = baseVolume;
        }
        if (baseVolume > 0) {
            const v = Math.round(baseVolume * left / FADE_SEC);
            if (v !== lastVolume) {
                lastVolume = v;
                try { TvAudio.setVolume(v); } catch (e) { baseVolume = -1; }
            }
        }
        if (handlers.onCountdown) handlers.onCountdown(left);
    }

    return { init, set, cancel, next, isActive, isFading, remainingSec, remainingMin, untilSec, FADE_SEC };
})();

if (typeof module !== 'undefined') module.exports = { SleepTimer };
