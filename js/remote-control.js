/**
 * Registers and handles Samsung remote keys via the Tizen TVInputDevice API.
 * Must register non-default keys before they'll fire keydown events.
 */
const RemoteControl = (() => {
    const KEYS = [
        'MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop',
        'MediaRewind', 'MediaFastForward',
        'ChannelUp', 'ChannelDown',
        'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue',
        '0','1','2','3','4','5','6','7','8','9'
    ];

    /**
     * Долгое нажатие OK. Включается, только когда handlers.wantsLongEnter() === true (сейчас —
     * боковой список каналов: долгое OK = перестановка), иначе OK срабатывает сразу, как раньше.
     *
     * Не все прошивки Samsung присылают keyup, поэтому решение принимается двумя путями:
     *   - пришёл keyup: короче LONG_MS — обычное OK, дольше — долгое;
     *   - keyup нет: удерживаемая кнопка шлёт автоповтор keydown — если повторы пошли и держат
     *     дольше LONG_MS, это долгое нажатие; если к LONG_MS повторов не было — обычное OK.
     * Если keyup на этом TV хоть раз приходил, по таймеру без повторов не решаем, а ждём keyup
     * (иначе медленное нажатие без автоповтора засчиталось бы коротким раньше времени).
     */
    const LONG_MS = 800;
    const enter = {
        pending: false,     // OK нажат, ждём решения короткое/долгое
        startTs: 0,
        repeats: 0,
        longFired: false,   // долгое уже сработало — остальные повторы этого удержания игнорируем
        lastTs: 0,
        timer: null,
        keyupSeen: false
    };

    function init(handlers) {
        KEYS.forEach(key => {
            try { tizen.tvinputdevice.registerKey(key); } catch (e) { /* not all keys exist on all models */ }
        });

        function fireShort() {
            clearTimeout(enter.timer);
            enter.pending = false;
            handlers.onEnter?.();
        }
        function fireLong() {
            clearTimeout(enter.timer);
            enter.pending = false;
            enter.longFired = true;
            handlers.onEnterLong?.();
        }

        function onEnterDown() {
            const now = Date.now();
            if (enter.longFired) {
                // хвост автоповтора после долгого нажатия; пауза в повторах = новое нажатие
                if (now - enter.lastTs < 400) { enter.lastTs = now; return; }
                enter.longFired = false;
            }
            enter.lastTs = now;

            if (enter.pending) {
                enter.repeats++;
                if (now - enter.startTs >= LONG_MS) fireLong();
                return;
            }
            if (!(handlers.wantsLongEnter && handlers.wantsLongEnter())) {
                handlers.onEnter?.();
                return;
            }
            enter.pending = true;
            enter.startTs = now;
            enter.repeats = 0;
            clearTimeout(enter.timer);
            enter.timer = setTimeout(() => {
                if (!enter.pending) return;
                if (enter.repeats > 0) fireLong();        // держат — повторы идут
                else if (!enter.keyupSeen) fireShort();   // keyup на этом TV не приходит — решаем сами
                // иначе ждём keyup
            }, LONG_MS);
        }

        document.addEventListener('keyup', (e) => {
            if (e.keyCode !== 13) return;
            enter.keyupSeen = true;
            if (enter.longFired) { enter.longFired = false; return; }
            if (!enter.pending) return;
            if (Date.now() - enter.startTs >= LONG_MS) fireLong(); else fireShort();
            enter.longFired = false;
        });

        document.addEventListener('keydown', (e) => {
            switch (e.keyCode) {
                // На пультах Samsung Play/Pause — ОДНА кнопка с кодом 10252; раздельные 415/19 бывают
                // только на старых/универсальных пультах. Без этого case кнопка молча не работала.
                case 10252: handlers.onPlayPause?.(); break;    // MediaPlayPause
                case 415: handlers.onPlay?.(); break;          // MediaPlay
                case 19:  handlers.onPause?.(); break;          // MediaPause
                case 413: handlers.onStop?.(); break;           // MediaStop
                case 417: handlers.onFastForward?.(); break;
                case 412: handlers.onRewind?.(); break;
                case 427: handlers.onChannelUp?.(); break;
                case 428: handlers.onChannelDown?.(); break;
                case 10009: handlers.onBack?.(); break;         // RETURN
                case 37: handlers.onLeft?.(); break;
                case 39: handlers.onRight?.(); break;
                case 38: handlers.onUp?.(); break;
                case 40: handlers.onDown?.(); break;
                case 13: onEnterDown(); break;
                // Standard HbbTV-style colour key codes (403-406). Only shortcuts now: newer Samsung
                // remotes have no colour keys at all, so everything is reachable from the D-pad
                // (► in the channel list — programme guide, ◄ — menu; see app.js).
                case 403: handlers.onRed?.(); break;
                case 404: handlers.onGreen?.(); break;
                case 405: handlers.onYellow?.(); break;
                case 406: handlers.onBlue?.(); break;
                // Экранная клавиатура Samsung: «Готово» и «Отмена» — закрыть ввод в поле
                case 65376: handlers.onImeDone?.(); break;
                case 65385: handlers.onImeCancel?.(); break;
                default:
                    if (e.keyCode >= 48 && e.keyCode <= 57) {
                        handlers.onNumber?.(e.keyCode - 48); // direct channel-number entry
                    } else {
                        // Helps calibrate real, unconfirmed remote keys (e.g. a hardware GUIDE
                        // button) without guessing a keyCode ahead of time — check this log on
                        // the TV (or over a debug console) when a button seems to do nothing.
                        console.log('[RemoteControl] unmapped key code:', e.keyCode);
                    }
            }
        });
    }

    return { init };
})();
