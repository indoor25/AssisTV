/**
 * Extended-M3U parser.
 * Supports TWO group styles because real provider playlists mix them:
 *   - #EXTINF ... group-title="X" ,Name   (standard)
 *   - #EXTINF ... ,Name  followed by a separate  #EXTGRP:X  line (our provider uses this one)
 * Also supports two catchup styles:
 *   - standard: catchup="append" catchup-days="N" catchup-source="..."
 *   - tvg-rec="N" (Stalker/Ministra-style: N = days of archive, 0 = none). The exact archive
 *     URL scheme for THIS provider is not yet known — see Player.buildCatchupUrl() TODO.
 * NOTE: our current playlist has no tvg-id/tvg-logo at all — EPG and logo matching for it
 * MUST go through channel NAME, not id. Keep that path first-class, not a fallback edge case.
 * Returns: [{ id, name, logo, group, url, catchup: { type, days, source } }]
 */
function parseM3U(text) {
    const lines = text.split(/\r?\n/);
    const channels = [];
    let pending = null;

    const attrRe = /([a-zA-Z0-9-]+)="([^"]*)"/g;

    for (let raw of lines) {
        const line = raw.trim();
        if (!line) continue;

        if (line.startsWith('#EXTINF')) {
            const attrs = {};
            let m;
            attrRe.lastIndex = 0;
            while ((m = attrRe.exec(line)) !== null) {
                attrs[m[1].toLowerCase()] = m[2];
            }
            const nameMatch = line.match(/,(.*)$/);

            let catchup = null;
            if (attrs['catchup']) {
                catchup = {
                    type: attrs['catchup'],
                    days: parseInt(attrs['catchup-days'] || '0', 10),
                    source: attrs['catchup-source'] || null
                };
            } else if (attrs['tvg-rec'] && parseInt(attrs['tvg-rec'], 10) > 0) {
                catchup = { type: 'tvg-rec', days: parseInt(attrs['tvg-rec'], 10), source: null };
            }

            pending = {
                id: attrs['tvg-id'] || null,
                name: (nameMatch ? nameMatch[1] : attrs['tvg-name'] || '').trim(),
                logo: attrs['tvg-logo'] || null,
                group: attrs['group-title'] || null, // may be filled by a following #EXTGRP line
                catchup
            };
        } else if (line.startsWith('#EXTGRP:')) {
            if (pending && !pending.group) {
                pending.group = line.slice('#EXTGRP:'.length).trim();
            }
        } else if (line.startsWith('#')) {
            continue; // #EXTM3U and anything else we don't handle yet
        } else {
            if (pending) {
                pending.group = pending.group || 'Без группы';
                pending.url = line;
                channels.push(pending);
                pending = null;
            }
        }
    }
    return channels;
}

// Node/CommonJS + browser global export
if (typeof module !== 'undefined') module.exports = { parseM3U };
