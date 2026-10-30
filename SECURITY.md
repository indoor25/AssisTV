# Security policy

🇷🇺 Русский — ниже.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private reporting instead:
**Security → Report a vulnerability** on this repository. You will get an answer within a week.

Helpful details: the AssisTV player and add-on versions, what an attacker can do, and steps to reproduce.

## What is in scope

- the Home Assistant add-on: its HTTP API (port 8765 and ingress), TV pairing, the MQTT proxy, the plugin sandbox;
- the TV player: handling of data from the add-on, playlists, EPG and plugins;
- the Home Assistant card.

Out of scope: third-party plugins (report to their authors), your IPTV provider, Home Assistant itself.

## How AssisTV protects you (short)

- A TV gets access only after you confirm its 6-digit code on the add-on page; the add-on stores only a hash of
  the TV's token.
- TVs reach MQTT only through the add-on and only their own topics; the broker password stays in the add-on.
- Settings are changed only through Home Assistant (ingress), never directly on port 8765.
- Plugins run in a separate sandboxed process without file access, environment variables or the Supervisor
  token. Install only plugins you trust: a plugin gets the keys you enter for its source.

---

## Как сообщить об уязвимости

Пожалуйста, **не открывайте публичный issue**. Сообщите через GitHub приватно: вкладка **Security → Report a
vulnerability** в этом репозитории. Ответ — в течение недели.

Укажите версии плеера и аддона, что может сделать злоумышленник и как это повторить.
