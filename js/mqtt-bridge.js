/**
 * MQTT bridge: TV app makes an OUTBOUND connection to your existing broker
 * (Mosquitto add-on on the Home Assistant Pi). This avoids needing an inbound server
 * inside the Tizen sandbox, and gives Home Assistant a simple pub/sub surface it already
 * knows how to talk to. mqtt.js (libs/mqtt.min.js) connects over WebSocket — on this broker
 * it is port 1884 (see CONFIG.mqtt in app.js), 1883 is plain TCP for HA / mosquitto_pub.
 *
 * Телевизоров несколько, у каждого свои топики: iptv/<tv_id>/… — tv_id выдаёт аддон при регистрации
 * (js/addon-client.js). Старые iptv/… без tv_id (переходный период) обслуживает аддон: пересылает их
 * «старому» телевизору и повторяет его ответы — сам плеер их больше не знает.
 *
 * Topics (P = iptv/<tv_id>):
 *   P/set_channel        <- publish channel NAME here to switch (from HA / Assist); канал под родительским
 *                           контролем — только {name, key} от аддона (PIN ввели в карточке), иначе error 'locked'
 *   P/current_channel    -> app publishes the name of whatever is now playing (retained)
 *   P/set_channel/result -> app publishes {ok: bool, channel, query, score, alternatives, error?}
 *
 *   P/command            <- текстовая команда: play | pause | play_pause | stop | next | prev |
 *                           volume_up [N] | volume_down [N] | volume N | mute | unmute | mute_toggle |
 *                           next_episode / prev_episode (в сериале) | seek N (сдвиг на N секунд) |
 *                           seek_to N (позиция в секундах от начала видео или unix-секунды архива) |
 *                           from_start (передача с начала, из архива) | live (из архива в эфир) |
 *                           sleep N (выключить TV через
 *                           N минут, 0 — отменить)
 *                           (или JSON {"command": "volume_up", "value": 5}); только JSON:
 *                           {"command": "archive", "value": {"channel", "start" (unix-сек), "key"?}} — запись канала
 *                           с момента start (без start — текущая передача с начала); result.value — откуда включили
 *   P/command/result     -> {ok, command, value?, error?} после каждой команды
 *   P/set_playlist       <- имя плейлиста (как в аддоне) или его id
 *   P/set_playlist/result-> {ok, playlist, query, kind?, error?}  (error: not_found)
 *   P/current_playlist   -> имя открытого плейлиста (retained)
 *   P/state              -> {channel, number, group, logo, state, programme, programme_start,
 *                            programme_stop, volume, muted, playlist, vod_id, vod_fid, vod_title,
 *                            vod_is_series, vod_episode_index/count, vod_position/duration, seekable,
 *                            archive_position,
 *                            archive, archive_time, sleep_until} (retained; при архиве programme — показываемая
 *                           передача; sleep_until — когда сработает таймер сна, unix-сек, или null);
 *                           vod_* — не null, пока идёт фильм портала (channel тогда — последний канал);
 *                           state: playing | paused | stopped | buffering
 *   P/channels           -> {updatedAt, playlist, channels: [[имя, группа, логотип]]} (retained)
 *   P/availability       -> online / offline (retained; offline брокер публикует сам — last will)
 *   P/config             <- {tv_id, name, area, parental} (retained, публикует аддон) — имя прибора в HA и
 *                           родительский контроль (js/parental.js)
 *   P/vod/play           <- {request_id, fid, episode_fid?, from_start?, title?} — включить фильм/сериал портала
 *   P/vod/play/result    -> {request_id, ok, fid, title?, error?}
 *   P/notify             <- {text, channel?, seconds?} — плашка на экране (напоминание о передаче от аддона или
 *                           любое сообщение из автоматизации HA); с channel OK на пульте включает этот канал
 *   P/suggest            <- {title, seconds?, items: [{n, id, title, year, kind, poster, kpRating, rating, genres,
 *                           description}]} — подборка фильмов от ассистента: страница с постерами поверх экрана
 *                           (js/suggest-ui.js); пустой items — убрать её
 *   P/tv/power_off       -> таймер сна досчитал — аддон выключает телевизор (плеер сам этого не может)
 *                           (поиск фильмов и «на каком TV» — в аддоне: iptv/request, iptv/vod/search)
 *   iptv/playlists       <- список плейлистов аддона поменялся (retained) — перечитать
 *
 * При подключении публикуется MQTT Discovery (homeassistant/...): у каждого телевизора свой прибор
 * «IPTV <имя>» с областью HA; entity_id от tv_id (sensor.iptv_<tv_id>_playback и т.д.), чтобы не
 * зависеть от имени, которое потом меняют.
 */
const MqttBridge = (() => {
    const DISCOVERY_PREFIX = 'homeassistant';
    const TOPIC_PLAYLISTS = 'iptv/playlists';

    let client = null;
    let handlers = {};
    let tv = null;         // {tv_id, name, area}
    let T = null;          // топики этого телевизора
    let stateTimer = null;
    let lastStateBody = '';
    let lastStateTs = 0;
    let lastDiscovery = '';

    function topics(id) {
        const p = 'iptv/' + id;
        return {
            set: p + '/set_channel', current: p + '/current_channel', result: p + '/set_channel/result',
            command: p + '/command', commandResult: p + '/command/result',
            setPlaylist: p + '/set_playlist', playlistResult: p + '/set_playlist/result', currentPlaylist: p + '/current_playlist',
            state: p + '/state', availability: p + '/availability', channels: p + '/channels', config: p + '/config',
            vodPlay: p + '/vod/play', vodPlayResult: p + '/vod/play/result',
            notify: p + '/notify', suggest: p + '/suggest', powerOff: p + '/tv/power_off'
        };
    }

    /**
     * Один раз при старте. handlers: play, pause, playPause, stop, next, prev — действия плеера из
     * app.js (с тем же показом на экране, что и у пульта); getChannelNumber(channel);
     * getPlaylists() → [{id, name, kind}]; getCurrentPlaylist() → имя; setPlaylist(index);
     * onPlaylistsChanged() — аддон поменял список; onTvConfig({name, area}) — переименовали TV;
     * notify(text) — всплывающее сообщение на TV; onStatus(status, detail) — статус подключения.
     * Слушатели Player/TvAudio вешаются здесь, а не в connect(): connect() вызывается повторно при
     * сохранении настроек, и каждый вызов добавлял бы ещё один слушатель.
     */
    function init(h) {
        handlers = h || {};
        Player.onChannelChanged((channel) => { publishCurrentChannel(channel); scheduleState(); });
        Player.onStateChanged(scheduleState);
        TvAudio.onChange(scheduleState);
        ChannelStore.onChanged(scheduleChannels);
        // передача на канале сменяется сама по себе, без событий плеера; online — на случай, если его
        // затёр чужой last will (прежнее подключение этого же TV)
        setInterval(() => { if (Player.isVod() || Player.isArchive()) publishState(); }, 1000);
        setInterval(() => {
            publishState();
            if (T) publish(T.availability, 'online', { retain: true });
        }, 30000);
    }

    // Плейлист для карточки в HA — в пользовательском порядке, с логотипами (в т.ч. заменёнными
    // вручную). Меняется пачками (загрузка EPG, перестановка по одному шагу) — шлём с задержкой.
    let channelsTimer = null;
    function scheduleChannels() {
        clearTimeout(channelsTimer);
        channelsTimer = setTimeout(publishChannels, 3000);
    }

    function publishChannels() {
        const list = ChannelStore.getAll();
        if (!list.length || !T) return;
        publish(T.channels, {
            updatedAt: Math.floor(Date.now() / 1000),
            playlist: handlers.getTvPlaylist ? handlers.getTvPlaylist() : null,
            // [имя, группа, логотип] — позиция в массиве = номер канала − 1
            channels: list.map(c => [c.name, c.group || '', c.logo || ''])
        }, { retain: true });
    }

    /**
     * mqttCfg: {host, port, path?, username, password}; tvInfo: {tv_id, name, area} из регистрации в аддоне.
     * Привязанный телевизор ходит через аддон (path /mqtt, логин tv_id, пароль — токен), свой брокер из
     * Настроек — напрямую.
     */
    function connect({ host, port = 1884, path = '', username, password }, tvInfo) {
        if (!tvInfo || !tvInfo.tv_id) return;
        tv = { tv_id: tvInfo.tv_id, name: tvInfo.name || tvInfo.tv_id, area: tvInfo.area || '' };
        T = topics(tv.tv_id);
        const myTopics = T;
        // mqtt.js browser build exposes global `mqtt`
        const c = mqtt.connect(`ws://${host}:${port}${path}`, {
            username, password,
            clientId: 'tizen-iptv-' + tv.tv_id + '-' + Math.random().toString(16).slice(2, 8),
            reconnectPeriod: 5000,
            // брокер считает клиента пропавшим через 1,5 × keepalive; при 60 с по умолчанию выключенный TV
            // ещё ~40–90 с числился в HA «воспроизводящим»
            keepalive: 10,
            will: { topic: T.availability, payload: 'offline', retain: true, qos: 0 }
        });
        client = c;
        connectedWith = JSON.stringify([{ host, port, path, username, password }, tv.tv_id]);
        let wasConnected = false;
        let lastError = '';

        c.on('connect', () => {
            if (c !== client) return;
            console.log('[MQTT] connected as ' + tv.tv_id);
            c.subscribe([myTopics.set, myTopics.command, myTopics.setPlaylist, myTopics.config, myTopics.vodPlay, myTopics.notify, myTopics.suggest, TOPIC_PLAYLISTS]);
            publish(T.availability, 'online', { retain: true });
            lastDiscovery = '';
            publishDiscovery();
            publishCurrentChannel(Player.getCurrentChannel());
            publishCurrentPlaylist();
            lastStateBody = '';   // пока не было связи, публикации молча пропускались
            publishState();
            scheduleChannels();
            if (!wasConnected) handlers.onStatus?.('connected', `${host}:${port}`);
            wasConnected = true;
            lastError = '';
        });

        c.on('message', (topic, payload, packet) => {
            if (c !== client) return;
            const text = payload.toString().trim();
            if (topic === myTopics.set) handleSetChannel(text);
            else if (topic === myTopics.command) handleCommand(text);
            else if (topic === myTopics.setPlaylist) handleSetPlaylist(text);
            else if (topic === myTopics.config) handleTvConfig(text);
            else if (topic === myTopics.vodPlay && !(packet && packet.retain)) handleVodPlay(text);
            else if (topic === myTopics.notify && !(packet && packet.retain)) handleNotify(text);
            else if (topic === myTopics.suggest && !(packet && packet.retain)) handleSuggest(text);
            // retained-копия при подписке — это не изменение, список уже пришёл при регистрации
            else if (topic === TOPIC_PLAYLISTS && !(packet && packet.retain)) handlers.onPlaylistsChanged?.();
        });

        // mqtt.js переподключается сам; на экран — только смена состояния, а не каждая попытка
        c.on('error', (err) => {
            console.error('[MQTT] error', err);
            const msg = (err && err.message) || String(err);
            if (c === client && msg !== lastError) { lastError = msg; handlers.onStatus?.('error', msg); }
        });
        c.on('offline', () => {
            if (c === client && wasConnected) { wasConnected = false; handlers.onStatus?.('offline', `${host}:${port}`); }
        });
    }

    /** Имя может прийти с ошибками распознавания — см. js/channel-match.js. В ответе: что спросили
     *  (query), что включили (channel), уверенность (score) и похожие варианты (alternatives) —
     *  по ним HA может переспросить «вы имели в виду …?». */
    function handleSetChannel(text) {
        // {name, key} — от аддона, когда PIN родительского контроля уже ввели в карточке HA; иначе — просто имя
        let channelName = text;
        let key = null;
        if (String(text).charAt(0) === '{') {
            try { const obj = JSON.parse(text); channelName = String(obj.name || ''); key = obj.key || null; } catch (e) { /* имя с фигурной скобкой */ }
        }
        const found = ChannelStore.findByName(channelName);
        const channel = found.channel;
        // защищённые каналы похожими вариантами не подсказываем
        found.alternatives = (found.alternatives || []).filter(name => !Parental.isProtected(ChannelStore.getAll().find(c => c.name === name)));
        if (channel && Parental.isProtected(channel) && !Parental.keyMatches(key)) {
            publish(T.result, { ok: false, channel: channel.name, query: channelName, error: 'locked', score: found.score, alternatives: found.alternatives });
            handlers.notify?.(I18n.t('mqtt.channelLocked'));
            return;
        }
        if (!channel) {
            publish(T.result, {
                ok: false, channel: channelName, query: channelName, error: 'not_found',
                score: found.score, alternatives: found.alternatives
            });
            handlers.notify?.(I18n.t('mqtt.channelNotFound', { name: channelName }));
            return;
        }
        const ok = Player.playChannel(channel);
        publish(T.result, {
            ok, channel: channel.name, query: channelName,
            score: found.score, alternatives: found.alternatives
        });
    }

    /** Плейлист по имени (без учёта регистра и ё/е) или по id. */
    function handleSetPlaylist(text) {
        const list = handlers.getPlaylists ? handlers.getPlaylists() : [];
        const norm = s => String(s).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
        const q = norm(text);
        let idx = list.findIndex(p => norm(p.name) === q);
        if (idx < 0 && /^\d+$/.test(q)) idx = list.findIndex(p => String(p.id) === q);
        if (idx < 0 && q.length >= 3) idx = list.findIndex(p => norm(p.name).indexOf(q) >= 0);
        if (idx < 0) {
            publish(T.playlistResult, { ok: false, playlist: null, query: text, error: 'not_found', playlists: list.map(p => p.name) });
            handlers.notify?.(I18n.t('mqtt.playlistNotFound', { name: text }));
            return;
        }
        handlers.setPlaylist(idx);
        publish(T.playlistResult, { ok: true, playlist: list[idx].name, kind: list[idx].kind, query: text });
    }

    /**
     * {request_id, fid, episode_fid?, from_start?, quality?, title?} → P/vod/play/result {request_id, ok, fid, title?, error?};
     * просили quality — в ответе ещё quality (какое включили, null — выбора нет) и qualities (что было на выбор)
     */
    function handleVodPlay(text) {
        let msg;
        try { msg = JSON.parse(text); } catch (e) { msg = { fid: text }; }
        if (!msg || typeof msg !== 'object') msg = { fid: msg };
        const reply = (obj) => publish(T.vodPlayResult, Object.assign({ request_id: msg.request_id, fid: msg.fid }, obj));
        if (!handlers.playVod) return reply({ ok: false, error: 'unsupported' });
        Promise.resolve().then(() => handlers.playVod(msg))
            .then(r => reply(Object.assign({ ok: true, title: r && r.title },
                r && r.quality !== undefined ? { quality: r.quality, qualities: r.qualities } : {})))
            .catch(e => reply({ ok: false, error: (e && e.message) || String(e) }));
    }

    /** Фильм или сериал, который сейчас смотрят, — запись для избранного: {id, title, year, kind, poster}. */
    function favOf(vod) {
        const s = vod.series;
        const src = VodSources.splitId(vod.id).type;
        return {
            id: s ? VodSources.makeId(src, s.fid) : vod.id,
            title: s ? s.title : vod.title || vod.name || '',
            year: (s && s.year) || vod.year || null,
            kind: s ? 'series' : 'movie',
            poster: (s && s.poster) || vod.poster || null
        };
    }

    /** Подборка фильмов от ассистента: {title, seconds?, items: [...]}. */
    function handleSuggest(text) {
        let msg = null;
        try { msg = JSON.parse(text); } catch (e) { return; }
        if (msg && typeof msg === 'object') handlers.onSuggest?.(msg);
    }

    /** {text, channel?, seconds?} или просто текст. */
    function handleNotify(text) {
        let msg = null;
        if (text.charAt(0) === '{') { try { msg = JSON.parse(text); } catch (e) { /* текст с фигурной скобкой */ } }
        handlers.onNotify?.(msg && typeof msg === 'object' ? msg : { text });
    }

    function handleTvConfig(text) {
        try {
            const cfg = JSON.parse(text);
            if (!cfg || !tv) return;
            if ('parental' in cfg) handlers.onParental?.(cfg.parental);
            if ((cfg.name || tv.tv_id) === tv.name && (cfg.area || '') === tv.area) return;
            tv.name = cfg.name || tv.tv_id;
            tv.area = cfg.area || '';
            handlers.onTvConfig?.({ name: tv.name, area: tv.area });
            publishDiscovery();
        } catch (e) { console.warn('[MQTT] bad config', e); }
    }

    /** «volume_up 5» или {"command":"volume_up","value":5} → {command, value} */
    function parseCommand(text) {
        if (text.charAt(0) === '{') {
            try {
                const obj = JSON.parse(text);
                return { command: String(obj.command || '').toLowerCase(), value: obj.value };
            } catch (e) { return { command: '', value: undefined }; }
        }
        const parts = text.split(/\s+/);
        return { command: (parts[0] || '').toLowerCase(), value: parts[1] };
    }

    function handleCommand(text) {
        const { command, value } = parseCommand(text);
        const num = value === undefined || value === '' ? null : Number(value);
        const result = { ok: true, command };
        try {
            switch (command) {
                case 'play': handlers.play(); break;
                case 'pause': handlers.pause(); break;
                case 'play_pause': case 'toggle': handlers.playPause(); break;
                case 'stop': handlers.stop(); break;
                case 'next': case 'channel_up': handlers.next(); break;
                case 'prev': case 'previous': case 'channel_down': handlers.prev(); break;
                case 'next_episode':
                    if (!handlers.nextEpisode || !handlers.nextEpisode()) throw new Error('no_next_episode');
                    break;
                case 'prev_episode': case 'previous_episode':
                    if (!handlers.prevEpisode || !handlers.prevEpisode()) throw new Error('no_previous_episode');
                    break;
                case 'volume_up':
                case 'volume_down': {
                    const step = num === null ? 1 : num;
                    if (!(step > 0)) throw new Error('bad_value');
                    TvAudio.changeVolume(command === 'volume_up' ? step : -step);
                    result.value = TvAudio.getState().volume;
                    handlers.notify?.(I18n.t('mqtt.volume', { n: result.value }));
                    break;
                }
                case 'volume':
                    if (num === null || !isFinite(num)) throw new Error('bad_value');
                    TvAudio.setVolume(num);
                    result.value = TvAudio.getState().volume;
                    handlers.notify?.(I18n.t('mqtt.volume', { n: result.value }));
                    break;
                case 'mute': case 'unmute': case 'mute_toggle':
                    if (command === 'mute_toggle') TvAudio.toggleMute();
                    else TvAudio.setMute(command === 'mute');
                    result.value = TvAudio.getState().muted;
                    handlers.notify?.(I18n.t(result.value ? 'mqtt.muted' : 'mqtt.unmuted'));
                    break;
                // обработчики бросают код ошибки: no_archive, no_programme, locked, not_found, not_archive, not_playing
                case 'from_start': case 'restart': result.value = handlers.fromStart(); break;
                case 'archive': result.value = handlers.archive(value && typeof value === 'object' ? value : {}); break;
                case 'live': handlers.live(); break;
                // что и с какого места сейчас идёт — чтобы аддон продолжил это на другом телевизоре
                case 'where': result.value = handlers.where(); break;
                case 'seek':
                    if (num === null || !isFinite(num) || num === 0) throw new Error('bad_value');
                    handlers.seek(num);
                    break;
                case 'seek_to':
                    if (num === null || !isFinite(num) || num < 0) throw new Error('bad_value');
                    handlers.seekTo(num);
                    break;
                case 'sleep':
                    if (num === null || !isFinite(num) || num < 0) throw new Error('bad_value');
                    result.value = handlers.sleep(num);
                    break;
                default:
                    throw new Error('unknown_command');
            }
        } catch (e) {
            result.ok = false;
            result.error = (e && e.message) || String(e);
        }
        publish(T.commandResult, result);
        scheduleState();
    }

    function publishCurrentChannel(channel) {
        if (!channel || !T) return;
        publish(T.current, channel.name, { retain: true });
    }

    /** Открытый плейлист поменялся (app.js) — топик, состояние и, если поменялся список, discovery. */
    function playlistChanged() {
        publishCurrentPlaylist();
        publishDiscovery();
        scheduleState();
        scheduleChannels();
    }

    function publishCurrentPlaylist() {
        const name = handlers.getCurrentPlaylist ? handlers.getCurrentPlaylist() : null;
        if (name && T) publish(T.currentPlaylist, name, { retain: true });
    }

    // Состояние меняется пачками (смена канала = open + buffering + playing) — шлём одно сообщение
    function scheduleState() {
        clearTimeout(stateTimer);
        stateTimer = setTimeout(publishState, 300);
    }

    function publishState() {
        if (!T) return;
        const channel = Player.getCurrentChannel();
        const vod = Player.isVod() ? Player.getCurrentMedia() : null;
        const playbackState = Player.getPlaybackState();
        // архив: передача, которую показывают (по времени архива), а не та, что идёт в эфире
        const archiveAt = channel && Player.isArchive() ? Player.getArchiveTime() : null;
        const programme = !channel || vod ? null
            : archiveAt !== null ? (handlers.programmeAt ? handlers.programmeAt(channel, archiveAt * 1000) : null)
            : ChannelStore.getCurrentProgrammeFor(channel);
        const audio = TvAudio.getState();
        const sec = d => Math.floor(d.getTime() / 1000);
        const body = JSON.stringify({
            channel: channel ? channel.name : null,
            number: channel && handlers.getChannelNumber ? handlers.getChannelNumber(channel) : null,
            group: channel ? channel.group || null : null,
            logo: channel ? channel.logo || null : null,
            state: playbackState,
            programme: programme ? programme.title : null,
            // абсолютное время (unix-секунды) — прогресс карточка считает по своим часам
            programme_start: programme ? sec(programme.start) : null,
            programme_stop: programme ? sec(programme.stop) : null,
            volume: audio.volume,
            muted: audio.muted,
            playlist: handlers.getCurrentPlaylist ? handlers.getCurrentPlaylist() : null,
            // идёт фильм/серия: channel выше — последний канал, а смотрят это.
            // vod_id — составной («portal:48357»), vod_fid — номер у источника (его ждёт карточка HA)
            vod_id: vod ? vod.id || null : null,
            vod_fid: vod ? vod.fid : null,
            vod_title: vod ? vod.title || vod.name || null : null,
            vod_is_series: !!(vod && vod.series && vod.series.episodes && vod.series.episodes.length),
            vod_episode_index: vod && vod.series ? vod.episodeIdx : null,
            vod_episode_count: vod && vod.series ? vod.series.episodes.length : null,
            vod_position: vod ? Math.floor(Player.getPosition() / 1000) : null,
            vod_duration: vod ? Math.floor(Player.getDuration() / 1000) : null,
            archive_position: archiveAt !== null ? Math.floor(archiveAt) : null,
            seekable: vod ? Player.getDuration() > 0 && playbackState !== 'stopped' : archiveAt !== null && playbackState !== 'stopped',
            // что добавлять в избранное по «добавь это в избранное»: у серии — её сериал
            vod_fav: vod && vod.id ? favOf(vod) : null,
            // смотрят запись из архива: момент эфира (unix-сек, с точностью до минуты — чтобы не слать state каждые 30 с)
            archive: archiveAt !== null,
            archive_time: archiveAt !== null ? Math.floor(archiveAt / 60) * 60 : null,
            sleep_until: handlers.getSleepUntil ? handlers.getSleepUntil() : null
        });
        if (body === lastStateBody && Date.now() - lastStateTs < 300000) return;   // ничего не поменялось
        lastStateBody = body;
        lastStateTs = Date.now();
        publish(T.state, body, { retain: true });
    }

    /** MQTT Discovery: прибор этого телевизора в Home Assistant (retained, при подключении и смене имени/плейлистов). */
    function publishDiscovery() {
        if (!tv || !T) return;
        const deviceId = 'tizen_iptv_' + tv.tv_id;
        const playlists = (handlers.getPlaylists ? handlers.getPlaylists() : []).map(p => p.name);
        const signature = JSON.stringify([tv, playlists]);
        if (signature === lastDiscovery) return;
        lastDiscovery = signature;

        const device = { identifiers: [deviceId], name: 'IPTV ' + tv.name, manufacturer: 'Samsung Tizen', model: 'IPTV player' };
        if (tv.area) device.suggested_area = tv.area;
        const base = { availability_topic: T.availability, device };
        const entity = (component, id, config) => publish(
            `${DISCOVERY_PREFIX}/${component}/${deviceId}/${id}/config`,
            Object.assign({
                unique_id: `${deviceId}_${id}`,
                // entity_id от tv_id, а не от имени прибора (object_id в новых HA игнорируется)
                object_id: `iptv_${tv.tv_id}_${id}`,
                default_entity_id: `${component}.iptv_${tv.tv_id}_${id}`
            }, base, config),
            { retain: true }
        );
        const button = (id, name, payload, icon) =>
            entity('button', id, { name, command_topic: T.command, payload_press: payload, icon });

        entity('sensor', 'channel', { name: I18n.t('ha.channel'), state_topic: T.current, icon: 'mdi:television-classic' });
        entity('sensor', 'playback', {
            name: I18n.t('ha.playback'), state_topic: T.state, value_template: '{{ value_json.state }}',
            json_attributes_topic: T.state, icon: 'mdi:play-pause'
        });
        entity('sensor', 'programme', {
            name: I18n.t('ha.programme'), state_topic: T.state,
            value_template: "{{ value_json.programme if value_json.programme else '—' }}", icon: 'mdi:script-text-outline'
        });
        entity('text', 'set_channel', {
            name: I18n.t('ha.setChannel'), command_topic: T.set, state_topic: T.current, icon: 'mdi:form-textbox'
        });
        if (playlists.length) {
            entity('select', 'playlist', {
                name: I18n.t('ha.playlist'), command_topic: T.setPlaylist, state_topic: T.currentPlaylist,
                options: playlists, icon: 'mdi:playlist-play'
            });
        }
        entity('number', 'volume', {
            name: I18n.t('ha.volume'), command_topic: T.command, command_template: 'volume {{ value | int }}',
            state_topic: T.state, value_template: '{{ value_json.volume | int(0) }}',
            min: 0, max: 100, step: 1, mode: 'slider', icon: 'mdi:volume-high'
        });
        entity('switch', 'mute', {
            name: I18n.t('ha.mute'), command_topic: T.command, payload_on: 'mute', payload_off: 'unmute',
            state_topic: T.state, value_template: "{{ 'ON' if value_json.muted else 'OFF' }}",
            state_on: 'ON', state_off: 'OFF', icon: 'mdi:volume-off'
        });
        button('play_pause', I18n.t('ha.playPause'), 'play_pause', 'mdi:play-pause');
        button('stop', I18n.t('state.stopped'), 'stop', 'mdi:stop');
        button('next', I18n.t('ha.next'), 'next', 'mdi:skip-next');
        button('prev', I18n.t('ha.prev'), 'prev', 'mdi:skip-previous');
        button('volume_up', I18n.t('ha.volumeUp'), 'volume_up', 'mdi:volume-plus');
        button('volume_down', I18n.t('ha.volumeDown'), 'volume_down', 'mdi:volume-minus');
    }

    function publish(topic, payload, opts = {}) {
        if (!client || !client.connected) return;
        const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
        client.publish(topic, body, opts);
    }

    /**
     * Запрос аддону от самого телевизора (ответ пультом на вопрос плашки): тот же iptv/request, но топиком
     * карточки — ответ идёт мимо sensor.iptv_otvet, который ждут скрипты Assist. false — связи нет.
     */
    function request(obj) {
        if (!client || !client.connected) return false;
        publish('iptv/card/request', Object.assign({ request_id: 'tv' + Date.now() }, obj));
        return true;
    }

    /** Таймер сна досчитал: попросить аддон выключить телевизор. false — связи нет, просить некого. */
    function requestPowerOff() {
        if (!client || !client.connected || !T) return false;
        publish(T.powerOff, '1');
        return true;
    }

    /** Cleanly ends the current connection — used before reconnecting with new settings (see SettingsUI). */
    function disconnect() {
        if (client) {
            // штатное отключение: last will не сработает, поэтому offline публикуем сами
            if (T) publish(T.availability, 'offline', { retain: true });
            // end(false) — с пакетом DISCONNECT. При end(true) соединение просто рвалось, брокер через
            // ~15 с засчитывал клиента пропавшим и слал его last will «offline» ПОВЕРХ «online» нового
            // подключения — HA показывал плеер недоступным, хотя он работал (поймано 15.09.2026).
            client.end(false);
            client = null;
            connectedWith = '';
        }
    }

    /** Подключён ли уже с этими настройками — чтобы не переподключаться без нужды. */
    let connectedWith = '';
    function isConnectedWith(mqttCfg, tvInfo) {
        const m = mqttCfg || {};
        return !!client && connectedWith === JSON.stringify([{ host: m.host, port: m.port || 1884, path: m.path || '', username: m.username, password: m.password }, tvInfo && tvInfo.tv_id]);
    }

    function isConnected() { return !!client; }

    return { init, connect, disconnect, isConnected, isConnectedWith, handleSetChannel, handleCommand, playlistChanged,
        stateChanged: scheduleState, requestPowerOff, request };
})();
