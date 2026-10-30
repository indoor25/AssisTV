# How to use the player

🇷🇺 [Русский](../usage.md)

Everything you need once the player is installed: the remote, the home screen, the TV guide, the archive,
movies, favourites, the Home Assistant card and voice commands. Installation is in the
[README](../../README.en.md).

Button and menu names below are the English ones the player shows (Settings → Language).

## Starting

The player shows up in the TV's app list as **AssisTV**. On start it turns on the channel you watched
last. For the first few seconds a hint with the buttons is shown at the bottom.

If Home Assistant is unreachable (the server is rebooting, say), the player starts with the saved channels
and shows a warning. As soon as the add-on is back, the player picks it up on its own.

## The remote: basics

Everything is done with the D-pad (◄ ► ▲ ▼), **OK** and **RETURN** (back). Colour buttons are not needed —
new Samsung remotes do not have them.

### While watching a channel

| Button | What it does |
|--------|--------------|
| **OK** or **◄** | channel list of the current group (on the side) |
| **▼** | player bar: icons with a hint above the selected one — from the start, previous channel, pause/play, next channel, audio track, settings (sleep timer, zoom, move channel, channel logo) |
| **▲** | description of the current programme: what is on, until when, genre, text; what is next |
| **RETURN** | home screen with channel tiles |
| **CH+ / CH−** | next / previous channel |
| **Digits** | channel by number (1-2 → channel 12) |
| **Play/Pause** | pause and resume |

### Channel list (on the side)

| Button | What it does |
|--------|--------------|
| **▲ ▼** | choose a channel |
| **OK** | watch it |
| **►** | TV guide of the selected channel (to the right of the list) |
| **◄** | list of groups — pick another group |
| **RETURN** | close |
| **OK, held for a second** | move the channel: ▲▼ move it inside its group, OK — done |

While the guide is open you can scroll channels with ▲▼ — the guide follows the selected channel.

### TV guide of a channel

- The current programme has a progress bar, past ones are dimmed.
- **OK** on a past programme marked **"▶ replay"** — watch it from the archive.
- **OK** on the current or a future one — watch the channel live.

### Home screen (RETURN while watching)

- Channel tiles with logo, number and what is on now. Groups at the bottom, "Settings" at the top.
- **◄ ►** on the group strip — change group; **▲ ▼** — rows of tiles; **OK** — watch.
- **CH+** — jump to "Settings", **CH−** — jump to the group strip.
- The last group is always **"All channels"**.
- **RETURN** on the group strip — playlist chooser (for example "TV" or "Movies and series");
  its last row is "⚙ Settings" (or press **►**); **RETURN** once more — exit.

### Archive (catch-up)

Channels with an archive are marked **"A 3"** / **"A 7"** (how many days are kept).

| Button | What it does |
|--------|--------------|
| **►** | fast forward (the step grows while you hold it) |
| **◄** | rewind once seeking has started; otherwise — the channel list |
| **OK** or **▼** | bar: pause, previous / next show, live TV, TV guide |
| **RETURN** | home screen |

**From the start.** You tuned in to the middle of a film or a match — press **▼** and the first button,
**"From the start"**: the show restarts from its beginning out of the archive (the button exists for
channels with an archive). To get back, choose "Live" in the bar.

**Rewinding live TV.** On a channel with an archive press **▼**, then **▲** — the timeline gets the focus;
**◄** drags the marker back, **OK** plays the recording from there. Channels without an archive cannot be
rewound.

### Sleep timer

**▼** → **"Settings"** (the gear) → **"Sleep timer"**: each press gives 15, 30, 45, 60, 90, 120 minutes and
off again; the button shows how much is left. During the last minute a countdown is shown and the sound
fades out; any remote button cancels. The TV is turned off by Home Assistant, so the connection to it and a
media_player chosen for the TV on the add-on page are required.

### Movies and series

Choose a movie playlist (RETURN on the group strip of the home screen → "Movies and series").
There may be several movie sources (the provider's video portal and plugins) — each one appears as a
separate playlist. Search and rows work inside the open source; favourites are shared by all of them.

- Main screen — the **"Favourites"** row (first), "Continue watching", category rows, search, genre and
  year filter.
- Movie card: description, quality, audio versions (a button for each if there are several), seasons and
  episodes for a series.
- **Rating** on the card: `★ 8.5 KP` (Kinopoisk) and next to it `★ 8.2 TMDB`. This needs keys in the add-on
  options ([addon-iptv.md](addon-iptv.md#ratings-and-reviews)); without them everything works, just with no
  ratings.
- The **"Reviews (N)"** button — viewer reviews from Kinopoisk (in Russian), one per screen: **◄ ►** —
  neighbouring review, **▲ ▼** — scroll the text, **RETURN** — back to the movie.
- The **♡ / ♥** button — add to or remove from favourites.
- While watching: **◄ ►** — seek (YouTube-style: a marker and a time, the jump happens on OK or by itself
  after a second and a half), **OK/▼** — bar (pause, audio, quality, zoom, episodes), **CH+ / CH−** — next /
  previous episode, **RETURN** — back to the movie card.
- The position where you stopped is remembered; for a series — the last episode too.
- **▲** during a movie — description, year, rating.

### Favourites

There is **one favourites list for the whole home**: add something on the bedroom TV and it is there in the
living room and in the Home Assistant card. It is stored in the add-on, so reinstalling the app does not
wipe it.

- Add: the **♡** button on a movie card, the heart in the Home Assistant card, or by voice —
  "add this to favourites" (what is playing now) / "add Interstellar to favourites".
- If several movies fit the title, a numbered list appears on the screen: choose with **▲ ▼** or a digit
  and press **OK** — or answer by voice, "the second one".
- A movie from another source opens by itself: the player switches to the right source.

### Movie suggestions based on your favourites

Tell the assistant: **"find me movies based on my favourites"** (or "suggest something to watch"). The AI
looks at your favourites and comes up with similar titles; the add-on keeps only the ones that can really be
played. A semi-transparent page appears over whatever is on the screen:

```
 Picked for you from your favourites                             3 / 14
 ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐
 │ 1  │ │ 2  │ │ 3  │ │ 4  │ │ 5  │ │ 6  │     ← numbered posters
 └────┘ └────┘ └────┘ └────┘ └────┘ └────┘
 Prisoners  Shutter…  Gone Girl …
 ★ 8.1 2013
 ───────────────────────────────────────────
 Gone Girl (2014)   ★ 8.0 KP  ★ 7.9 TMDB   thriller, drama
 On the day of their fifth anniversary Nick's wife disappears…
```

| Button | What it does |
|--------|--------------|
| **◄ ►** | choose a movie (wraps around) |
| **▲ ▼** | rows — the page scrolls down |
| **OK** or a digit **1–9** | watch |
| **RETURN** | close |

You can also choose by voice: **"play the second one"**. Left alone, the page closes after three minutes.

- **Watched titles are not offered.** A movie or series counts as watched once it has been on the TV for
  10 minutes. Started and stopped right away — does not count.
- **"More options"** — a new selection without what was shown during the last few hours.
- Whatever is already in your favourites is never in the selection.

### Settings

Home screen → **CH+** → "Settings" — or from anywhere: **RETURN** up to the playlist chooser
(from TV or from movies) → the "⚙ Settings" row or **►**. A text field opens with **OK** (the TV keyboard appears) and closes with
OK or RETURN. What is there:

- **Language** — English, Russian, Ukrainian, German or "Same as TV" (the TV menu language; English if there
  is no such translation). After saving, the app restarts in the new language;
- **Add-on address** — `http://<Home Assistant IP>:8765`;
- **MQTT** — usually empty (the add-on issues the login); fill it in only if the TV does not connect to HA;
- **On-screen clock** — right, left or off;
- **Time offset** — if the guide is shifted relative to your time;
- **This TV** — its identifier (`tv_id`, needed for the HA card) and the **player version** (handy after an
  update: you see which version is really installed).

### Parental control

If a PIN is set in the add-on, "adult" groups are locked (or not shown at all — this is set per TV). To open
a group, select it and enter the PIN with the remote digits. Access stays open until the TV is turned off.
Protected channels are never turned on by voice or chat.

## The card in Home Assistant

On a Home Assistant dashboard (phone or computer):

- what is on: logo, number, programme with progress, state;
- buttons: previous / next channel, pause, stop, volume, mute;
- **Turn on TV** and **Open player** when it is closed;
- group strips and channel tiles with what is on, channel search — tap a tile, the channel plays;
- **archive**: under the control buttons — "From the start" and "Archive" (the list of the channel's shows
  for the archive days; tap one and it plays on the TV); during a recording — ∓1 minute and "Live". The
  archive of any other channel opens by tapping its "A 7" badge on the tile;
- the **"Movies and series"** tab: the favourites row, search, a movie card with rating and the favourites
  heart, "Watch on TV", "From the beginning", episode and audio-version selection.

The card speaks the language of the Home Assistant user (Profile → Language).

How to add the card — [ha-dashboards.md](ha-dashboards.md).

## Voice and chat (Assist)

If a Home Assistant voice assistant with an AI is set up (Google Gemini, OpenAI, DeepSeek and others) —
see [assist.md](assist.md) — you can type or speak to it in plain words. There are no exact phrases to
memorise: the AI gets the meaning.

**Channels and control**

| Say or type | What happens |
|-------------|--------------|
| "Put BBC One on in the bedroom" | turns the bedroom TV on (if it is off), starts the player and the channel |
| "Switch to CNN" | on the TV where the player is running; if two are running, it asks which one |
| "What's on right now?" | names the channel, the programme and when it ends |
| "Pause" / "Resume" | pause / resume |
| "Turn it down by 5", "Volume 20", "Mute" | volume |
| "Next channel" | next channel (the next episode during a series) |
| "Play Channel 4 from the start", "Play it from the start" | the running show from its beginning (from the channel archive) |
| "Go back to live" | from the archive back to live TV |
| "Rewind one minute" | seeks in a movie or an archive recording |
| "Turn the TV off in 30 minutes", "Cancel the timer" | sleep timer (works even when the player is closed) |
| "Turn off the living room TV" | turns the TV off |

**TV guide**

| Say or type | What happens |
|-------------|--------------|
| "What's next on Channel 4?", "What time is the news on BBC One?" | the channel's guide for 24 hours |
| "When is the football today?", "Is Home Alone on anywhere?" | finds programmes across all channels for a week ahead |
| "Remind me when the football starts" | 5 minutes before the start — a notice on the TV (OK turns the channel on) and a spoken reminder |
| "What reminders do I have?", "Cancel the football reminder" | lists and removes reminders |

**Movies and series**

| Say or type | What happens |
|-------------|--------------|
| "Find the movie The Matrix" | names what was found (three at most) and asks which one to play |
| "Play Game of Thrones, season 3" | finds and plays it from the episode and position where you stopped |
| "Play The Matrix from the beginning" | the movie from the very start |
| "Play Interstellar in 4K", "…in the best quality" | plays it in that quality; if there is none — in the nearest one, and says which |
| "Play the film where a ferry blows up and an agent goes back in time" | the AI works out the title ("Déjà Vu") and plays it |
| "What's the rating of Dune?", "What is Inception about?", "Is it worth watching?" | Kinopoisk and TMDB scores, genre, a short summary; says whether you have the movie |
| "Add this to favourites" | the movie or series that is playing |
| "Add Interstellar to favourites" | finds and adds it; if several fit, asks which |
| "What's in my favourites?" | names a few and says how many there are |
| "Find me movies based on my favourites" | a selection page on the TV screen (see above) |
| "Play the second one" | movie no. 2 from the selection on the screen |
| "More options", "Show me others" | a new selection without repeats |

A movie is searched for in all sources one after another, in the order they are listed in the add-on options.

A sample conversation:

> — Find me movies based on my favourites.
> — The selection is on the living room TV: "Prisoners", "Shutter Island", "Gone Girl" and five more. Which one to play?
> — What's the third one about?
> — "Gone Girl", 2014, Kinopoisk 8.0. A wife disappears on her wedding anniversary and suspicion falls on the husband.
> — Play it.

Channel names can be said any way you like — the player corrects speech-recognition mistakes. The correction
rules were written for Russian first; how to add your own for another language —
[voice-search.md](../voice-search.md).

The add-on's answers (what was turned on, what is playing) come in the add-on's language — the `language`
option, by default the Home Assistant language ([addon-iptv.md](addon-iptv.md)).

You can leave the room out if the player is running on one TV only. The room is the area the TV is assigned
to in Home Assistant, or its name on the add-on page.
