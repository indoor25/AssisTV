# Step 1. Home Assistant: MQTT broker, the TV and the IPTV add-on

🇷🇺 [Русский](../install-ha-addons.md)

After this step the "AssisTV" add-on will be running: it downloads your playlist and TV guide and
prepares them for the TVs. The app is installed on the TV in the next step —
[install-tv.md](install-tv.md).

Menu names are given for Home Assistant 2026.9 in English and may differ slightly in your version. In older
versions "Apps" were called "Add-ons".

## What you need beforehand

- **Home Assistant OS** (or Supervised) — the kind where "Settings" has an **"Apps"** item. Tested on a
  Raspberry Pi 4 (4 GB). A Pi 5, a mini PC or a virtual machine will do as well.
- The TV and Home Assistant are on the same home network.
- A link to your **M3U playlist** (your IPTV provider gives it) and a link to an **XMLTV TV guide**
  (usually from the provider too; for example `https://epg.it999.ru/epg.xml.gz`).
- Find out the **IP address of Home Assistant**: Settings → System → Network (for example `192.168.1.10`).
  Below it is written as `<HA IP>`.
- Find out the **IP address of the TV**: on the TV, Settings → General → Network → Network Status →
  IP Settings. It is best to give the TV a fixed address in your router.

## 1.1. MQTT broker (Mosquitto)

Home Assistant sends commands to the TVs through it. If you already have MQTT — skip this.

1. **Settings → Apps → Install app** (the button at the bottom right).
2. Find **Mosquitto broker** → **Install** → **Start**. Turn on "Start on boot".
3. Home Assistant offers the **MQTT** integration by itself: Settings → Devices & services → under
   "Discovered" press **Configure** on MQTT → **Submit**.
4. Check that Mosquitto's WebSocket port is open: Mosquitto broker → the **"Configuration"** tab → the
   **"Network"** section: the **1884/tcp** line must have `1884`. This is the port the TV connects to.
   In a standard Mosquitto it is on from the start; nothing else needs configuring.

## 1.2. The Samsung Smart TV integration (for turning the TV on)

Needed so that Home Assistant can **turn the TV on** (from the card or by voice). Without it the player
works, but you will have to turn the TV on with the remote.

1. The TV is on. **Settings → Devices & services → Add integration** → find **Samsung Smart TV** → enter
   the TV's IP address.
2. An access request appears on the TV screen — press **"Allow"** with the remote.
3. Entities like `media_player.<name>` and `remote.<name>` appear. You will need them in step 1.5.

> The **SmartThings** integration will not do — you need **Samsung Smart TV** (the local one).

## 1.3. Installing the "AssisTV" add-on

Pick one of the ways.

### Way A — from the app store

The easiest is the button (it opens your Home Assistant and offers to add the repository; then go
straight to item 3):

[![Add the repository to my Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Findoor25%2FAssisTV)

Or by hand:

1. **Settings → Apps → Install app** → the **⋮** menu at the top right → **Repositories**.
2. Paste `https://github.com/indoor25/AssisTV` → **Add** → **Close**.
3. Refresh the page (⋮ → "Check for updates"), find **AssisTV** → **Install**.
   Installation takes under a minute: Home Assistant downloads a ready-made image of the add-on from GitHub.

> While the GitHub repository is private, Home Assistant cannot download it — use way B.

### Way B — copy the folder (always works)

1. **Download the project**: on the repository page on GitHub press **Code → Download ZIP** and unpack the
   archive. (Or `git clone https://github.com/indoor25/AssisTV.git`.)
2. Install the **Samba share** app: Settings → Apps → Install app → Samba share → **Install**. On the
   "Configuration" tab set a user name and a password → Save → **Start**.
3. Open the network folder on your computer:
   - Windows: type `\\<HA IP>\addons` into the Explorer address bar;
   - macOS: Finder → Go → Connect to Server → `smb://<HA IP>/addons`.

   Enter the login and password from item 2.
4. Copy the whole **`ha-addon/epg_builder`** folder from the unpacked project there.
   The result must be `addons/epg_builder/config.yaml`.
5. In Home Assistant: **Settings → Apps → Install app** → **⋮** → **Check for updates**. A **Local apps**
   section with **AssisTV** appears at the top → open it → **Install** (a few minutes).

### Way C — one command from your computer (for developers)

If you edit the add-on's code, the `ha-addon/deploy.ps1` script (PowerShell 7) is handier: it copies the
add-on over SSH and installs or updates it. You need the **Terminal & SSH** app with a key:

1. Create a key: `ssh-keygen -t ed25519 -f $env:USERPROFILE\.ssh\ha_pi_ed25519 -N '""'`,
   show it: `Get-Content $env:USERPROFILE\.ssh\ha_pi_ed25519.pub`.
2. Terminal & SSH → "Configuration": put the key line into `authorized_keys`; in the "Network" section set
   port **2222** (without a port the SSH server does not start). Save, restart.
3. From the project folder: `.\ha-addon\deploy.ps1 -PiHost <HA IP>`.

## 1.4. Configuring the add-on: your playlists and TV guide

1. Open **AssisTV** → the **"Configuration"** tab.
2. **playlists** — the list of playlists, each with a name and a link:
   - a regular channel playlist: `name: TV`, `url: http://…/playlist.m3u8`;
   - movies and series come from plugins: once the add-on runs — AssisTV panel → "Plugins"
     ([vod-plugins.md](vod-plugins.md)).

   Delete the `example.com` samples or replace them with yours. (The sample names are in Russian — rename
   them as you like; the name is what you see in the player.)
3. **epg_urls** — TV guide links (one or several; the higher in the list, the more important).
4. Optional — **tmdb_key** and **kinopoisk_key**: free keys that give movies ratings, genres, descriptions
   and viewer reviews. Where to get them — [addon-iptv.md](addon-iptv.md#ratings-and-reviews).
   You can add them later.
5. **language** — leave `auto` (the Home Assistant language) or set `en`.
6. The rest can be left alone (what it is — [addon-iptv.md](addon-iptv.md)).
7. **Save**. On the "Info" tab turn on **"Start on boot"** and **"Show in sidebar"** and press **"Start"**.

The first build takes about half a minute. To see how it went:

- the add-on's **"Log"** tab — the last lines should say how many channels were matched (the log is in
  Russian: `готово: совпало 1925/1977 каналов …` means "done: 1925 of 1977 channels matched");
- or open `http://<HA IP>:8765/status` in a browser.

## 1.5. The add-on page: TVs

An **AssisTV** item has appeared in the Home Assistant sidebar. It has:

- **TVs** — they appear by themselves when the player starts on them for the first time (the next step).
  Give each one a clear **name** ("Living room TV") and choose its **remote** and **media_player** from the
  Samsung Smart TV integration (step 1.2) — without them the TV cannot be turned on.
- **Room.** The TV shows up in Home Assistant as an "IPTV <name>" device. Give it an area (room):
  Settings → Devices & services → Devices → "IPTV …" → ✏️ → "Area". Commands like "put BBC One on in the
  bedroom" work by room.
- **Playlists** — what is loaded and when.
- **"+ Map channel"** — if a channel has no guide or someone else's.
- **Parental control** — PIN and protected groups.

Details — [addon-iptv.md](addon-iptv.md).

## If something is wrong

| What you see | What to do |
|--------------|-----------|
| The add-on is not in "Local apps" | the folder was copied to the wrong place: it must be `addons/epg_builder/config.yaml`, not `addons/ha-addon/epg_builder/…`; ⋮ → "Check for updates" |
| An error during installation | the HA server has no internet (a Node.js image is downloaded); try again |
| `http://<HA IP>:8765/status` does not open | the add-on is not running — the "Log" tab shows why |
| `HTTP 401/403/404` for the playlist in the log | the playlist link is wrong or the token expired — open it in a browser |
| Few channels matched | the TV guide is the wrong one or the channels are named differently — map them by hand on the add-on page |
| `MQTT: нет данных для подключения` ("no connection data") | Mosquitto broker is not installed or not running (step 1.1) |
| The add-on page is read-only | settings are changed only through the **AssisTV** item in the HA sidebar, not at `:8765` |
