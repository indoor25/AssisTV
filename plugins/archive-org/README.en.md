# Internet Archive plugin

🇷🇺 [Русский](README.md)

Movies from the [Internet Archive](https://archive.org/details/feature_films) — a non-profit library
holding thousands of feature films in the public domain: 1940s noir, 1950s sci-fi and horror, silent
films, westerns, cartoons. **No key and no sign-up needed.**

This is a ready-made example plugin: install it to see how rows, search, the movie card, quality,
favourites and voice work in AssisTV, even if you have no video portal of your own.

## What you need first

- The **AssisTV** add-on in Home Assistant and the player on the TV — [steps 1 and 2](../../README.en.md).
- Internet access for Home Assistant and for the TV (video streams from archive.org servers straight to the TV).

## Installation

**1. Install the plugin.** Home Assistant → sidebar **AssisTV** → section **"Plugins"**. Either:

- **From a link** — paste the address and press "Install from link":
  ```
  https://raw.githubusercontent.com/indoor25/AssisTV/main/plugins/archive-org/archive-org.js
  ```
- **As a file** — download [`archive-org.js`](archive-org.js) and press "upload a file from your computer".

The plugin appears in the list as **Internet Archive**, disabled.

**2. Configure.** In the plugin card fill in:

| Field | What to enter |
|---|---|
| Name in the menu | what the source is called on the TV, e.g. `Film classics` |
| URL: https://archive.org | `https://archive.org` — **required**, without it the source does not show up |
| Language of rows | language of row titles: `ru`, `en`, `uk` or `de`; empty — English |
| Enabled | ✅ |
| Work on the TV without the add-on | optional: the plugin has no keys, so it is safe to enable |

Press **"Save"**.

**3. Open it on the TV.** No need to restart the player. In the player: RETURN on the group row of the
home screen → the playlist window → your new source (e.g. "Film classics").

## What's inside

- **Rows**: Popular, Film noir, Sci-fi & horror, Comedy, Silent films, Westerns, Cartoons, Recently added.
- **Filters**: genre and decade (1910s — 1970s).
- **Search** by title: `Nosferatu`, `Night of the Living Dead`, `His Girl Friday`.
- **Quality**: if a record has several versions (480p, 1080p…), the player shows a quality button.
- **Ratings and genres** come from Kinopoisk and TMDB through the player itself, if the add-on has the keys.
- **Voice**: "play the movie Nosferatu" — say the title the way it is written in the archive.

## Good to know

- Records are uploaded by archive users: one film may come in several versions, some lack a year or a
  description. The plugin uses curated collections only, and rows start with the most downloaded.
- 1930s exploitation films and "social guidance" reels are hidden. The archive has no age ratings for
  the rest — turn on AssisTV parental control if you need it.
- Video is plain `.mp4` (h.264). Archive servers are sometimes slow: if 1080p stutters, pick 480 with the
  quality button.

## If it does not work

| What you see | Why |
|---|---|
| The source is missing from the playlist window | the plugin is not enabled or the URL field is empty |
| "archive.org: HTTP 503" | the archive is temporarily down — try later |
| The card opens but there is no "Watch" | the record has no `.mp4`, only other formats — pick another version of the film |

How to write your own plugin — [docs/en/vod-plugins.md](../../docs/en/vod-plugins.md); this file is a
good starting point.
