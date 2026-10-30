# Step 4. Voice and chat: controlling the player through Assist

🇷🇺 [Русский](../assist.md)

**Assist** is the Home Assistant voice assistant. With an AI connected to it (Google Gemini, OpenAI,
Anthropic Claude, DeepSeek, a local Ollama and others) you can type or speak in plain words:
"put BBC One on in the bedroom", "what's on?", "play Interstellar in 4K", "what's the rating of Dune?",
"find me movies based on my favourites", "turn the TV off in half an hour".
A microphone is optional — you can type in the Assist chat in the app or in the browser.

For the AI to control the player, a few **scripts** are added to Home Assistant — they are its "buttons".
Every script has a description from which the AI works out when and how to call it.

Before this step the add-on ([step 1](install-ha-addons.md)) and the player on the TV
([step 2](install-tv.md)) must be working. The scripts in the repository expect a recent add-on —
**2.17.1** or newer (Settings → Apps → AssisTV — the version is at the top) and player **1.1.0**
or newer (on the TV: Settings → "This TV"). With an older player everything works except the suggestion
page on the screen.

Menu names are given for Home Assistant 2026.9; "Apps" were called "Add-ons" in older versions.

## 4.1. An AI assistant in Home Assistant (if you have none yet)

Using Google Gemini as the example (Google has a free tier):

1. Get an API key: [aistudio.google.com](https://aistudio.google.com/apikey) → **Create API key**.
2. **Settings → Devices & services → Add integration** → **Google Generative AI** → paste the key.
3. Open the integration → press ⚙️ (configure) on the conversation agent → in the
   **"Control Home Assistant"** field choose **Assist** → **Submit**.
   **Without this the AI only chats and cannot turn anything on.**
4. **Settings → Voice assistants** → open your assistant (or "Add assistant") → **Conversation agent** —
   Google Generative AI, pick your language → **Update**. Make this assistant the preferred one
   (⋮ → "Set as preferred").

With OpenAI, Anthropic and the rest it is the same; only the integration in step 2 differs.

## 4.2. Add the scripts

The scripts are in the project file
[`ha-config/iptv-assist-scripts.yaml`](../../ha-config/iptv-assist-scripts.yaml).

1. Install the **File editor** app: Settings → Apps → Install app → File editor → **Install** → **Start**,
   turn on "Show in sidebar".
2. Open **File editor** in the sidebar → the folder icon at the top left → the file **`scripts.yaml`**.
3. If the file is empty (or holds only `{}` / `[]`) — paste **the whole** content of
   `iptv-assist-scripts.yaml` in place of the old text. If you already have scripts there — paste the
   content **at the end** of the file, on a new line.
4. Save (the floppy icon at the top).
5. **Developer tools → YAML** → under "YAML configuration reloading" press **Scripts**.
6. Check: **Settings → Automations & scenes → Scripts** — the "IPTV: …" scripts are there (13 of them).

> **Updating from an older version?** Remove the previous IPTV scripts from `scripts.yaml` (everything from
> `iptv_zapros:` to the end of the IPTV block), paste the new ones as a whole, reload the scripts and
> **expose the new ones** (step 4.3). A forgotten step 4.3 is the most common reason for "I can't do that".

The script names and descriptions are in English: the AI understands them whatever language you speak, and
answers in yours. The ready-made phrases in the answers (`message`) are written by the add-on in its own
language — the add-on option `language`, by default the Home Assistant language.

| Script | What it does |
|--------|--------------|
| IPTV: switch TV channel | turn a channel on by name, on the right TV; "from the start" — the show from the archive |
| IPTV: play a movie or series | find a movie in all sources and play it; quality ("in 4K"); a number from the selection on the screen |
| IPTV: find a movie | only find, play nothing |
| IPTV: movie rating and description | Kinopoisk and TMDB rating, genres, description; whether you have the movie |
| IPTV: add a movie to favourites | add to favourites: what is playing, or by title |
| IPTV: list favourite movies | what is in the favourites (and what was already watched) |
| IPTV: suggest movies on the TV | show a selection on the TV as a page of posters; "more options" |
| IPTV: player control | pause, resume, stop, next/previous channel, volume, mute, open the player, turn the TV off, show from the start, live TV, seek, sleep timer |
| IPTV: what is on now | channel, programme, until when, volume |
| IPTV: TV guide | a channel's guide for 24 hours: "what's next", "what time is the news on …" |
| IPTV: find a programme in the TV guide | search for a programme across all channels for several days: "when is the football today?" |
| IPTV: what to watch tonight | evening picks from the channels your household actually watches: "what is on tonight?" |
| IPTV: move playback to another TV | continue on another TV from the same spot: "move it to the bedroom" |
| IPTV: programme reminder | remind about a programme 5 minutes before it starts, list and remove reminders |
| IPTV: add-on request (internal) | the others work through it; do not expose it to the AI |

## 4.3. Give the AI access to the scripts

1. **Settings → Voice assistants** → the **"Expose"** tab → the **"+ Expose entities"** button.
2. Tick every **IPTV: …** script except "add-on request (internal)" → **Expose**.

## 4.4. Try it

Open Assist: the 💬 icon at the top right of any Home Assistant dashboard (in the phone app too). Type:

- "what's on TV right now?"
- "put BBC One on in the bedroom"
- "turn it down by 3"
- "find the movie The Matrix", then "play the first one"
- "what's the rating of Interstellar?"
- "add Interstellar to favourites"
- "find me movies based on my favourites" — a page with posters should appear on the TV; then
  "play the second one" or "more options"

More examples — in [usage.md](usage.md#voice-and-chat-assist).

### How the suggestions based on favourites work

Here the AI and the add-on share the job:

1. The AI calls "list favourite movies" and gets your favourites, the list of watched titles and what it
   has offered recently.
2. The AI **itself**, from what it knows about cinema, comes up with 12–15 similar titles with years.
3. The "suggest movies on the TV" script hands them to the add-on. The add-on checks each one: is it
   available in the movie sources, is it already in the favourites, has it been watched. Whatever passes
   goes to the TV as a page with posters, ratings and descriptions.
4. You choose with the remote or say a number — the AI calls "play a movie or series" with that number.

So the quality of the selection depends on the model: the better it knows films, the closer the match.
The add-on guarantees one thing only — everything on the screen can really be played.

A movie counts as watched once it has been on the TV for 10 minutes; such titles are not offered again.
On "more options" whatever was shown during the last 6 hours is not repeated either.

### Keeping the TV from drowning out your voice

If your smart speaker sits near the TV, the microphone hears the TV too.
[`ha-config/iptv-voice-duck.yaml`](../../ha-config/iptv-voice-duck.yaml) is a ready-made automation: while
the speaker is listening to a command the TV is muted, then the sound comes back. (The comments in that file
are in Russian; replace the two identifiers marked in capitals with your satellite entity and your `tv_id`.)

### A spoken programme reminder

5 minutes before the start the add-on shows a notice on the TVs where the player is running (**OK** on the
remote turns the channel on) and publishes the `iptv/reminder` event to MQTT:
`{title, channel, start, start_time, minutes, message, tvs}`. To have the reminder spoken as well, add an
automation with an MQTT trigger on this topic and an action that says `message` your way (`tts.speak`,
`assist_satellite.announce`, a phone notification):

```yaml
- alias: "IPTV: programme reminder aloud"
  triggers:
    - trigger: mqtt
      topic: iptv/reminder
  actions:
    - action: assist_satellite.announce
      target:
        entity_id: assist_satellite.living_room
      data:
        message: "{{ trigger.payload_json.message }}"
```

You can put your own text on the TV screen from any automation as well: publish
`{"text": "…", "channel": "…", "seconds": 30}` to `iptv/<tv_id>/notify` (channel and seconds are optional).

```yaml
# example: the washing machine has finished — say so on the living room TV
actions:
  - action: mqtt.publish
    data:
      topic: iptv/qe55qn85c_xxxx/notify
      payload: '{"text": "The laundry is done", "seconds": 20}'
```

How the AI knows which TV is meant: by the TV's name on the AssisTV page or by the room (area) of its
"IPTV …" device in Home Assistant. If no room is named and the player is running on one TV — that one. If it
is running on several — the AI asks. If it is running on none — it asks which one to turn on.

## If something is wrong

| What you see | What to do |
|--------------|-----------|
| The AI says "I can't control devices" or just chats | step 4.1, item 3: "Control Home Assistant" — Assist; and step 4.3 |
| The AI does not see the scripts | step 4.3 — the scripts are not exposed to Assist |
| "I can't show a selection", "I can't add to favourites" | new scripts were added but not exposed (step 4.3) |
| The selection is spoken but there is no page on the TV | the player is older than 1.1.0 — update it ([install-tv.md](install-tv.md)); or it is unclear which TV — name the room |
| Few movies in the selection | the sources did not have everything the AI thought of; say "more options" |
| No ratings or descriptions | `tmdb_key` / `kinopoisk_key` are not set in the add-on options |
| The AI reads out long lists | that is its manner; add "answer briefly, in one or two sentences" to the assistant's instructions |
| The scripts are not in the list | an error in `scripts.yaml` — Developer tools → YAML → "Check configuration" shows the line |
| "The IPTV add-on did not answer" | the add-on is not running or is too old; there is no "IPTV add-on" device with the `sensor.iptv_otvet` sensor — the add-on is not connected to MQTT |
| "I don't know the TV …" | give the TV a name on the AssisTV page or an area to the "IPTV …" device |
| The channel is "protected by parental control" | by design: protected channels are never turned on by voice or chat |
| Turning on a TV that is off does not work | remote and media_player are not chosen for the TV on the AssisTV page |

## How it works (for the curious)

```
Assist (AI) → script.iptv_tv_channel / iptv_play_movie / iptv_suggest_movies / …
            → script.iptv_zapros → MQTT iptv/request → IPTV add-on → TV
                                   ← sensor.iptv_otvet ← MQTT iptv/request/result
```

The internal script publishes a request with a unique `request_id` and waits until that `request_id` shows
up in the attributes of the `sensor.iptv_otvet` sensor (created by the add-on; the attributes are the whole
answer). The script's response is a dictionary with a `message` field — that is what the AI retells. The
add-on chooses the TV itself, turns it on if needed and starts the player. The request format is in
[addon-iptv.md](addon-iptv.md#control-from-automations-and-by-voice).

(`zapros` and `otvet` are Russian for "request" and "answer" — the identifiers were kept so that existing
installations do not break.)
