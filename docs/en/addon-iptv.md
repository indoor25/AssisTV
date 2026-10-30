# The "AssisTV" add-on: every setting

🇷🇺 [Русский](../addon-iptv.md)

The add-on is the server for your TVs: it downloads playlists and the EPG, maps channels to the guide,
checks the archive, searches movie sources, adds ratings and reviews, keeps favourites, reminders and the
registry of TVs, serves the Home Assistant card, enforces parental control and answers the voice assistant's
requests.

**Why it is needed.** A typical EPG source (`epg.it999.ru/epg.xml.gz`) is 42 MB gzipped and 386 MB of XML.
A TV cannot parse such a file — it runs out of memory. The add-on does it on the Home Assistant machine and
gives the TV a compact JSON: only the channels of your playlist and the time window that matters.

Installation — [install-ha-addons.md](install-ha-addons.md). The TV app — [install-tv.md](install-tv.md).
The card — [ha-dashboards.md](ha-dashboards.md). Voice and chat — [assist.md](assist.md).

## Add-on options

| Option          | Default                           | What it is |
|-----------------|-----------------------------------|-----------|
| `playlists`     | an example                        | a list of `{name, url}` M3U playlists with channels. Movie sources are set up on the add-on page, section "Plugins" ([vod-plugins.md](vod-plugins.md)); old `<type>::[params]<address>` lines move there by themselves |
| `epg_urls`      | `https://epg.it999.ru/epg.xml.gz` | one or more XMLTV links (`.xml` or `.xml.gz`); on conflicts the upper one wins |
| `past_hours`    | `3`                               | how many hours of past programmes to keep in the playlist for the TV |
| `future_hours`  | `36`                              | how many hours ahead |
| `refresh_hours` | `6`                               | how often to rebuild |
| `manual_map`    | empty                             | manual channel mapping (easier in the window on the add-on page) |
| `mqtt_ws_port`  | `1884`                            | the Mosquitto WebSocket port the add-on tells the TVs |
| `language`      | `auto`                            | language of the add-on page and of answers for voice and chat: `auto` (the Home Assistant language), `en`, `ru`, `uk`, `de` |
| `tmdb_key`      | empty                             | TMDB key: movie rating, genres, description (see below) |
| `kinopoisk_key` | empty                             | Kinopoisk key: its score and viewer reviews (see below) |

**Put your own links into the options** — the repository has `example.com` in their place: the provider's
playlist (usually with a personal token). After changing options
press "Save" and restart the add-on.

About size: the −3 h..+36 h window is about 40 thousand programmes, 2.7 MB of JSON (0.6 MB gzipped).
`future_hours: 168` (a week) makes the file 4–5 times larger. For programme search and reminders the add-on
keeps a week of the guide in its own memory anyway — there is no need to raise `future_hours` for that.

A sample `playlists` section (the "Configuration" tab → ⋮ → "Edit in YAML"):

```yaml
playlists:
  - name: TV
    url: http://example.com/playlists/uplist/YOUR_TOKEN/playlist.m3u8
epg_urls:
  - https://epg.it999.ru/epg.xml.gz
tmdb_key: 0123456789abcdef0123456789abcdef
kinopoisk_key: 01234567-89ab-cdef-0123-456789abcdef
```

### Ratings and reviews

Movie sources themselves give no ratings — the add-on fetches them by title and year from two catalogues.
Both keys are free and optional; set one, both or none.

| Key | What you get | Where to get it |
|-----|--------------|-----------------|
| `tmdb_key` | TMDB rating, genres, description in the add-on's language | [themoviedb.org](https://www.themoviedb.org) → sign up → Settings → API → **API Key (v3 auth)** — 32 characters (not the long v4 token). The "website" field in the form accepts anything |
| `kinopoisk_key` | Kinopoisk score, **viewer reviews (in Russian)**, Russian genres | [kinopoiskapiunofficial.tech](https://kinopoiskapiunofficial.tech) → sign up → the key is in your account right away. The limit is 500 requests a day; what is left is shown in `/status` (the `kinopoisk` field) |

Why both: Soviet and Russian films have almost no votes on TMDB, while TMDB's world catalogue is wider. If
you do not watch Russian-language cinema, `tmdb_key` alone is enough — you only lose the reviews screen.
The movie card shows both scores.

- A match is looked for by title and year; a doubtful one is dropped — better no rating than someone
  else's (remakes: "Dune" 1984 and 2021 are different films).
- A rating based on fewer than 10 votes is not shown.
- What was found is kept for 30 days, so few requests are spent.
- Ratings suddenly gone — open `http://<HA IP>:8765/status`: most likely the daily quota ran out.

## The add-on page

Turn on **"Show in sidebar"** for the add-on — an item with its page appears in the HA menu (the page is
also available at `http://<HA IP>:8765/`). It has:

- **TVs**: each TV's name, the `remote.*` and `media_player.*` entities for power and app launch, MQTT
  topics, the card's YAML, a "Remove TV" button. A TV appears in the list by itself when the app starts on
  it for the first time. The device's area is set in HA (Settings → Devices), the name — here.
- **Playlists**: what is loaded now, when it was built.
- **"+ Map channel"**: playlist channels on the left, EPG channels on the right (with the number of
  programmes and the date of the last one). Buttons "Assign", "No guide", "Restore automatic". Mappings are
  stored in `/data/manual_map.json` and outrank the `manual_map` option. After a mapping the add-on rebuilds
  the playlists in a couple of seconds, without downloading the EPG again.
- **Parental control**: PIN and groups (see below). **Settings can be changed only through the HA sidebar**
  (ingress): opened directly at `http://<HA IP>:8765` the page is read-only.

## Service addresses

| Address | Purpose |
|---------|---------|
| `/playlists.json` | list of playlists for the TV |
| `/playlists/<id>.json` | channels + EPG of one M3U (for a movie source — its link) |
| `/playlists/<id>/archive.json?name=` | the guide for past days, for the archive |
| `/playlists/<id>/programme.json?name=&at=` | programme description (genre, age rating, text) |
| `/tvs.json`, `POST /tvs/register` | TV registry and registration |
| `/status` | build state: time, size, how many channels matched, the unmatched ones, the last error, movie sources (`vod_sources`), Kinopoisk quota |
| `/rebuild` | rebuild now (`?force=1` — accept the EPG even if it looks truncated) |
| `/vod/search?q=matrix` | movie search (handy to check from a browser); `&src=<type>` — in one source |
| `/vod/meta?title=&year=&kind=` | rating, genres, description |
| `/vod/reviews?id=<Kinopoisk id>&page=1` | reviews |
| `/favorites.json`, `POST /favorites` | favourites |
| `/posters/<id>.jpg` | posters (the add-on's cache) |
| `/vod-sources.json`, `/vod-sources/<type>.js` | source plugins for the TV |

If the EPG has never been built yet, data is served with error 503; the last successful build is kept in
`/data`, so after a restart the TV gets it at once.

**Protection against a truncated EPG.** Sources sometimes serve a cut-off file (the guide ends in a couple
of hours). If in the fresh EPG noticeably fewer channels have programmes more than 6 hours ahead than in the
previous one, the add-on keeps the previous one and downloads again in 30 minutes. The log says
"EPG урезан…" (the add-on log is in Russian), `/status` has `epgRejected`.

## The IPTV card in Home Assistant

How to connect it and what it can do — [ha-dashboards.md](ha-dashboards.md).

## Parental control

Set on the add-on page (only through the HA sidebar):

- **PIN** — stored as a hash and cannot be recovered, but a new one can be set without the old one (the
  protection is the HA login itself).
- **Locked groups** — by default detected by name (`adult`, `xxx`, `18+`, and the Russian word for "adult").
- **Per TV**: "show with a lock" or "do not show at all".
- Opened access lasts **until the TV is turned off**.
- **Protected channels are never turned on by voice.**
- In the card, protected groups ask for the PIN too (until the page is reloaded).

After 5 wrong attempts there is a one-minute pause (separately on the TV and in the card).

## Control from automations and by voice

For voice and chat there are ready-made scripts — [assist.md](assist.md). Below is what they are built on;
useful for your own automations.

The add-on listens to the shared MQTT topic `iptv/request` (JSON) and decides itself which TV to send the
command to:

```jsonc
{"request_id":"1","action":"channel","query":"bbc one","tv":"bedroom"}
{"request_id":"2","action":"vod_search","query":"matrix"}
{"request_id":"3","action":"vod_play","query":"game of thrones season 3","tv":"living room"}
{"request_id":"4","action":"status"}
{"request_id":"5","action":"command","command":"volume_down","value":3}
{"request_id":"6","action":"vod_play","query":"interstellar","quality":"4K"}
{"request_id":"7","action":"vod_info","query":"dune 2021"}
{"request_id":"8","action":"favorite_add","query":"interstellar"}
{"request_id":"9","action":"vod_recommend","titles":"Prisoners (2013); Shutter Island (2010)","tv":"living room"}
{"request_id":"10","action":"vod_play","choice":2}
{"request_id":"11","action":"guide_search","query":"football","day":"today"}
{"request_id":"12","action":"command","command":"sleep","value":30}
```

| `action` | What it does | Fields |
|----------|--------------|--------|
| `channel` | turn a channel on by name (recognition mistakes are corrected) | `query`, `tv` |
| `vod_search` | find a movie in all sources; no TV needed | `query`, `limit` |
| `vod_play` | find and play a movie/series (a series — from the last episode and position) | `query` or `id`, `episode_fid`, `from_start`, `quality` ("4K", "1080p", "best"), `choice` (a number from the selection on the screen), `tv` |
| `vod_info` | Kinopoisk and TMDB rating, genres, description, `available` — whether the sources have it | `query` |
| `favorites` | the favourites list (full records) | — |
| `favorite` | add/remove by `id` (`add: true/false`; without it — toggle) | `id`, `title`, `year`… |
| `favorite_add` | add by voice: without `query` — what is playing on the TV; if several fit — `error: ambiguous` and `options`, the list is shown on the screen as well | `query`, `choice`, `tv` |
| `favorites_titles` | favourites as titles + `watched` (what was watched) + `suggested_recently` | — |
| `vod_recommend` | show a selection on the TV: the add-on keeps the titles that the sources have, that are not in the favourites and were not watched | `titles` (a `;`-separated string or a list), `more`, `tv` |
| `status` | what is on (without `tv` — on every TV where the player is running) | `tv` |
| `guide` | a channel's guide for 24 hours (without `query` — the channel that is on) | `query`, `tv` |
| `guide_search` | search for a programme across all channels for a week ahead | `query`, `channel`, `day` (`today`, `tomorrow`, `YYYY-MM-DD`) |
| `remind` / `reminders` / `remind_cancel` | a reminder 5 minutes before a programme starts | `ref` (from `guide_search`) or `query` |
| `tonight` | what is on tonight on the channels the household watches (the add-on keeps its own per-channel watch time) | `day`, `from`, `to` (hour or `HH:MM`) |
| `move` | continue what is playing on another TV from the same spot; the first TV is turned off | `to`, `from`, `keep` |
| `archive_guide` / `archive` | the list of a channel's archived shows / play a recording | `query`, `start`, `tv` |
| `command` | `play`, `pause`, `play_pause`, `stop`, `next`, `prev`, `volume_up`/`volume_down` (step in `value`), `volume` (`value` 0–100), `mute`, `unmute`, `mute_toggle`, `open` (turn the TV on and open the player), `power_off` (turn the TV off), `from_start` (the show or movie from its start), `live` (back to live TV), `seek` (`value` seconds, negative — back), `sleep` (`value` minutes, 0 — cancel) | `command`, `value`, `tv` |

- `tv` — a `tv_id`, the TV's name or an area (room) in HA; word endings are tolerated. Without `tv`: the
  only TV, or the one where the player is running if there is exactly one; otherwise the answer is
  `ambiguous_tv` / `no_tv_on` with a `tvs` list.
- For `channel` and `vod_play` a TV that is off is turned on (`KEY_POWER` through `remote.*`), the player
  is started, and the add-on waits for it to come online (up to about a minute).
- The answer comes to `iptv/request/result`: `{request_id, action, ok, message, error?, …}`. `message` is a
  ready-made phrase in the add-on's language. Errors: `not_found`, `ambiguous_tv`, `tv_not_found`,
  `no_tv_on`, `player_off`, `locked` (parental control), `timeout`, `unknown_command`, `ambiguous` (several
  movies — pick a `choice`), `no_movie`, `no_titles`, `none_available`, `no_archive`, `no_epg`.
- The last answer is also visible in the `sensor.iptv_otvet` sensor (the "IPTV add-on" device): the state is
  `message`, the attributes are the whole answer.
- **What counts as watched.** The add-on follows the players' state: a movie or series that has been on for
  10 minutes is written to `/data/watched.json` and no longer appears in selections. `more: true` in
  `vod_recommend` additionally removes everything shown during the last 6 hours.
- 5 minutes before a programme with a reminder the add-on sends a notice to the TVs (`iptv/<tv_id>/notify`)
  and the `iptv/reminder` event — you can hang a spoken announcement on it ([assist.md](assist.md)).

A sample automation — turn the news on in the kitchen at 7 am:

```yaml
actions:
  - action: mqtt.publish
    data:
      topic: iptv/request
      payload: '{"action": "channel", "query": "BBC News", "tv": "kitchen"}'
```

Another one — a film night button: show a fixed selection on the living room TV:

```yaml
actions:
  - action: mqtt.publish
    data:
      topic: iptv/request
      payload: '{"action": "vod_recommend", "titles": "Prisoners (2013); Zodiac (2007); Se7en (1995)", "tv": "living room"}'
```

The topics of one TV are `iptv/<tv_id>/…`: `set_channel`, `command`, `state` (retained), `availability`,
`channels`, `current_playlist`, `set_playlist`, `vod/play`, `notify` (a notice with text), `suggest` (the
selection page), `tv/power_on`, `tv/launch`. The full list is in the header of `js/mqtt-bridge.js`. For every
TV the player creates a device in HA (MQTT Discovery): `sensor.iptv_<tv_id>_playback` (attributes —
everything about playback), `sensor.iptv_<tv_id>_channel`, `select.iptv_<tv_id>_playlist`, volume, buttons.

## How it works inside

| File | What it does |
|------|--------------|
| `server.js` | HTTP, the add-on page, MQTT, the TV registry, power and app launch, `iptv/request` requests |
| `build.js` | downloading and parsing M3U/XMLTV, channel matching, building playlists |
| `archive.js` | checks which channels really have an archive (requests segments) |
| `vod.js` | movie search across sources, movie card, posters |
| `plugins.js` | source plugins: installing from the page, settings, giving copies to TVs |
| `sandbox.js`, `plugin-host.js` | the plugin sandbox: a separate process with no file access and no Supervisor token |
| `pairing.js` | pairing a TV with a code |
| `mqtt-proxy.js` | MQTT for TVs through the add-on |
| `tmdb.js`, `kinopoisk.js` | ratings, genres, descriptions, reviews |
| `favorites.js` | shared favourites |
| `guide.js` | TV guide search, reminders |
| `parental.js` | PIN, groups, per-TV restrictions |
| `card-data.js` | data and files of the card in `/homeassistant/www/tizen-iptv` |
| `shared/` | copies of the player's shared files — channels must be matched the same way on the server and on the TV |

> **About `shared/`.** These are copies of the player's shared files: parsers, channel search, the registry
> and plugins of movie sources (`vod-sources/`), translations (`lang/`). The logic is not duplicated: the
> files are copied by `deploy.ps1`. If you install by hand, copy them yourself after editing `js/`.

You can run the checks without HA:

```bash
node tools/channel-match-test.js      # channel search, must be 61/61
node tools/guide-test.js              # TV guide and reminders
node tools/vod-sources-test.js        # movie sources, favourites
node tools/i18n-check.js              # translations: every language has the same phrases
```

## If something is wrong

| Symptom | What to check |
|---------|---------------|
| `/status` does not open | the add-on is not running; port 8765 is taken (change it in the add-on's "Network" section and in the TV settings) |
| `/status` has `lastError` with `HTTP 4xx/5xx` | the playlist (expired token) or the EPG source is unreachable — open the link from the error in a browser |
| `matchedChannels` dropped sharply | the provider renamed channels — look at `unmatched`, map them by hand on the add-on page |
| A channel has a logo but no guide | a gap in the source: it has no programmes for some channels at all. Only a second source in `epg_urls` helps |
| The TV says the add-on is unavailable | the add-on log has no requests from the TV — check the add-on address in the TV settings and that the TV and the server are on the same network |
| The card is old | reload the HA page; an old card version sends old commands |
| Movie search in the card is silent | the MQTT subscription is available to HA administrators only |
| Movies have no rating | no key is set or the daily quota ran out — `/status`, the `kinopoisk` field |
| No "Reviews" button | `kinopoisk_key` is not set or the movie has no reviews |
| A new movie source is not visible | `/status` → `vod_sources`: is it there and does it have an `error` ([vod-plugins.md](vod-plugins.md)) |
| The add-on stopped after a large EPG source was added | it ran out of memory — remove the source or use fewer of them; the log shows the reason |
