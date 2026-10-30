/**
 * Thin wrapper around Tizen's native `webapis.avplay`.
 * Docs: https://developer.samsung.com/smarttv/develop/api-references/tizen-web-device-api-references/avplay-api.html
 */
const Player = (() => {
    let currentChannel = null;   // последний включённый канал (live) — его видят MQTT, списки, CH+/CH−
    let current = null;          // что открыто в AVPlay сейчас: канал или фильм ({vod: true, …}, см. playVod)
    let listeners = { channelChanged: [], buffering: [], videoInfo: [], state: [], completed: [] };

    // Масштаб: 'off' — как отдаёт поток; 'auto' — если кадр заметно уже 16:9 (типично SD 720×576,
    // которое без растяжения показывается «на пол-экрана» с полосами по бокам), растягиваем на
    // весь экран. Нормальные 16:9 не трогаются. Порог 1.6 — между 4:3/5:4 (1.33/1.25) и 16:9 (1.78).
    const NARROW_ASPECT = 1.6;
    let scaleMode = 'off';
    let videoInfo = null;      // { width, height, scaled } текущего потока, если AVPlay его сообщил
    let openToken = 0;         // защита от ответа prepareAsync уже переключённого канала
    let suspended = false;     // поток закрыт на время сна TV / ухода приложения в фон (см. suspend)

    /*
     * Ожидание картинки (индикатор #buffering в app.js). Показывается, пока:
     *   - канал открывается и время воспроизведения ещё ни разу не сдвинулось (reason 'open');
     *   - AVPlay сообщил о пустом буфере (onbufferingstart/progress) (reason 'buffering');
     *   - поток ЗАВИС молча: состояние PLAYING, а время не двигается дольше STALL_MS. На обрыве
     *     связи прошивка часто вообще не присылает onbufferingstart — кадр просто застывает, и без
     *     этой проверки было непонятно, что происходит (reason 'buffering').
     * Снимается ТОЛЬКО когда время воспроизведения реально пошло — это единственный достоверный
     * признак картинки: prepareAsync/onbufferingcomplete означают лишь «данные есть», а
     * oncurrentplaytime приходит и при застывшем кадре с тем же самым временем (из-за этого
     * индикатор раньше пропадал сразу после появления).
     */
    const STALL_MS = 1500;
    const WATCH_MS = 500;
    const wait = {
        active: false,
        reason: 'open',
        percent: 0,        // заполнение буфера по AVPlay; без событий AVPlay остаётся 0
        since: 0,          // когда началось ожидание — для счётчика секунд
        avBuffering: false,
        avStartTime: 0     // время воспроизведения на момент onbufferingstart
    };
    let started = false;       // время воспроизведения текущего потока хоть раз сдвинулось
    let lastTime = -1;
    let lastAdvanceTs = 0;

    function emitBuffering() {
        const info = {
            reason: wait.reason,
            percent: wait.percent,
            seconds: wait.active ? Math.floor((Date.now() - wait.since) / 1000) : 0
        };
        listeners.buffering.forEach(cb => cb(wait.active, info));
    }

    function startWait(reason, since = Date.now()) {
        if (!wait.active) {
            wait.active = true;
            wait.since = since;
            wait.percent = 0;
            emitState();
        }
        wait.reason = reason;
        emitBuffering();
    }

    function endWait() {
        wait.avBuffering = false;
        if (!wait.active) return;
        wait.active = false;
        emitBuffering();
        emitState();
    }

    /** Время воспроизведения сдвинулось — картинка идёт. Вызывается и из oncurrentplaytime, и из опроса. */
    function onTime(time) {
        if (!(time > 0) || time === lastTime) return;
        // архив: сколько реально проиграно — по шагам времени (скачки при переоткрытии и сбоях не считаем)
        if (current && current.archive && lastTime > 0) {
            const step = time - lastTime;
            if (step > 0 && step < 5000) current.playedMs += step;
        }
        lastTime = time;
        lastAdvanceTs = Date.now();
        started = true;
        // Пока AVPlay считает, что буферизует, одиночному тику не верим — ждём секунду реального хода
        if (wait.avBuffering && time - wait.avStartTime < 1000) return;
        endWait();
    }

    const AVPLAY_LISTENER = {
        onerror: (err) => { console.error('[AVPlay] error', err); endWait(); },
        onbufferingstart: () => {
            wait.avBuffering = true;
            wait.avStartTime = Math.max(lastTime, 0);
            startWait(started ? 'buffering' : 'open');
            wait.percent = 0;
            emitBuffering();
        },
        onbufferingprogress: (percent) => {
            if (!wait.avBuffering) { wait.avBuffering = true; wait.avStartTime = Math.max(lastTime, 0); }
            startWait(started ? 'buffering' : 'open');
            wait.percent = Math.max(0, Math.min(100, Math.round(percent)));
            emitBuffering();
        },
        onbufferingcomplete: () => {
            wait.avBuffering = false;
            if (wait.active) { wait.percent = 100; emitBuffering(); }
            // сам индикатор снимет onTime, когда время пойдёт
        },
        oncurrentplaytime: onTime,
        onstreamcompleted: () => {
            console.log('[AVPlay] stream completed');
            endWait();
            emitState();
            listeners.completed.forEach(cb => cb(current));
        }
    };

    /** Опрос раз в WATCH_MS: ловит молча застывший поток и крутит счётчик секунд на индикаторе. */
    function watch() {
        // во сне AVPlay не трогаем вовсе: вызовы к оборванному потоку после пробуждения подвешивали приложение
        if (!current || suspended) return;
        const st = getState();
        if (st === 'PLAYING') {
            onTime(safe('getCurrentTime', () => webapis.avplay.getCurrentTime()));
            if (started && !wait.active && Date.now() - lastAdvanceTs > STALL_MS) {
                startWait('buffering', lastAdvanceTs);   // секунды — с момента, когда кадр застыл
            }
        } else if (st === 'PAUSED' && wait.active && started && !wait.avBuffering) {
            endWait();   // на паузе время и не должно идти — это не зависание
        }
        if (wait.active) emitBuffering();
    }

    /** Nothing to do before the first real channel plays — see playUrl()'s header comment
     *  for why AVPlay must not be opened here with a placeholder URL. */
    function init() {
        setInterval(watch, WATCH_MS);
    }

    /** startMs — для фильмов: с какого места начать (перемотка после prepare, до play). */
    function playUrl(url, startMs) {
        // avplay.open() only accepts a real stream URI — opening with '' as a fake "init" step
        // (the previous approach) throws on real hardware and was crashing main() before the
        // clock even started. close() is wrapped because calling it with nothing open yet
        // (the very first channel) throws on some firmware. setListener() is re-applied on
        // every switch, not just once — avplay can drop it across a close()/open() cycle.
        try { webapis.avplay.close(); } catch (e) { /* nothing was open yet */ }
        suspended = false;
        // канал только открывается — картинки ещё нет; счётчик и проценты начинаются заново
        started = false;
        lastTime = -1;
        wait.active = false;
        wait.avBuffering = false;
        startWait('open');
        const token = ++openToken;
        videoInfo = null;
        webapis.avplay.open(url);
        webapis.avplay.setDisplayRect(0, 0, 1920, 1080);
        webapis.avplay.setListener(AVPLAY_LISTENER);
        webapis.avplay.prepareAsync(
            () => {
                if (token !== openToken) return; // пока готовился, уже переключили на другой канал
                // размер кадра известен только после prepare — тогда же и решаем про масштаб
                videoInfo = readVideoSize();
                applyScale();
                if (startMs > 0) safe('seekTo', () => webapis.avplay.seekTo(startMs));
                webapis.avplay.play();   // индикатор снимется, когда пойдёт время, см. onTime
                emitState();
            },
            (err) => { console.error('[AVPlay] prepare failed', err); endWait(); emitState(); }
        );
    }

    /** Ширина/высота видеодорожки из extra_info AVPlay; null, если прошивка не сообщила. */
    function readVideoSize() {
        const pick = (tracks) => {
            const video = (tracks || []).find(t => t.type === 'VIDEO');
            if (!video) return null;
            const info = typeof video.extra_info === 'string' ? JSON.parse(video.extra_info) : video.extra_info;
            const width = parseInt(info && (info.Width || info.width), 10);
            const height = parseInt(info && (info.Height || info.height), 10);
            return width > 0 && height > 0 ? { width, height } : null;
        };
        try {
            return pick(webapis.avplay.getCurrentStreamInfo()) || pick(webapis.avplay.getTotalTrackInfo());
        } catch (e) {
            console.warn('[Player] cannot read video size', e);
            return null;
        }
    }

    let stretched = false;     // выставлен ли сейчас FULL_SCREEN на AVPlay

    function applyScale() {
        const narrow = !!videoInfo && videoInfo.width / videoInfo.height < NARROW_ASPECT;
        const scaled = scaleMode === 'auto' && narrow;
        // Если растягивать не нужно и мы не растягивали — режим AVPlay не трогаем вовсе, чтобы
        // «Выкл» показывал ровно то же, что и до появления масштаба.
        if (scaled || stretched) {
            try {
                webapis.avplay.setDisplayMethod(scaled ? 'PLAYER_DISPLAY_MODE_FULL_SCREEN' : 'PLAYER_DISPLAY_MODE_LETTER_BOX');
                stretched = scaled;
            } catch (e) {
                console.warn('[Player] setDisplayMethod failed', e);
            }
        }
        if (videoInfo) videoInfo.scaled = scaled;
        listeners.videoInfo.forEach(cb => cb(videoInfo));
    }

    /** mode: 'off' | 'auto'. Применяется сразу к текущему каналу, без переоткрытия потока. */
    function setScaleMode(mode) {
        scaleMode = mode === 'auto' ? 'auto' : 'off';
        if (current) applyScale();
    }
    function getScaleMode() { return scaleMode; }
    function getVideoInfo() { return videoInfo; }

    /** channel: an entry from ChannelStore. Returns true/false for success — this is what the API layer checks. */
    function playChannel(channel) {
        if (!channel) return false;
        playUrl(channel.url);
        currentChannel = channel;
        current = channel;
        listeners.channelChanged.forEach(cb => cb(channel));
        return true;
    }

    function getCurrentChannel() { return currentChannel; }

    /** Каналы перезагрузили (пришёл EPG) — объект играющего канала заменяется новым без переоткрытия потока,
     *  иначе у него остаётся старый epgId и «что идёт» (OSD, MQTT state) пустое. */
    function updateCurrentChannel(channel) {
        if (!channel || !currentChannel || channel.key !== currentChannel.key) return;
        if (current === currentChannel) current = channel;
        currentChannel = channel;
    }

    /**
     * Фильм/серия видеопортала: media — {vod: true, fid, title, url, …} (см. VodUI). Слушатели
     * смены канала НЕ вызываются: канал для MQTT, списков и CH+/CH− остаётся прежним.
     */
    function playVod(media, startMs = 0) {
        if (!media || !media.url) return false;
        playUrl(media.url, startMs);
        current = media;
        return true;
    }

    function isVod() { return !!current && current.vod === true; }
    function getCurrentMedia() { return current; }

    // Все управляющие вызовы AVPlay обёрнуты: в неподходящем состоянии (например, pause на
    // остановленном потоке или seek на live без таймшифта) он бросает исключение, а необработанная
    // ошибка из обработчика пульта вывела бы на экран баннер фатальной ошибки.
    function safe(name, fn) {
        try { return fn(); } catch (e) { console.warn('[Player] ' + name + ' failed', e); return undefined; }
    }

    /** 'NONE' | 'IDLE' | 'READY' | 'PLAYING' | 'PAUSED' */
    function getState() { return safe('getState', () => webapis.avplay.getState()) || 'NONE'; }

    /** 'playing' | 'paused' | 'stopped' | 'buffering' — для внешнего API (MQTT). */
    function getPlaybackState() {
        const st = getState();
        if (st === 'PAUSED') return 'paused';
        if (st === 'IDLE' || st === 'NONE') return wait.active ? 'buffering' : 'stopped';
        return wait.active ? 'buffering' : 'playing';
    }

    function emitState() { listeners.state.forEach(cb => cb(getPlaybackState())); }

    // Архив — скользящее окно на сервере: после паузы дольше ARCHIVE_PAUSE_MS нужных сегментов в окне уже
    // нет, и AVPlay перепрыгнул бы вперёд. Поэтому такая пауза продолжается новым открытием с того же места.
    const ARCHIVE_PAUSE_MS = 20000;

    function pause() {
        safe('pause', () => webapis.avplay.pause());
        if (isArchive()) current.pausedAt = Date.now();
        emitState();
    }
    function resume() {
        if (isArchive() && current.pausedAt && Date.now() - current.pausedAt > ARCHIVE_PAUSE_MS) {
            playArchive(current.channel, getArchiveTime());
            return;
        }
        if (isArchive()) current.pausedAt = 0;
        safe('play', () => webapis.avplay.play());
        lastAdvanceTs = Date.now();   // после паузы время не шло — это не зависание
        emitState();
    }
    function stop() {
        safe('stop', () => webapis.avplay.stop());
        started = false;
        endWait();
        emitState();
    }
    /**
     * TV уходит в сон (или приложение в фон): поток закрывается целиком, иначе после пробуждения AVPlay
     * висит на оборванном соединении — вечная буферизация, и приложение не отвечает на пульт.
     * Открывает заново app.js (playChannel / playVod) после пробуждения.
     */
    function suspend() {
        openToken++;               // ответ prepareAsync уже закрытого потока не должен запустить play()
        safe('close', () => webapis.avplay.close());
        suspended = true;
        started = false;
        endWait();
        emitState();
    }
    function isSuspended() { return suspended; }

    /** После stop() поток нужно открыть заново — просто play() его уже не запустит. Архив — с того же места. */
    function restart(startMs) {
        if (isArchive()) playArchive(current.channel, getArchiveTime());
        else if (current) playUrl(current.url, startMs);
    }

    /** Позиция и длительность (мс) — для фильмов; у live длительность обычно 0. */
    function getPosition() { return safe('getCurrentTime', () => webapis.avplay.getCurrentTime()) || 0; }
    function getDuration() { return safe('getDuration', () => webapis.avplay.getDuration()) || 0; }
    function seekTo(ms) {
        safe('seekTo', () => webapis.avplay.seekTo(Math.max(0, Math.round(ms))));
        lastAdvanceTs = Date.now();   // пока перематывается, время стоит — это не зависание
    }

    /** ms: relative jump, e.g. seek(30000) forward 30s, seek(-30000) back 30s */
    function seek(ms) {
        if (isArchive()) { playArchive(current.channel, getArchiveTime() + ms / 1000); return; }
        safe('seek', () => {
            const pos = webapis.avplay.getCurrentTime();
            webapis.avplay.seekTo(Math.max(0, pos + ms));
        });
    }

    function parseExtra(track) {
        try {
            return typeof track.extra_info === 'string' ? JSON.parse(track.extra_info) : (track.extra_info || {});
        } catch (e) { return {}; }
    }

    /** [{ index, language }] — дорожки текущего потока. */
    function getAudioTracks() {
        return (safe('getTotalTrackInfo', () => webapis.avplay.getTotalTrackInfo()) || [])
            .filter(t => t.type === 'AUDIO')
            .map(t => ({ index: t.index, language: parseExtra(t).language || '' }));
    }
    function getCurrentAudioIndex() {
        const cur = (safe('getCurrentStreamInfo', () => webapis.avplay.getCurrentStreamInfo()) || [])
            .find(t => t.type === 'AUDIO');
        return cur ? cur.index : null;
    }
    function setAudioTrack(trackIndex) {
        safe('setSelectTrack', () => webapis.avplay.setSelectTrack('AUDIO', trackIndex));
    }

    function getAvailableBitrates() {
        // Depends on stream type (HLS ABR); exposed via getStreamingProperty on some FW versions
        try {
            return JSON.parse(webapis.avplay.getStreamingProperty('AVAILABLE_BITRATE') || '[]');
        } catch (e) { return []; }
    }
    function setBitrate(bitrateBps) {
        webapis.avplay.setStreamingProperty('SET_MAX_BITRATE', String(bitrateBps));
    }

    /**
     * Ссылка на архив канала с момента startSec (unix-секунды).
     *
     * tvg-rec нашего провайдера — схема Edem/iLook «shift» (найдена запросами 15.09.2026):
     *   <ссылка канала>?utc=<начало>&lutc=<сейчас>
     * Сервер отдаёт обычный live-HLS со скользящим окном (10 сегментов по 10 с, без ENDLIST), сдвинутый
     * в прошлое на (lutc − utc): каждая перезагрузка плейлиста — следующие сегменты. Поэтому AVPlay
     * играет архив как live: seekTo внутри него не работает, перемотка и долгая пауза — это новое
     * открытие с другим utc (см. playArchive/resume). lutc — по AppClock: если часы TV врут, сдвиг,
     * заданный пользователем, исправляет и архив.
     */
    function buildCatchupUrl(channel, startSec) {
        if (!channel || !channel.catchup) return null;
        const now = Math.floor((typeof AppClock !== 'undefined' ? AppClock.now() : new Date()).getTime() / 1000);
        const utc = Math.floor(startSec);
        if (channel.catchup.type === 'tvg-rec') {
            return channel.url + (channel.url.indexOf('?') >= 0 ? '&' : '?') + 'utc=' + utc + '&lutc=' + now;
        }
        // стандартный catchup-source с подстановками
        const template = channel.catchup.source || channel.url;
        return template.replace('{utc}', utc).replace('{lutc}', now);
    }

    /**
     * Архив канала с момента startSec (unix-сек). media: {archive: true, channel, startSec, playedMs}.
     * Слушатели смены канала вызываются, только если это другой канал (архив того же канала — не переключение).
     */
    function playArchive(channel, startSec) {
        const url = buildCatchupUrl(channel, startSec);
        if (!url) return false;
        const other = !currentChannel || currentChannel.key !== channel.key;
        playUrl(url);
        currentChannel = channel;
        current = { archive: true, channel, startSec: Math.floor(startSec), playedMs: 0, pausedAt: 0 };
        if (other) listeners.channelChanged.forEach(cb => cb(channel));
        emitState();
        return true;
    }

    function isArchive() { return !!current && current.archive === true; }

    /**
     * Какой момент эфира сейчас показывается в архиве (unix-сек, дробное). Считается от utc открытия по тому,
     * сколько реально проиграно (сумма шагов времени AVPlay): абсолютное время live-потока у AVPlay не
     * привязано к началу, а паузы и буферизация по часам считались бы неверно.
     */
    function getArchiveTime() {
        return isArchive() ? current.startSec + current.playedMs / 1000 : null;
    }

    function onChannelChanged(cb) { listeners.channelChanged.push(cb); }
    /** cb(isWaiting, {reason: 'open'|'buffering', percent 0..100, seconds}) — true: ждём картинку
     *  (открытие канала, пустой буфер, зависший поток), false — видео идёт. Пока ожидание
     *  длится, вызывается повторно раз в полсекунды — чтобы бежали секунды. */
    function onBufferingChanged(cb) { listeners.buffering.push(cb); }
    /** cb('playing'|'paused'|'stopped'|'buffering') — при смене состояния (может повторяться). */
    function onStateChanged(cb) { listeners.state.push(cb); }
    /** cb({width, height, scaled} | null) — после открытия канала и при смене режима масштаба. */
    function onVideoInfo(cb) { listeners.videoInfo.push(cb); }
    /** cb(media) — поток доиграл до конца (фильм кончился). */
    function onCompleted(cb) { listeners.completed.push(cb); }

    return {
        init, playChannel, getCurrentChannel, updateCurrentChannel, playVod, isVod, getCurrentMedia,
        playArchive, isArchive, getArchiveTime,
        getPosition, getDuration, seekTo, onCompleted, suspend, isSuspended,
        setScaleMode, getScaleMode, getVideoInfo, onVideoInfo,
        pause, resume, stop, restart, seek, getState, getPlaybackState, onStateChanged,
        getAudioTracks, getCurrentAudioIndex, setAudioTrack,
        getAvailableBitrates, setBitrate,
        buildCatchupUrl, onChannelChanged, onBufferingChanged
    };
})();
