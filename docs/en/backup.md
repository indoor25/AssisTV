# Updating and backups

🇷🇺 [Русский](../backup.md)

## How to update

**The add-on.**
- Installed from the app store (way A) — Home Assistant shows the update itself in
  Settings → Apps → AssisTV → **Update**.
- Copied as a folder (way B) — download the new version of the project, replace the `addons/epg_builder`
  folder through Samba, then Settings → Apps → Install app → ⋮ → "Check for updates" → AssisTV →
  **Update** (if the version went up) or ⋮ → **Rebuild**.
- From source (way C) — `.\ha-addon\deploy.ps1 -PiHost <HA IP>`.

The add-on's options and data (TVs, manual channel mappings, PIN, favourites, reminders, the list of watched
titles) survive an update. After updating the add-on reload the Home Assistant page so that the new card is
picked up.

**Voice scripts.** If `ha-config/iptv-assist-scripts.yaml` changed in the new version, replace your IPTV
scripts in `scripts.yaml` with it (see [assist.md](assist.md), step 4.2) and reload the scripts. If new
scripts appeared — expose them to Assist (step 4.3), otherwise the AI will not see them.

**The app on the TV.** Repeat the commands from [install-tv.md](install-tv.md), step 2.6.
Settings, channel order, logos and movie positions are kept.

**Which version is installed.** The add-on — the number at the top of its page in "Apps". The player — on
the TV: Settings → "This TV" → "Player version"; or from a computer, in a browser:
`http://<TV IP>:8001/api/v2/applications/TzIptvPl01.IPTVTizen` (the `version` field).

## Backups

Everything the player keeps in Home Assistant (TVs, channel mappings, PIN, favourites, reminders, the list
of watched titles, add-on options, scripts, cards) is part of a regular Home Assistant backup:
**Settings → System → Backups**. The automatic schedule (for example nightly, keeping 3–7 copies) and cloud
storage (Home Assistant Cloud, Google Drive and others) are there too.

The settings on the TV itself (add-on address, channel order, your own logos, the positions where you
stopped in movies) are stored only on the TV. They survive a reinstall of the app, but not a TV reset.

## Restoring from scratch

1. Install Home Assistant and restore the backup — the add-on, its data and the scripts come back.
   If there is no backup — go through [step 1](install-ha-addons.md), [step 3](ha-dashboards.md) and
   [step 4](assist.md) again.
2. The TVs recognise the add-on by themselves. If Home Assistant's IP address changed — change the add-on
   address in the player settings on every TV.

## For those who edit the code

- There are no secrets in the repository: the playlist with its token and the source keys are in the
  add-on options, and the TV gets its MQTT password from the add-on. Keep your real values outside git
  (the `private/` folder and the `sample-playlist.m3u8` file are already in `.gitignore`).
- Before committing it is worth checking that a secret did not get into the index:
  `git grep --cached -F -- '<value>'`.
- `.gitignore` does not understand comments at the end of a line — only on a line of their own.
