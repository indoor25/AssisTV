# Changelog

Versions: the TV player (`config.xml`) and the Home Assistant add-on (`ha-addon/epg_builder/config.yaml`)
are numbered separately.

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
