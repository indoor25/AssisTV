# AssisTV Installer

🇷🇺 [По-русски](README.ru.md)

Installs AssisTV — or any other `.wgt` — on a Samsung Tizen TV **without Tizen Studio**, certificates
or command lines. One program, one page in your browser.

> **Status: early.** Tested on a real Samsung TV with Tizen 10 (sign-in → certificate → install). Older TVs
> (Tizen 3–6) are not tested yet — see "What is tested".

## What you do

1. Start `AssisTV-Installer.exe`. A page opens in your browser.
2. Pick your TV from the list (it is found automatically).
3. Turn on **Developer Mode** on the TV — the page shows the four steps and the exact address to enter,
   and continues by itself when the TV is ready.
4. Choose what to install: AssisTV (latest release), your own `.wgt` file, or a GitHub repository.
5. TVs from 2023 on (Tizen 7+): sign in to your Samsung account once. The installer creates the
   certificate for your TV by itself.

That is all — the installer signs the package, sends it to the TV and can start the app.

## How it works

| Step | How |
| --- | --- |
| Find the TV | asks every address of your home network for `http://<tv>:8001/api/v2/` |
| Talk to the TV | its own small sdb client (`src/sdb.js`), TCP port 26101 |
| Tizen 7+ | Samsung certificate bound to the TV's DUID (`src/certs.js`); Samsung returns the sign-in to `localhost:4794` |
| Older TVs | a package that is already signed is installed as is; otherwise it is signed with a Tizen certificate made on the spot — no sign-in |
| Install | the package is pushed to `/home/owner/share/tmp/sdk_tools/` and installed with `vd_appinstall` |

The program listens only on `127.0.0.1`. Certificates are kept in `%APPDATA%\AssisTV-Installer`
(`~/.config/assistv-installer` elsewhere). **Keep that folder**: an app can be updated in place only while
it is signed by the same author; with a new author it has to be removed first, and its settings on the TV are lost.

Your Samsung password is typed on Samsung's own page; the installer receives only the access token Samsung
sends back and uses it once, to request the certificate.

## Run from source / build

```
cd installer
npm install
npm start            # run
npm test             # self-test against a simulated TV
.\build.ps1          # → dist\AssisTV-Installer.exe (Node.js 25.5+)
```

`node test/fake-tv.js 6.5` starts a simulated TV on `127.0.0.1` to try the page without a real one.
Enter `ip:port` instead of an address to use a non-standard sdb port.

## What is tested

- sdb client, file transfer, package parsing, refusals of the TV and broken packages — against the
  simulated TV (`npm test`).
- A real TV with Tizen 10 (2026): discovery, Developer Mode check, Samsung sign-in → certificate,
  signing, installation, start.
- Signing with the Tizen certificate (TVs older than Tizen 7): digests and structure equal to a package
  signed by Tizen Studio that a Tizen 3 TV accepts.
- **Not yet**: installation on a real TV older than Tizen 7.

Windows shows a SmartScreen warning for the `.exe` because it is not code-signed
("More info" → "Run anyway").

## Credits

Package signing (`src/vendor/`) and the order of requests to Samsung's certificate service come from
[tizen.js](https://github.com/reisxd/tizen.js) by Reis Can (GPL-3.0), the library behind TizenBrew Installer.
See `src/vendor/NOTICE.md`. License: GPL-3.0, like the rest of AssisTV.
