# Contributing to AssisTV

🇷🇺 Русский — ниже.

Thank you for helping! Bug reports, translations, plugins and code are all welcome.

## Before you start

- **Bugs and ideas** — open an issue (templates will guide you). For security problems see [SECURITY.md](SECURITY.md).
- **Bigger changes** — open an issue first and describe the idea, so we agree on the approach before you write code.
- **New movie sources** — write a plugin, no changes to the player needed: [docs/en/vod-plugins.md](docs/en/vod-plugins.md).
  Plugins for pirate sites are not accepted here.
- **New language** — see [lang/README.md](lang/README.md).

## Code style

- Plain ES6 without frameworks or build tools; modules are IIFEs (see existing files).
- Keep comments in the language the file already uses.
- Every visible text goes through `I18n.t()` with a key in **all** dictionaries `lang/*.js`.
- Data from outside (EPG, playlists, plugins, HA) goes into the page only via `textContent`, never `innerHTML`.
- A new user-facing feature updates the docs in both languages (`docs/` and `docs/en/`).

## Checks

All of them run without a TV and without a network; GitHub Actions runs them on every pull request:

```
node tools/channel-match-test.js
node tools/guide-test.js
node tools/vod-sources-test.js
node tools/i18n-check.js
```

Building and installing on a TV: [docs/en/install-tv.md](docs/en/install-tv.md) (`tools/build-wgt.ps1`).

## License

By contributing you agree that your work is published under the [GPL-3.0](LICENSE) license.

---

## Как помочь проекту

Сообщения об ошибках, переводы, плагины и код — всё приветствуется.

- **Ошибка или идея** — откройте issue по шаблону. Уязвимости — только по [SECURITY.md](SECURITY.md).
- **Большие изменения** — сначала issue с описанием, чтобы договориться о подходе.
- **Новый источник фильмов** — это плагин, плеер менять не нужно: [docs/vod-plugins.md](docs/vod-plugins.md).
  Плагины для пиратских сайтов здесь не принимаются.
- **Стиль кода** и **проверки** — как выше: ES6 без фреймворков, тексты через `I18n.t()` во всех словарях,
  внешние данные только через `textContent`, новая функция — в документации на обоих языках.
