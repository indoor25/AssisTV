# Interface languages

The player, the Home Assistant card, the add-on page and the add-on answers for voice/chat all take
their texts from the files in this folder:

| File | Language |
|------|----------|
| `en.js` | English — also the fallback for any missing phrase |
| `ru.js` | Russian |
| `uk.js` | Ukrainian |
| `de.js` | German |

Where the language is chosen:

- **TV app** — Settings → Language. "Same as TV" uses the TV menu language; if there is no translation
  for it, English is used. Changing the language restarts the app.
- **Home Assistant card** — the language of the Home Assistant user (Profile → Language).
- **Add-on page and answers for Assist** — the add-on option `language` (`auto` = the Home Assistant
  system language).

Channel names, programmes and movie titles are not translated — they come from your provider and the TV
guide as they are.

## Add a language

1. Copy `en.js` to `<code>.js`, where `<code>` is the two-letter ISO 639-1 code (`fr`, `pl`, `es`…).
2. In the new file change `I18n.add('en', dict)` at the bottom to your code and translate the values
   (the part after the colon). Do not change the keys (the part before the colon).
3. Keep the placeholders exactly as they are: `{name}`, `{error}`, `{n}`… The HTML tags in the key hints
   (`<b>OK</b>`) stay too.
4. Plural forms: `{n|channel|channels}` means "the word for 1 | the word for everything else". Languages
   with three forms (Russian, Ukrainian, Polish, Czech…) write three: `{n|канал|канала|каналов}` —
   for 1, for 2–4, for 5 and more. The rule itself lives in `js/i18n.js` (`pluralIndex`); if your language
   needs a different one, add it there.
5. Register the language name in `js/i18n.js`: add it to `NAMES` (`fr: 'Français'`) and `LOCALES`
   (`fr: 'fr-FR'`, used to format times).
6. Load the file:
   - TV app: add `<script src="lang/<code>.js"></script>` to `index.html` next to the others;
   - add-on and card: add the code to the list in `ha-addon/epg_builder/server.js`
     (`['ru', 'en', 'uk', 'de'].forEach(…)`) and in `ha-addon/epg_builder/card-data.js` (`lang/<code>.js`);
     `deploy.ps1` copies all `lang/*.js` by itself;
   - add-on option: add the code to `language: list(auto|en|ru|uk|de)` in
     `ha-addon/epg_builder/config.yaml`, and optionally add `ha-addon/epg_builder/translations/<code>.yaml`
     (names of the add-on options in the Home Assistant UI).
7. Check it:

   ```bash
   node tools/i18n-check.js
   ```

   It lists missing and extra phrases for every language and placeholders that differ from English.
   A missing phrase is not an error on screen — English is shown instead.

## For developers

- In code, texts go only through `I18n.t('key', params)` (`js/i18n.js`). Never write user-visible text
  directly into the code — add a key to **all** dictionaries (at least `en.js` and `ru.js`).
- Keys are grouped by where they are shown: `common.*`, TV screens (`home.*`, `epg.*`, `bar.*`,
  `vod.*`, `settings.*`…), `card.*` — the Home Assistant card, `page.*` and `map.*` — the add-on page,
  `assist.*` — add-on answers for voice and chat.
- The group names "Все каналы" and "Без группы" are internal identifiers (the add-on and the card know
  them); on screen they are shown via `ChannelStore.groupLabel()` / `groupLabel()` in the card.
- The add-on log stays in Russian.
- Voice search of channels and movies is a separate thing — see
  [docs/voice-search.md](../docs/voice-search.md).
