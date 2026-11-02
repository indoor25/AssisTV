# Changelog

Versions: the TV player (`config.xml`) and the Home Assistant add-on (`ha-addon/epg_builder/config.yaml`)
are numbered separately.

## Add-on 2.21.5

- HA card: `collapse_channels: true` folds the channel list under a "Channels" row (closed on load, opens with a tap);
  the player then takes the full card width. Handy when the card shares a dashboard with other cards.

## Player 1.4.5

- Player: a first-start wizard — language, the add-on address (checked right away), the pairing code, and a
  short "which button does what" screen. Shown while the add-on address is empty.
- Player: Settings → **About** — version, licence, where the code is, and a QR code to support the project (Ko-fi).

## Add-on 2.21.4

- Home Assistant installs the add-on from ready-made images (GHCR) instead of building it on the device —
  installation and updates take seconds, not 10–20 minutes on a Raspberry Pi.

## Add-on 2.21.3

- Add-on page: links to the project and to Ko-fi at the bottom; `FUNDING.yml` for the Sponsor button on GitHub.
- `libs/THIRD_PARTY_NOTICES.md` — the MQTT.js licence for the bundled library.

## Add-on 2.21.2

- Add-on page: the playlist build time is a readable date (before: a raw ISO timestamp).
- "Video portal" is now "movie source" on the add-on page, in the HA card and in assistant replies — any plugin can be the source.
- Ready-made add-on images for aarch64, amd64 and armv7 are built on GitHub (GHCR).
- Documentation site (MkDocs), screenshots, pairing and the `-Legacy` build in the docs.

## Player 1.4.4

- Player: a movie paused for a long time no longer "ends" a few minutes after Play — the server drops the
  idle connection, and the player now reopens the movie at the same place (up to three times in a row).
- Player 1.4.3: the "Pause" label is cleared when the TV goes to sleep.
- Player: a `-Legacy` build for older TVs (Tizen 3, 2017): `tools/build-wgt.ps1 -Legacy`.
- Player: MQTT keeps its connection on old TV browsers (keep-alive pings were not sent).
- Assist scripts: each request gets its own `request_id` — two calls in one assistant reply no longer swap answers.
- Plugins: an example source plugin for Internet Archive (public-domain classic films).

## Player 1.4.2 · Add-on 2.21.1

First-run fixes, found by walking through a new TV setup:
- Player: with no add-on address the player opens Settings right on that field, with a short explanation
  (before: a black screen and a 12-second message).
- Player: when the add-on is unreachable and nothing is cached, the "No playlists" window opens with its Settings row.
- Player: a TV without channels picks up a playlist as soon as the add-on has built it and starts the first
  channel (before: only after pressing OK on the playlist, or after up to 3 hours).
- Player: the playlist window says when a playlist failed to load in the add-on or is still being prepared;
  "open" is translated.
- Player: a message at the bottom no longer covers the Save button in Settings.
- Add-on: "last seen" of a TV is a readable date, and is shown right after pairing (before: "{time}").

## Player 1.4.0 · Add-on 2.21.0 — first public release

The project is now called **AssisTV**.

### Player (TV)
- Channels, groups and your own order, logos, TV guide, archive (catch-up) with rewinding, "from the start".
- Movies and series from source plugins: categories, search, filters, series, "continue watching", quality,
  several audio tracks, Kinopoisk and TMDB ratings and reviews.
- Favourites shared by all TVs and the Home Assistant card.
- Parental control with a PIN, sleep timer, reminders, on-screen suggestions from the assistant.
- Interface in English, Russian, Ukrainian and German.
- Pairing with the add-on by a 6-digit code.

### Add-on (Home Assistant)
- Prepares playlists and the TV guide from several XMLTV sources; manual channel ↔ EPG matching.
- TV registry, power on and launching the player; MQTT for TVs through the add-on.
- "Plugins" section: install by link or file, settings form, sandbox; optional copy on the TV to work without
  Home Assistant.
- Voice control through Assist: channels, movies, TV guide, "what to watch tonight", moving playback to
  another TV.
- Home Assistant card: now playing, controls, channel tiles, movie search.

Before this release the project was developed privately; its history is not published.
