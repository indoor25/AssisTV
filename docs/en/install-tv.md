# Step 2. The app on a Samsung TV

🇷🇺 [Русский](../install-tv.md)

Samsung does not let you simply install apps from outside its store. So the app is installed the way
developers do it: the TV is switched to developer mode, the app is signed with your personal Samsung
certificate (free) and sent to the TV from a computer. You do it once; after that the player lives on the TV
like any other app.

Before this step the add-on must be running — [install-ha-addons.md](install-ha-addons.md).

Allow about an hour (mostly for downloading and installing Tizen Studio).

## 2.1. Download the project

On the repository page on GitHub: **Code → Download ZIP** and unpack it, for example to `C:\AssisTV`.
(Or `git clone https://github.com/indoor25/AssisTV.git C:\AssisTV`.)

> Use a path without spaces or non-Latin letters — Tizen tools sometimes break on them.

## 2.2. Install Tizen Studio

1. Download **Tizen Studio** (the "with IDE" installer) from
   [developer.tizen.org](https://developer.tizen.org/development/tizen-studio/download) and install it
   (by default to `C:\tizen-studio`).
2. At the end of the installation **Package Manager** opens (or start it from the Start menu):
   - the **Main SDK** tab — install **Tizen SDK tools**;
   - the **Extension SDK** tab — install **Samsung Certificate Extension** and **TV Extensions**
     (or "Samsung TV Extension"; any version, preferably the latest).

## 2.3. Turn on developer mode on the TV

1. Find out the IP address of your **computer**: on Windows — `ipconfig` in a command prompt, the
   "IPv4 Address" line.
2. On the TV open **Apps** and type **1 2 3 4 5** on the remote (on a remote without digits the "123" or
   "⋯" button shows digits on the screen).
3. In the window that appears: **Developer mode — On**, **Host PC IP** — the computer's IP → **OK**.
4. **Restart the TV**: turn it off and on (on some models — hold the power button until the Samsung logo
   appears). **Developer Mode** is now written at the top of the "Apps" screen.

## 2.4. Connect the TV to Tizen Studio

1. Start Tizen Studio → the **Tools → Device Manager** menu.
2. **Remote Device Manager** → **+** → Name — anything, IP — the TV's address, Port — `26101` → **Add**.
3. Switch **Connection** to **On**. The TV appears in the device list.

## 2.5. Create a certificate

1. Tizen Studio → **Tools → Certificate Manager** → **+**.
2. Type — **Samsung**, device — **TV**.
3. **Certificate profile name** — make one up, for example `mytv`. Remember this name.
4. **Create a new author certificate**: a name, a password (remember it) → sign in to your **Samsung
   account** (you can create one right there if you have none).
5. **Distributor certificate**: Privilege level — **Public**. The **DUID** list already has the DUID of the
   connected TV (if not — add it by hand: it is shown in Device Manager). If you have several TVs, connect
   them all (step 2.4) and add all the DUIDs here.
6. **Finish**.

> A new TV later on — its DUID must be added to the certificate (Certificate Manager → the profile →
> recreate the distributor certificate with all DUIDs), otherwise installation on it fails.

## 2.6. Build and install the app

Open **PowerShell** (Windows) and run, with your own values (`C:\AssisTV` — the project folder,
`192.168.1.20` — the TV's IP, `mytv` — the certificate profile name):

```powershell
cd C:\AssisTV
.\tools\build-wgt.ps1 -Cert mytv -Install 192.168.1.20:26101
```

The script builds the package from a clean copy (only the player's files go into it), connects to the TV
(`sdb connect`), installs the package and disconnects. Without `-Install` it only builds
`.buildResult\AssisTV.wgt`. It looks for Tizen Studio in `C:\tizen-studio`.

- The build may ask for the certificate password — the one from step 2.5.
- Cannot connect — check that developer mode on the TV has this computer's IP.
- A successful installation ends with `Installed the package: Id(TzIptvPl01)` or similar.

**A 2017–2020 TV** (Tizen 3–5.5; the model shows the year: …M… — 2017, …N… — 2018, …R… — 2019,
…T… — 2020): add **`-Legacy`** — the script converts the code for the TV's older browser and builds
`.buildResultAssisTV-legacy.wgt`. It needs [Node.js](https://nodejs.org) (run `npm install` once in
`toolslegacy`):

```powershell
cd C:AssisTV	oolslegacy; npm install; cd C:AssisTV
.	oolsuild-wgt.ps1 -Cert mytv -Legacy -Install 192.168.1.20:26101
```

The regular build simply does not install on such a TV (an error about the platform version).

On macOS/Linux the script runs in PowerShell 7 (`pwsh`) when Tizen Studio is in PATH
(`~/tizen-studio/tools/ide/bin` and `~/tizen-studio/tools`).

## 2.7. First start

1. On the TV open **Apps** — **AssisTV** is there. Start it.
2. The player does not know the add-on address yet, so **Settings** open right away on the
   **"Add-on address"** field, with a hint at the top.
3. Press **OK** — the keyboard appears. Enter `<HA IP>:8765` (for example `192.168.1.10:8765`) and close
   the keyboard.
4. **"Save"** at the bottom → **OK**.
5. **Pairing.** The TV shows a **6-digit code**. In Home Assistant open the **AssisTV** item in the sidebar →
   the **"Pair a TV"** section: there is a request with the same code — press **"Pair"**. A couple of
   seconds later the TV loads the playlist by itself and starts the first channel.
   Pairing is needed once: this way another device on the network does not get your playlists and controls.
6. RETURN — the home screen; choose a channel.

The player takes its language from the TV menu (English if there is no translation). To change it:
Settings → **Language**.

On the same AssisTV page give the TV a name, a remote, a media_player and a room
(see [install-ha-addons.md](install-ha-addons.md), step 1.5).

Leave the **MQTT** field in the settings empty: the TV gets Home Assistant's commands through the add-on,
with its own token. Your own broker connection (host, port `1884`, login) is only for those who want to
keep the add-on out of this chain.

How to use it — [usage.md](usage.md).

## Updating the app

Download the new version of the project into the same folder and repeat the command from step 2.6. Settings, channel order, logos and movie positions are
kept.

- Installing closes a running player — update when nobody is watching.
- To check that the update landed: on the TV, Settings → "This TV" → **"Player version"**.
- New movie sources do **not** need a reinstall: they are plugins, and the TV downloads them from the
  add-on by itself ([vod-plugins.md](vod-plugins.md)).

## If something is wrong

| What you see | What to do |
|--------------|-----------|
| `sdb connect` — `failed to connect` | developer mode is off or has the wrong computer IP; the TV was not restarted after turning the mode on |
| `install` — a certificate / `author signature` error | the TV's DUID is not in the certificate (step 2.5) or the package was signed with another profile |
| `install` — `Failed to install Tizen application` with no details | the project path has spaces or non-Latin letters — move it to `C:\AssisTV` |
| A black screen with red text | that is a start-up error and the text says what; a frequent cause is a wrong add-on address |
| Channels are there but the card and voice do not see the TV | check Mosquitto's port 1884 (step 1.1) and the MQTT field in the settings (above) |
| A pairing code on screen, but no request in HA | reload the AssisTV page; the add-on address in Settings must point to this Home Assistant |
| The playlist window says "failed to load — check the link in the add-on" | the playlist link in the add-on options is wrong or expired — details in `/status` (`lastError`) |
| "Home Assistant add-on is unavailable" | Home Assistant is off or the add-on address is wrong; the player works with the saved channels and retries every minute |

`sdb shell` and `sdb dlog` usually do not work on Samsung TVs — that is a firmware restriction, not a
set-up mistake.

## For developers

- The app is a plain Tizen Web App: HTML/CSS/JS with no bundlers, video through `webapis.avplay`.
- In `config.xml` the `package` is exactly 10 characters (`TzIptvPl01`) and `<name>` has no spaces
  (`AssisTV`); breaking either rule breaks installation with no clear error.
- Your own defaults (several TVs — no typing on each): a file with
  `window.LOCAL_DEFAULTS = { addonUrl: 'http://<HA IP>:8765' }` (example — `js/local-defaults.js`) and
  the build `.\tools\build-wgt.ps1 -Cert mytv -Defaults <file>`. Then items 2–5 of "First start" are not needed.
- Bump `version` in `config.xml` with every build you install — it is the only way to tell from the network
  which player a TV has.
- `tizen run -p TzIptvPl01.IPTVTizen -s <TV IP>:26101` starts the app from the computer.
