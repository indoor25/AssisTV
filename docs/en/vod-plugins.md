# Plugins: movie sources

🇷🇺 [Русский](../vod-plugins.md)

The player takes channels from an M3U playlist. Movies and series come from a **source**. A source is a
**plugin**: one JavaScript file that knows how to talk to a particular service (your provider's video
portal, a home media library and so on).

A plugin is an interpreter. The service answers in its own way, the player understands a single format, and
the plugin translates one into the other. Everything you see on the screen — rows, search, the movie card,
favourites, ratings — is drawn by the player; the plugin never touches the screens, it only hands over data.

There can be any number of sources, including none: then the player simply has no movie section and the
channels work as usual.

---

# Part 1. Installing a ready-made plugin

Everything happens on the add-on page in Home Assistant: sidebar → **AssisTV** → section **"Plugins"**.
No Samba and no restarts.

> 🎬 **No source of your own? Start with the ready-made example.** The
> [Internet Archive](../../plugins/archive-org/README.en.md) plugin shows public-domain film classics:
> noir, 1950s sci-fi, silent films, westerns. No key needed — just the address `https://archive.org`
> in its settings.

## Step 1. Install

Two ways:

- **From a link.** Paste the plugin file address (`https://…/plugin.js`) and press "Install from link".
- **As a file.** Press "upload a file from your computer" and pick the `.js`. This is how plugins from
  private repositories are installed — Home Assistant cannot download those by link.

The add-on checks the file. If it is not a plugin or has an error, you will see what is wrong. A new plugin
appears in the list **disabled**.

> ⚠️ **A plugin is a program.** It runs in the add-on's sandbox, with no access to files or to Home
> Assistant itself. It does get your keys and passwords for the source, so install only plugins you trust.

## Step 2. Configure and enable

In the plugin's card:

1. **Name in the menu** — you will see it on the TV (e.g. "My library").
2. **Settings fields** — service address, key, login. The plugin itself says which fields it needs.
   Passwords are not shown on the page; an empty field keeps the previous value.
3. Tick **Enabled**.
4. **Work on the TV without the add-on** — optional, see below.
5. **Save.**

TVs pick up the source by themselves, no need to restart the app.

## Working on the TV without the add-on

Normally a plugin runs **only in the add-on**: the TV asks the add-on for lists and cards, and the source
keys never reach the TV.

The downside: when Home Assistant is down, movies do not open. The "Work on the TV without the add-on" tick
fixes that. The add-on gives the TVs a copy of the plugin together with its settings, and without the
add-on the TV talks to the source by itself. The keys are then stored on the TVs, so tick it only for
plugins you trust.

## Update and remove

- **Update** — install the new version the same way; settings are kept.
- **Turn off for a while** — untick "Enabled".
- **Remove** — the "Remove plugin" button. Favourites and watch history of this source stay and come back
  if you install the plugin again.

## If something went wrong

| What you see | What it means |
|---|---|
| The source is not in the player | The plugin is not enabled, or a required field (*) is empty |
| The plugin shows "error" | An error in the plugin file itself — the text is on the page and in the add-on log |
| "Not a plugin" when installing | The file does not call `VodSources.register(…)` |
| Movies do not open while HA is off | "Work on the TV without the add-on" is not ticked |

> Before the "Plugins" section, plugins were put into `/config/tizen-iptv/plugins/` and the address was
> written as a `type::[key:…]url` line in `playlists`. That still works: files from the old folder show
> up in the section, and the line moves into the plugin's settings on first start. You can delete it then.

---

# Part 2. Writing your own plugin

## What is required of a plugin

- a single file, no build step and no libraries;
- **no windows and no on-screen text** — a plugin only returns data, the player draws it. The file runs in
  the add-on's sandbox (Node.js) and, with "without the add-on" ticked, in the TV's browser as well, so
  there must be no `document`, `window`, `require` and the like in it;
- network access — through `fetch` only; a plugin has no files and no environment variables;
- if the service needs a login, the plugin logs in by itself and keeps its token in memory; the player
  knows nothing about passwords and does not ask for them.

## Skeleton

Every plugin is built the same way:

```js
VodSources.register('example', {          // 'example' — the source name (Latin letters, digits, - and _)
    meta: {                               // manifest: shown by the "Plugins" section
        name: 'My library', version: '1.0.0', author: 'Me', homepage: 'https://…', api: 1,
        settings: [                       // settings form fields; url is the service address, the rest go to params
            { key: 'url', label: 'Service address', required: true },
            { key: 'key', label: 'Key', type: 'password' }
        ]
    },
    create(url, params) {                 // url and params come from the settings form
        const key = params.key || '';     // params is { key: 'MY_KEY' }

        return {
            async root() { … },
            async page(request) { … },
            async details(item) { … },
            searchRequest(root, text) { … },
            filterRequest(requests) { … },
            itemById(localId) { … }
        };
    }
});
```

Without `meta` there is still a form, with "URL" and "Key" fields. `create` is called once, when the source is opened. Whatever you set up in it (a key, a token, a cache)
lives on inside — it is an ordinary closure.

## What is called and when

| Method | When it is called | What it must return |
|---|---|---|
| `root()` | when the source is opened | categories, search, filters |
| `page(request)` | when a category is opened, on search, on scrolling further | a page of items |
| `details(item)` | when a movie card is opened | the movie, episodes, audio versions |
| `searchRequest(root, text)` | when text was typed into the search | a request for `page` |
| `filterRequest(requests)` | when a genre/year was chosen | a request for `page` |
| `itemById(localId)` | favourites, a command from Home Assistant | an item for `details` |

## `request` — what it is

The player does not know how your service works and does not want to. So it works like this: with every
category and every "next page" you give it some `request` — any object that suits you. The player **does not
look inside**; it simply hands it back to you in `page(request)`.

Put an address there, a page number, or anything else:

```js
{ path: '/movies', page: 2 }        // this is fine
{ cmd: 'flicks', fid: 17 }          // so is this
'movies?page=2'                     // a string works too
```

## `root()` — the main screen

Called once when the source is opened.

**Receives:** nothing.

**Returns:**

```js
{
    categories: [                                   // rows on the main screen, top to bottom
        { title: 'Movies', request: { path: '/movies' } },
        { title: 'Series', request: { path: '/series' } }
    ],
    search: { request: { query: '{USERINPUT}' } },  // may be null — see below about search
    filters: [                                      // may be [] — then there are no filter buttons
        {
            title: 'Genre',
            items: [
                { title: 'Comedy', request: { genre: 5 } },
                { title: 'Drama',  request: { genre: 8 } }
            ]
        }
    ]
}
```

On the screen this becomes: a "Search" button, "Genre: all" and "Year: all" buttons, and category rows.

`search` is there for you — the player does not look into it and simply gives it back to you in
`searchRequest`. The "Search" button is always on the screen, even if you wrote `search: null`; if your
service cannot search, return from `searchRequest` a request for which `page` gives an empty list — the
viewer sees "Nothing found".

## `page(request)` — a list

Called when a category is opened, on search, when a filter is applied and when the list is scrolled to its
end.

**Receives:** the very `request` you gave in `root()`, in `searchRequest` or in the previous answer as
`nextRequest`.

**Returns:**

```js
{
    items: [ …items… ],                 // see below
    count: 240,                         // total in the category, for the "Movies · 240" caption; may be null
    nextRequest: { path: '/movies', page: 3 }   // the next page; null — the list is over
}
```

Loading more works by itself: as soon as the viewer scrolls almost to the end, the player calls `page` with
your `nextRequest`. There is nothing special to do — just keep returning it while there is something to
return.

### A list item

```js
{
    type: 'stream',            // 'stream' — a movie or an episode, 'multistream' — a series
    fid: '12345',              // your identifier: a number or a string, as long as it does not change
    title: 'Interstellar',     // what is written under the tile
    year: 2014,                // shown under the title; may be null
    poster: 'http://…/400.jpg',// the tile picture (about 400×600); may be null
    request: { id: 12345 }     // what to call details with for this item
}
```

Optional fields, if you have them:

| Field | What it gives |
|---|---|
| `posterHi` | a larger picture (500×750) for the movie card |
| `duration` | duration **in minutes** |
| `description` | description |
| `agelimit` | age rating, a number: `16` → "16+" on the screen |
| `uhd`, `hdr` | a badge on the tile: `4K`, `HDR`, `4K HDR` |

What you should **not** provide: rating, genres. The player gets them from Kinopoisk and TMDB by title and
year — the same way for every source.

## `details(item)` — the movie card

**Receives:** the item that was clicked (the same object you returned from `page`), or the result of your
`itemById`. Usually you need only `item.request` or `item.fid`.

**Returns:**

```js
{
    item: { …the same item, but with description, duration, a large poster… },
    episodes: [],      // episodes of a series — items of the same kind; an empty list for a movie
    streams: [         // links to the video
        { id: null, name: '', url: 'http://…/film.m3u8', variants: null }
    ]
}
```

### `streams` — audio versions

This is a list of links to **one and the same** movie.

**One link** (the usual case) — return one element with an empty `name`, and the card has the ordinary
"▶ Watch" button:

```js
streams: [ { id: null, name: '', url: 'http://…/film.m3u8', variants: null } ]
```

**Several audio versions** — one element per version, with a name. The player draws a button for each:

```js
streams: [
    { id: 56,  name: 'Dubbed',     url: 'http://…/dub.m3u8' },
    { id: 111, name: 'Netflix',    url: 'http://…/netflix.m3u8' },
    { id: 232, name: 'Original',   url: 'http://…/original.m3u8' }
]
```

On the screen:

```
 INTERSTELLAR (2014)
 [ ▶ Dubbed ]   [ ▶ Netflix ]   [ ▶ Original ]
```

The same appears in the Home Assistant card. The player remembers which version was chosen.

### `variants` — quality

If the service offers the same video in different qualities, put them into `variants` — and the viewer gets
a quality button:

```js
{
    id: 56, name: 'Dubbed',
    url: 'http://…/auto.m3u8',          // in case no quality is chosen
    variants: {
        auto: 'http://…/auto.m3u8',
        '2160': 'http://…/2160.m3u8',
        '1080': 'http://…/1080.m3u8',
        '720':  'http://…/720.m3u8'
    }
}
```

Only these keys: `auto`, `2160`, `1440`, `1080`, `720`, `480`. No `variants` — there is simply no quality
button, and that is fine. These keys are also what a voice request like "play it in 4K" is matched against.

### A series

For a series `episodes` holds the list of episodes (items of the same kind as in `page`). When the viewer
picks an episode, the player calls `details` **for that episode** — and that is where it must have its own
`streams`.

The player itself remembers the episode and the minute where you stopped and offers "Continue".

## `searchRequest(root, text)` and `filterRequest(requests)`

Both are simple translators from "what the viewer chose" to "your `request` for `page`".

```js
searchRequest(root, text) {
    return { path: '/search', query: text };   // text — what was typed on the screen
},

filterRequest(requests) {
    // requests — the requests of the chosen filter items from root()
    return Object.assign({ path: '/movies' }, ...requests);   // e.g. {path:'/movies', genre:5, year:2014}
}
```

Your search is also what the voice assistant uses ("play The Matrix"): the add-on calls every source's
search in turn and ranks the results itself, so plain substring search on your side is enough.

## `itemById(localId)` — the most important one for favourites

When the viewer adds a movie to favourites, the player remembers **only its identifier** — your `fid`.
A week later, when the favourites are opened again, there is no item any more, only that number. That is
when `itemById` is called: return an item `details` can be called with, given just the number.

```js
itemById(localId) {
    return { type: 'stream', fid: String(localId), request: { id: localId } };
}
```

No network requests are needed here — just assemble the object.

The same method is used when a movie is started from the Home Assistant card or by voice.

## About identifiers

Inside the plugin you always work with **your own** number: `12345`.

Outwards — into favourites, viewing history, Home Assistant — the player prefixes it with the source name:
`example:12345`. That way movie no. 12345 from your source is not mixed up with movie no. 12345 from another
one. The plugin does not need to know about this: it always receives its own number only.

## A complete working example

Next to this guide lies [`vod-plugin-example.js`](../vod-plugin-example.js) — a ready plugin with comments
(the comments and the sample titles are in Russian). It downloads nothing and returns a few made-up movies:
one has three audio versions, and there is a two-episode series. Install it as a file (steps 1–2, any
address) and see what everything looks like on the screen without having any service at all.

And here is the smallest plugin that already works — a good starting point:

```js
VodSources.register('example', {
    create(url, params) {
        const base = url.replace(/\/+$/, '');
        const api = async (path) => {
            const res = await fetch(base + path, { headers: { 'X-Api-Key': params.key || '' } });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
        };
        // from the service's format to the player's format; this is the plugin's whole job
        const toItem = (m) => ({
            type: m.is_series ? 'multistream' : 'stream',
            fid: String(m.id),
            title: m.name,
            year: m.release_year || null,
            poster: m.poster_url || null,
            request: { id: m.id }
        });

        return {
            async root() {
                const cats = await api('/categories');
                return {
                    categories: cats.map(c => ({ title: c.name, request: { cat: c.id, page: 1 } })),
                    search: { request: { query: '{USERINPUT}' } },
                    filters: []
                };
            },
            async page(request) {
                const q = request.query
                    ? '/search?q=' + encodeURIComponent(request.query)
                    : '/movies?cat=' + request.cat + '&page=' + (request.page || 1);
                const r = await api(q);
                return {
                    items: (r.items || []).map(toItem),
                    count: r.total || null,
                    nextRequest: r.has_more ? Object.assign({}, request, { page: (request.page || 1) + 1 }) : null
                };
            },
            async details(item) {
                const m = await api('/movies/' + (item.request ? item.request.id : item.fid));
                return {
                    item: Object.assign(toItem(m), { description: m.overview || '', duration: m.runtime || 0 }),
                    episodes: (m.episodes || []).map(toItem),
                    streams: (m.sources || [{ url: m.stream_url }]).map((s, i) => ({
                        id: s.id != null ? s.id : i,
                        name: s.dub_name || '',      // empty — the player shows the ordinary "Watch" button
                        url: s.url,
                        variants: s.qualities || null
                    }))
                };
            },
            searchRequest(root, text) { return { query: text }; },
            filterRequest(requests) { return Object.assign({}, ...requests); },
            itemById(localId) { return { type: 'stream', fid: String(localId), request: { id: localId } }; }
        };
    }
});
```

## Checking a plugin without touching the TV

Install the plugin and look at its card in the "Plugins" section: no error means the file ran. Then search
for a movie in the Home Assistant card — it searches through the same plugin in the add-on. If something is
wrong, the error is in the add-on log, where you can see which request the plugin stumbled on.

If you have the project sources, there is a ready test run as well:

```
node tools/vod-sources-test.js
```

It checks the registry, plugin installation, the sandbox, favourites and the example from this guide; it
needs no network.

## What the player does itself, so the plugin need not

- draws the rows, the grid, search, the movie card, the reviews screen;
- loads more pages on scrolling;
- remembers the viewing position and the last episode, offers "Continue";
- keeps the favourites — shared by all TVs, all sources and the Home Assistant card;
- gets ratings and genres from Kinopoisk and TMDB by title and year;
- switches quality and audio version;
- plays a movie by voice and from the Home Assistant card; finds it by voice across all sources;
- shows suggestion pages and remembers what was watched;
- translates the interface into four languages.

Only one thing is needed from a plugin: to translate your service's answers carefully into the format
described here.
