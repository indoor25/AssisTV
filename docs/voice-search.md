# Voice search in your language

When you say "switch on BBC One" or type it into the Assist chat, the name arrives with speech-recognition
mistakes: numbers as words, wrong endings, a foreign name written phonetically, no "HD" at the end. The
player does not require the exact name — it compares how the words *sound*. The rules for that were
written for Russian first; this page explains which parts depend on the language and how to add yours.

The interface language (menus, buttons) is a different topic — see [lang/README.md](../lang/README.md).

## Where the search happens

```
Assist (AI) → script iptv_tv_channel → add-on (MQTT iptv/request) → TV: iptv/<tv_id>/set_channel
                                                               → js/channel-match.js  ← channels
Assist (AI) → script iptv_play_movie → add-on: ha-addon/epg_builder/vod.js (parseQuery)   ← movies
```

- **Channels** — `js/channel-match.js` (`ChannelMatch.find`). The same file runs on the TV, in the
  add-on and in the Home Assistant card search, so the result is the same everywhere.
- **Movies and series** — `ha-addon/epg_builder/vod.js`: removes filler words from the phrase, extracts
  the year and the season, asks the provider's portal and ranks the results with `ChannelMatch.score`.

When an AI agent (Gemini, OpenAI…) is used, it often already cleans up the phrase before calling the
script. The rules below matter most for plain Assist sentences and for speech-recognition mistakes.

## How a name is compared

Both the spoken query and every channel name go through the same steps (`analyze()`), then the two
results are compared:

1. **Lower case, punctuation removed.**
2. **Language-specific replacements** — spoken forms of common tokens: "ти ви" → `tv`, "эйч ди" → `hd`,
   "плюс" → `+`, "два на два" → `2x2`.
3. **Numbers as words → digits** (`NUMBERS`): "россия один" → `россия 1`, "двадцать четыре" → `24`.
4. **Stop words are dropped** (`STOP`): "channel", "tv", "switch on", "please"… — words that do not
   distinguish channels.
5. **Endings are cut** (`stem()`): "первого канала" → "перв канал". Only for Cyrillic words now.
6. **Phonetic spelling** (`phoneticWord()`): the word is transliterated to Latin (`CYR` table, including
   ä → a, ß → ss…) and simplified so that different spellings of one sound match: `c` → `k`/`s`,
   `ph` → `f`, `th` → `t`, `o` → `a`, `y` → `i`, double letters → one… So "дискавери" and "Discovery"
   both become `diskaveri`.
7. **Optional words** (`MARKERS`): HD, FHD, 4K, orig… and a country code at the end of the channel name.
   They are not required in the query.
8. **Score** — the best of whole-string similarity and word-by-word coverage in both directions. Numbers
   must match exactly ("football 2" never switches on "football 3"). Below `MIN_SCORE` (0.7) the answer is
   "not found" — better than a random channel.

Steps 2–5 depend on the language. Steps 1, 6–8 are generic and usually work for any language that uses
Latin or Cyrillic letters.

## Add rules for your language

All in `js/channel-match.js`:

| What | Where | Example for German |
|------|-------|--------------------|
| Numbers as words | `NUMBERS` | `eins: 1, zwei: 2, drei: 3, …, zwanzig: 20` |
| Words that mean nothing for the search | `STOP` | `'sender', 'kanal', 'schalte', 'bitte'` |
| Spoken forms of tokens | `analyze()`, the `.replace(...)` chain | `'(^|\\s)plus\\s*'` → `'+'` |
| Word endings | `stem()` | usually not needed for German/English |
| Letters of your alphabet | `CYR` table | Greek, Polish ł → `l`, … |

For movies, add your filler words ("find", "play", "movie", "please"…) to `STOP_WORDS` in
`ha-addon/epg_builder/vod.js`, and your word for "season" to `SEASON_RE`. English, German and Ukrainian
are already there.

**Watch out for side effects.** A rule that helps one channel can break another. Example: with German
number words, the spoken "pro sieben" becomes `pro 7` and no longer matches the channel "ProSieben"
(written as one word). That is why every change must be checked against real channel names.

## Test your changes

1. Put the channel names of **your** playlist into a text file, one per line, in the playlist order
   (the order matters: among almost equal candidates the first one wins). You can take them from the
   `#EXTINF` lines of the M3U, the text after the last comma.
2. Add test cases — `[what was said, expected channel]` — to the `cases` list in
   `tools/channel-match-test.js`, or make a copy of that script that reads your file instead of
   `tools/channel-names.txt`. `null` as the expected channel means "must not find anything";
   `'~A|B'` means "either A or B is fine".
3. Run it:

   ```bash
   node tools/channel-match-test.js
   ```

   All existing cases must stay OK (61/61 for the Russian list). Do not tune `MIN_SCORE` to fix a single
   case — run the whole test.

Quick check of a single phrase without writing a test:

```bash
node -e "const M=require('./js/channel-match.js'); console.log(M.find('bbc one', [{name:'BBC One HD'},{name:'BBC Two'}]))"
```

## Share it

If you added rules for a language, a pull request with the rules and test cases is welcome — keep the
existing test green so other languages do not break.
