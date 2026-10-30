/**
 * Громкость и mute телевизора через tizen.tvaudiocontrol (привилегия
 * http://tizen.org/privilege/tv.audio в config.xml). Это системная громкость TV, а не плеера.
 * Каждый вызов обёрнут: на прошивке метод может отсутствовать или бросать — тогда возвращаем
 * ошибку текстом, её увидит отправитель команды в iptv/command/result.
 */
const TvAudio = (() => {
    const listeners = [];

    function api() {
        if (typeof tizen === 'undefined' || !tizen.tvaudiocontrol) throw new Error('tvaudiocontrol_unavailable');
        return tizen.tvaudiocontrol;
    }

    function getState() {
        try {
            const a = api();
            return { volume: a.getVolume(), muted: a.isMute() };
        } catch (e) {
            return { volume: null, muted: null };
        }
    }

    function notify() { const s = getState(); listeners.forEach(cb => cb(s)); }

    function setVolume(value) {
        const v = Math.max(0, Math.min(100, Math.round(value)));
        const a = api();
        if (a.isMute()) a.setMute(false);   // «сделай громкость 20» на выключенном звуке — звук должен появиться
        a.setVolume(v);
        notify();
    }

    /** delta: на сколько шагов (1 шаг = 1 деление громкости TV) изменить; отрицательная — тише. */
    function changeVolume(delta) {
        const a = api();
        setVolume(a.getVolume() + delta);
    }

    function setMute(muted) {
        api().setMute(!!muted);
        notify();
    }

    function toggleMute() { setMute(!api().isMute()); }

    function init() {
        // Громкость и mute меняют и пультом — тогда HA тоже должен узнать новое значение.
        // Слушатель громкости есть не на всех прошивках, а на mute его нет вовсе — поэтому ещё и опрос.
        try { api().setVolumeChangeListener(() => notify()); } catch (e) { /* нет API — не страшно */ }
        let last = JSON.stringify(getState());
        setInterval(() => {
            const now = JSON.stringify(getState());
            if (now !== last) { last = now; notify(); }
        }, 2000);
    }

    function onChange(cb) { listeners.push(cb); }

    return { init, getState, setVolume, changeVolume, setMute, toggleMute, onChange };
})();
