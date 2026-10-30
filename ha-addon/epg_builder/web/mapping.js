/**
 * Окно ручного сопоставления каналов с EPG на странице аддона: слева каналы плейлиста, справа каналы
 * EPG (у каждого видно, сколько передач и до какого числа есть программа), «Присвоить». Привязка
 * сохраняется в /data/manual_map.json, сервис пересобирает плейлисты по уже скачанному EPG.
 * Все адреса относительные — страница открывается и на :8765, и через ingress HA.
 * Тексты — window.IPTV_I18N (страница аддона кладёт фразы map.* на языке аддона, lang/*.js).
 */
(function () {
    'use strict';

    const LIMIT = 200;
    const NO_EPG = '-';
    let catalog = null;        // {loadedAt, channels: [{id, names, icon, count, last}]}
    let byId = {};
    let pl = null;             // {id, name, channels: [{name, group, id, how, count, last}], manual, options}
    let selLeft = null;        // имя канала плейлиста
    let selRight = null;       // id канала EPG
    let autoQuery = '';        // что сами подставили в поиск справа
    let el = {};

    const $ = (tag, cls, text) => {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    };
    const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}+]+/gu, ' ').trim();
    const matches = (hay, q) => { const words = norm(q).split(' ').filter(Boolean); const h = ' ' + norm(hay) + ' '; return words.every(w => h.includes(w)); };
    const date = sec => { const d = new Date(sec * 1000); return ('0' + d.getDate()).slice(-2) + '.' + ('0' + (d.getMonth() + 1)).slice(-2); };
    const icon = url => (url && location.protocol === 'https:' ? url.replace(/^http:\/\/epg\.one\//, 'https://cdn.epg.one/').replace(/^http:/, 'https:') : url);
    const nowSec = () => Date.now() / 1000;
    const TEXTS = window.IPTV_I18N || {};
    const _t = (key, p) => String(TEXTS[key] || key).replace(/\{(\w+)\}/g, (m, k) => (p && p[k] != null ? p[k] : m));

    /** «23 передачи, до 17.09» / «нет передач, последняя до 09.09» */
    function epgInfo(count, last) {
        if (count) return _t('map.progUntil', { n: count, date: date(last) });
        return last ? _t('map.noProgWas', { date: date(last) }) : _t('map.noProg');
    }

    async function getJson(url) {
        const res = await fetch(url, { cache: 'no-store' });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.message || body.error || 'HTTP ' + res.status);
        return body;
    }

    async function loadCatalog() {
        if (catalog) return catalog;
        catalog = await getJson('mapping/epg.json');
        byId = {};
        catalog.channels.forEach(c => { byId[c.id] = c; });
        return catalog;
    }

    function build() {
        const back = $('div', 'mp-back');
        back.hidden = true;
        back.innerHTML = `
<div class="mp" role="dialog">
  <div class="mp-head"><b class="mp-title"></b><button class="mp-x" title="${_t('map.close')}">×</button></div>
  <div class="mp-cols">
    <div class="mp-col">
      <div class="mp-tools"><input class="mp-q-left" placeholder="${_t('map.searchPlaylist')}">
        <select class="mp-filter">
          <option value="all">${_t('map.filterAll')}</option><option value="noprog">${_t('map.filterNoProg')}</option>
          <option value="none">${_t('map.filterNone')}</option><option value="manual">${_t('map.filterManual')}</option>
        </select></div>
      <div class="mp-count mp-count-left"></div>
      <div class="mp-list mp-left"></div>
    </div>
    <div class="mp-col">
      <div class="mp-tools"><input class="mp-q-right" placeholder="${_t('map.searchEpg')}">
        <label class="mp-chk"><input type="checkbox" class="mp-withprog" checked> ${_t('map.withProg')}</label></div>
      <div class="mp-count mp-count-right"></div>
      <div class="mp-list mp-right"></div>
    </div>
  </div>
  <div class="mp-foot">
    <div class="mp-sel"></div>
    <div class="mp-btns">
      <button class="mp-reset secondary">${_t('map.reset')}</button>
      <button class="mp-none secondary">${_t('map.none')}</button>
      <button class="mp-assign">${_t('map.assign')}</button>
    </div>
    <div class="mp-msg"></div>
  </div>
</div>`;
        document.body.appendChild(back);
        const q = s => back.querySelector(s);
        el = {
            back, title: q('.mp-title'), qLeft: q('.mp-q-left'), filter: q('.mp-filter'), left: q('.mp-left'),
            qRight: q('.mp-q-right'), withProg: q('.mp-withprog'), right: q('.mp-right'),
            countLeft: q('.mp-count-left'), countRight: q('.mp-count-right'),
            sel: q('.mp-sel'), msg: q('.mp-msg'), assign: q('.mp-assign'), none: q('.mp-none'), reset: q('.mp-reset')
        };
        q('.mp-x').onclick = close;
        back.addEventListener('click', e => { if (e.target === back) close(); });
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && !back.hidden) close(); });
        el.qLeft.oninput = el.filter.onchange = renderLeft;
        el.qRight.oninput = () => { autoQuery = null; renderRight(); };
        el.withProg.onchange = renderRight;
        el.assign.onclick = () => save(selRight);
        el.none.onclick = () => save(NO_EPG);
        el.reset.onclick = () => save(null);
    }

    function renderLeft() {
        const f = el.filter.value;
        const q = el.qLeft.value;
        const list = pl.channels.filter(c =>
            (f === 'all' || (f === 'noprog' && !c.count) || (f === 'none' && !c.id) || (f === 'manual' && c.how !== 'auto' && c.how !== 'none')) &&
            (!q || matches(c.name + ' ' + (c.group || ''), q)));
        el.countLeft.textContent = list.length > LIMIT ? _t('map.shown', { n: LIMIT, total: list.length }) : _t('map.count', { n: list.length });
        el.left.replaceChildren(...list.slice(0, LIMIT).map(c => {
            const row = $('div', 'mp-row' + (c.name === selLeft ? ' sel' : ''));
            const top = $('div', 'mp-name', c.name);
            if (c.how === 'manual' || c.how === 'bad') top.appendChild($('span', 'mp-badge', _t(c.how === 'bad' ? 'map.broken' : 'map.manual')));
            if (c.from_options) top.appendChild($('span', 'mp-badge opt', _t('map.fromOptions')));
            row.appendChild(top);
            const e = c.id && byId[c.id];
            const sub = c.id ? `→ ${e ? e.names[0] : c.id} · ${epgInfo(c.count, c.last)}`
                : _t(c.how === 'manual' ? 'map.noProgManual' : 'map.filterNone');
            row.appendChild($('div', 'mp-sub' + (c.count ? '' : ' bad'), (c.group ? c.group + ' · ' : '') + sub));
            row.onclick = () => pickLeft(c);
            return row;
        }));
    }

    function renderRight() {
        const q = el.qRight.value;
        const current = selLeft && pl.channels.find(c => c.name === selLeft);
        let list = catalog.channels.filter(c => (!el.withProg.checked || c.count) && (!q || matches(c.names.join(' ') + ' ' + c.id, q)));
        // сначала с передачами, из них — где программа длиннее
        list.sort((a, b) => (!!b.count - !!a.count) || ((b.last || 0) - (a.last || 0)));
        el.countRight.textContent = list.length > LIMIT ? _t('map.shown', { n: LIMIT, total: list.length })
            : !list.length && el.withProg.checked ? _t('map.nothingWithProg')
                : _t('map.countEpg', { n: list.length });
        el.right.replaceChildren(...list.slice(0, LIMIT).map(c => {
            const row = $('div', 'mp-row mp-epg' + (c.id === selRight ? ' sel' : '') + (current && current.id === c.id ? ' cur' : ''));
            const img = $('img');
            img.loading = 'lazy';
            img.alt = '';
            if (c.icon) img.src = icon(c.icon); else img.style.visibility = 'hidden';
            row.appendChild(img);
            const box = $('div', 'mp-txt');
            box.appendChild($('div', 'mp-name', c.names[0]));
            const other = c.names.slice(1).join(', ');
            box.appendChild($('div', 'mp-sub' + (c.count ? '' : ' bad'),
                `id ${c.id} · ${epgInfo(c.count, c.last)}${c.last && c.last < nowSec() ? ' (' + _t('map.outdated') + ')' : ''}${other ? ' · ' + other : ''}`));
            row.appendChild(box);
            row.onclick = () => { selRight = c.id; renderRight(); renderSel(); };
            return row;
        }));
    }

    function renderSel() {
        const c = selLeft && pl.channels.find(x => x.name === selLeft);
        const e = selRight && byId[selRight];
        el.sel.textContent = !c ? _t('map.selectHint')
            : `«${c.name}» → ${e ? `«${e.names[0]}» (${epgInfo(e.count, e.last)})` : _t('map.selectEpg')}`;
        el.assign.disabled = !(c && e && c.id !== e.id) && !(c && e && c.how !== 'manual');
        el.none.disabled = !c;
        el.reset.disabled = !(c && pl.manual[c.name] != null);
        el.reset.title = c && pl.options[c.name] && pl.manual[c.name] == null ? _t('map.fromOptionsHint') : '';
    }

    function pickLeft(c) {
        selLeft = c.name;
        selRight = null;
        // подставляем в поиск справа имя без HD/orig — если пользователь сам туда ничего не писал
        if (autoQuery !== null || !el.qRight.value) {
            autoQuery = c.name.replace(/\b(hd|fhd|uhd|hdr|4k|orig|ua|ru)\b/gi, '').replace(/\s+/g, ' ').trim();
            el.qRight.value = autoQuery;
        }
        renderLeft();
        renderRight();
        renderSel();
        el.right.scrollTop = 0;
    }

    async function loadPlaylist(id) {
        pl = await getJson('mapping/playlists/' + id + '.json');
        el.title.textContent = _t('map.title', { name: pl.name });
    }

    async function save(value) {
        if (!selLeft) return;
        el.msg.textContent = _t('map.saving');
        [el.assign, el.none, el.reset].forEach(b => { b.disabled = true; });
        try {
            const res = await fetch('mapping', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: selLeft, epg_id: value })
            });
            const r = await res.json();
            if (!res.ok || !r.ok) throw new Error(r.error || 'HTTP ' + res.status);
            await loadPlaylist(pl.id);
            el.msg.textContent = r.pending
                ? _t('map.savedPending')
                : _t('map.saved');
            selRight = null;
            renderLeft();
            renderRight();
            renderSel();
            renderManualList();
        } catch (err) {
            el.msg.textContent = _t('map.error', { error: err.message });
            renderSel();
        }
    }

    async function open(playlistId) {
        if (!el.back) build();
        el.back.hidden = false;
        document.body.classList.add('mp-open');
        el.msg.textContent = _t('common.loading');
        el.left.replaceChildren();
        el.right.replaceChildren();
        try {
            await loadCatalog();
            await loadPlaylist(playlistId);
            selLeft = selRight = null;
            el.msg.textContent = _t('map.epgLoaded', { time: new Date(catalog.loadedAt).toLocaleString(), n: catalog.channels.length });
            renderLeft();
            renderRight();
            renderSel();
        } catch (err) {
            el.msg.textContent = _t('map.loadFailed', { error: err.message });
        }
    }

    function close() {
        el.back.hidden = true;
        document.body.classList.remove('mp-open');
    }

    /** Список ручных привязок на странице (#manual-map) с кнопками удаления. */
    async function renderManualList() {
        const box = document.getElementById('manual-map');
        if (!box) return;
        try {
            const [m] = await Promise.all([getJson('mapping.json'), loadCatalog().catch(() => null)]);
            const rows = Object.entries(m.manual).sort((a, b) => a[0].localeCompare(b[0]));
            const optRows = Object.entries(m.options).filter(([n]) => m.manual[n] == null);
            if (!rows.length && !optRows.length) { box.textContent = _t('map.noManual'); return; }
            const table = $('table');
            const target = v => {
                if (v === NO_EPG) return _t('map.filterNoProg');
                const e = byId[v];
                return e ? `${e.names[0]} (id ${v}, ${epgInfo(e.count, e.last)})` : v;
            };
            rows.forEach(([name, v]) => {
                const tr = $('tr');
                tr.appendChild($('td', '', name));
                tr.appendChild($('td', '', '→ ' + target(v)));
                const td = $('td');
                const b = $('button', 'danger small', _t('map.delete'));
                b.onclick = async () => {
                    b.disabled = true;
                    await fetch('mapping', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, epg_id: null }) });
                    renderManualList();
                };
                td.appendChild(b);
                tr.appendChild(td);
                table.appendChild(tr);
            });
            optRows.forEach(([name, v]) => {
                const tr = $('tr');
                tr.appendChild($('td', '', name));
                tr.appendChild($('td', '', '→ ' + target(v)));
                tr.appendChild($('td', 'muted', _t('map.fromManualMap')));
                table.appendChild(tr);
            });
            box.replaceChildren(table);
        } catch (err) {
            box.textContent = _t('map.loadFailed', { error: err.message });
        }
    }

    window.IptvMapping = { open };
    renderManualList();
})();
