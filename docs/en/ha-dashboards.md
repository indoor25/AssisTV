# Step 3. The IPTV card on a Home Assistant dashboard

🇷🇺 [Русский](../ha-dashboards.md)

The card shows what is on the TV and lets you switch channels, change the volume, find and start movies and
turn the TV on — from a phone or a computer. The add-on puts the card's files into Home Assistant by itself;
you only need to register it and add it to a dashboard.

## 3.1. Register the card (once)

1. Turn on advanced mode: click your name at the bottom of the sidebar → **Advanced mode** — on.
2. **Settings → Dashboards** → the **⋮** menu at the top right → **Resources** → **Add resource**.
3. URL: `/local/tizen-iptv/loader.js`, type — **JavaScript module** → **Create**.
4. Reload the browser page (Ctrl+F5).

> Add `loader.js`, not `tizen-iptv-card.js`: Home Assistant lets browsers cache `/local` files for a month,
> and the loader always pulls the fresh version of the card.

## 3.2. Add the card to a dashboard

1. Open a dashboard (for example "Overview") → ✏️ **Edit dashboard** (top right).
2. **Add card** → type **AssisTV** in the search → select it.
3. In the editor choose the **TV** from the list (with several TVs, add a card for each) and a title if you
   like → **Save**.

If you prefer YAML:

```yaml
type: custom:tizen-iptv-card
tv_id: qe55qn85c_xxxx      # the TV's identifier — on the AssisTV page in the HA sidebar
title: Bedroom             # optional
```

The card is large (group strips and channel tiles); it looks best on a separate dashboard view of the
**"Panel"** type (one card filling the screen): ✏️ → **+** (new view) → view type — **Panel**.

A ready-made example of such a view is `ha-config/lovelace-tv-view.example.yaml`. Paste it into the
dashboard's YAML (✏️ → ⋮ → "Raw configuration editor") with `tv_id` replaced by yours.

## What the card can do

- what is on: logo, number, programme with progress, state (playing, paused…);
- buttons: previous / next channel, pause, stop, volume, mute, TV power;
- **"Turn on TV"** and **"Open player"** when the TV is off or the player is closed;
- group strips, channel search, channel tiles with the current programme and the archive badge — tap a
  tile and the channel plays on the TV;
- **archive**: "From the start" (the show from its beginning), "Archive" (the list of the channel's shows
  for the archive days — tap one and it plays on the TV), during a recording — ∓1 minute and "Live"; the
  "A 7" badge on a tile opens that channel's archive;
- the playlist buttons switch the card's view: "TV" — channels, "Movies and series" — movies. Nothing
  changes on the TV, watching is not interrupted;
- **movies**: the favourites row, search, a movie card with ratings (`★ 7.8 KP`, `★ 7.3 TMDB`) and genres,
  the favourites heart, "Watch on TV", "From the beginning", episode and audio-version selection. If the TV
  is off or the player is closed, the add-on turns it on and starts it;
- protected groups (parental control) ask for the PIN.

The card speaks the language of the Home Assistant user (Profile → Language).

## If something is wrong

| What you see | What to do |
|--------------|-----------|
| "Custom element doesn't exist: tizen-iptv-card" | the resource is not added or the page was not reloaded (step 3.1) |
| The TV list in the editor is empty | the player has never been started on the TV, or the add-on is not running |
| No channels are shown | the add-on has not built the playlist yet — wait a minute and reload the page |
| Movie search is silent | search works for Home Assistant administrator users only |
| The card behaves the old way after an add-on update | reload the page (Ctrl+F5); in the HA app — pull the screen down |
| "Turn on TV" does not turn it on | remote and media_player are not chosen for the TV on the AssisTV page (the Samsung Smart TV integration) |

## Optional: swiping between views on a phone

The [hass-swipe-navigation](https://github.com/zanna-37/hass-swipe-navigation) plugin (through HACS or by
hand into `/config/www/`). It is configured in the dashboard's YAML (✏️ → ⋮ → "Raw configuration editor"):

```yaml
swipe_nav:
  wrap: false
  enable_mouse_swipe: true
  animate: swipe
  swipe_amount: 20
```

The IPTV card does not get in the way of swiping: the horizontal scrolling of its group strips is kept
separate.
