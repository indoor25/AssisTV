// Совместимость со старыми TV (Tizen 3–5, Chromium 47–69). Подключается только в сборке -Legacy, первым скриптом.
// Пишется сразу на ES5 — Babel его не трогает. window.LEGACY_VAR_RULES подставляет build-legacy.js:
// правила style.css с var(--…), которые старый браузер выбросил.
(function () {
    // AbortController (Chromium 66): libs/mqtt.min.js берёт его из window при загрузке и падает без него
    if (!window.AbortController) {
        var AbortSignal = function () { this.aborted = false; this.reason = undefined; this.onabort = null; this._listeners = []; };
        AbortSignal.prototype.addEventListener = function (type, fn) { if (type === 'abort') this._listeners.push(fn); };
        AbortSignal.prototype.removeEventListener = function (type, fn) {
            var i = this._listeners.indexOf(fn);
            if (i >= 0) this._listeners.splice(i, 1);
        };
        AbortSignal.prototype.throwIfAborted = function () { if (this.aborted) throw this.reason; };
        var AbortController = function () { this.signal = new AbortSignal(); };
        AbortController.prototype.abort = function (reason) {
            var s = this.signal;
            if (s.aborted) return;
            s.aborted = true;
            s.reason = reason !== undefined ? reason : new Error('AbortError');
            var ev = { type: 'abort', target: s };
            if (s.onabort) s.onabort(ev);
            s._listeners.slice().forEach(function (fn) { fn.call(s, ev); });
        };
        window.AbortController = AbortController;
        window.AbortSignal = AbortSignal;
    }

    var root = document.documentElement;
    var probe = document.createElement('div');

    // gap у flex (Chromium 84): у колонки из двух пустых блоков с gap высота будет 1 px, без — 0
    probe.style.cssText = 'display:flex;flex-direction:column;row-gap:1px;position:absolute;visibility:hidden';
    probe.appendChild(document.createElement('div'));
    probe.appendChild(document.createElement('div'));
    root.appendChild(probe);
    if (probe.scrollHeight !== 1) root.className += ' no-flex-gap';
    root.removeChild(probe);

    var noGrid = !('gridTemplateColumns' in probe.style);
    if (noGrid) root.className += ' no-grid';
    var noVars = !(window.CSS && CSS.supports && CSS.supports('(--a: 0)'));
    if (!noGrid && !noVars) return;

    var vars = {}, grid = {};
    var styleEl = document.createElement('style');
    document.head.appendChild(styleEl);

    function render() {
        var css = noVars ? String(window.LEGACY_VAR_RULES || '').replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g,
            function (m, name, fallback) { return vars[name] != null ? vars[name] : (fallback || '').trim(); }) : '';
        // главный экран: home-ui.js задаёт плитки через grid-template-columns/grid-auto-rows — переводим в размер плитки
        if (noGrid && grid.tile) css += '.home-grid > * { width: ' + grid.tile + 'px; height: ' + (grid.row || grid.tile) + 'px; }';
        styleEl.textContent = css;
    }

    var proto = CSSStyleDeclaration.prototype;
    if (noVars) {
        var setProperty = proto.setProperty;
        proto.setProperty = function (name, value) {
            if (String(name).indexOf('--') === 0) { vars[name] = String(value); render(); return; }
            return setProperty.apply(this, arguments);
        };
    }
    if (noGrid) {
        Object.defineProperty(proto, 'gridTemplateColumns', { configurable: true, get: function () { return ''; },
            set: function (v) { var m = /repeat\(\s*\d+\s*,\s*(\d+)px/.exec(v); if (m) { grid.tile = +m[1]; render(); } } });
        Object.defineProperty(proto, 'gridAutoRows', { configurable: true, get: function () { return ''; },
            set: function (v) { var m = /^(\d+)px/.exec(v); if (m) { grid.row = +m[1]; render(); } } });
    }
    render();
})();
