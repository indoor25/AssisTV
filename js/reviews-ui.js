/**
 * Рецензии зрителей Кинопоиска (#reviews-view) — открывается кнопкой «Рецензии» в карточке фильма.
 *
 * Одна рецензия на экран: их пишут развёрнуто, на пару экранов текста, и список из обрезанных кусков
 * читать с дивана невозможно. Поэтому ◄► — соседняя рецензия, ▲▼ — прокрутка текущей по экрану,
 * RETURN — назад в карточку. Сверху видно, какая по счёту и сколько всего, и каких рецензий сколько
 * (положительных / отрицательных / нейтральных).
 *
 * Данные — у аддона (AddonClient.loadVodReviews по kpId из /vod/meta), по 20 штук на страницу:
 * следующая догружается сама, когда ► доходит до конца загруженных. Текст приходит уже очищенным от
 * тегов (kinopoisk.js), здесь он ставится через textContent — из интернета в innerHTML ничего не идёт.
 */
const ReviewsUI = (() => {
    const SCROLL_OVERLAP = 60;      // при прокрутке на экран оставляем внахлёст пару строк

    let root = null;
    let els = {};
    let addonUrl = '';
    let st = null;                  // {kpId, title, items, total, pages, page, positive, negative, neutral, idx, loading, error}
    let onClose = () => {};

    function init() {
        root = document.createElement('div');
        root.id = 'reviews-view';
        root.className = 'hidden';
        root.innerHTML =
            '<div class="rv-head">' +
            '  <div class="rv-film"></div>' +
            '  <div class="rv-counts"></div>' +
            '  <div class="rv-pos"></div>' +
            '</div>' +
            '<div class="rv-card">' +
            '  <div class="rv-who"></div>' +
            '  <div class="rv-title"></div>' +
            '  <div class="rv-text"></div>' +
            '</div>' +
            '<div class="rv-more"></div>' +
            '<div class="rv-hint"></div>';
        document.body.appendChild(root);
        ['film', 'counts', 'pos', 'card', 'who', 'title', 'text', 'more', 'hint'].forEach(k => {
            els[k] = root.querySelector('.rv-' + k);
        });
        els.hint.textContent = I18n.t('reviews.hint');
    }

    function setAddonUrl(url) { addonUrl = url || ''; }

    function isOpen() { return !!root && !root.classList.contains('hidden'); }

    /** kpId и название — из d.meta карточки фильма; onClose — вернуть фокус в карточку. */
    function open({ kpId, title, onClose: cb }) {
        if (!root) init();
        onClose = cb || (() => {});
        st = {
            kpId, title: title || '', items: [], total: 0, pages: 0, page: 0,
            positive: 0, negative: 0, neutral: 0, idx: 0, loading: true, error: null
        };
        root.classList.remove('hidden');
        render();
        loadPage(1);
    }

    function close() {
        st = null;
        if (root) root.classList.add('hidden');
        onClose();
    }

    function loadPage(page) {
        const my = st;
        my.loading = true;
        render();
        AddonClient.loadVodReviews(addonUrl, { id: my.kpId, page }).then(r => {
            if (st !== my) return;
            my.loading = false;
            const d = (r && r.reviews) || {};
            my.items = my.items.concat(d.items || []);
            my.total = d.total || my.items.length;
            my.pages = d.pages || 1;
            my.page = page;
            if (page === 1) {
                my.positive = d.positive || 0;
                my.negative = d.negative || 0;
                my.neutral = d.neutral || 0;
            }
            // страницу догружали по ► — значит, её и ждут: переезжаем на первую новую рецензию
            if (my.advanceAfterLoad) {
                my.advanceAfterLoad = false;
                my.idx = Math.min(my.items.length - 1, my.idx + 1);
            }
            render();
        }).catch(e => {
            if (st !== my) return;
            my.loading = false;
            my.error = (e && e.message) || String(e);
            render();
        });
    }

    function current() { return st && st.items[st.idx]; }

    function typeLabel(t) {
        return { positive: I18n.t('reviews.positive'), negative: I18n.t('reviews.negative') }[t] || I18n.t('reviews.neutral');
    }

    function render() {
        if (!st) return;
        els.film.textContent = st.title;

        const counts = [];
        if (st.positive) counts.push('+' + st.positive);
        if (st.negative) counts.push('−' + st.negative);
        if (st.neutral) counts.push('=' + st.neutral);
        els.counts.textContent = counts.join('  ');

        const r = current();
        // «3 из 27»: сколько всего, знаем из ответа — даже пока догружены не все страницы
        els.pos.textContent = st.total ? I18n.t('reviews.of', { i: st.idx + 1, n: st.total }) : '';

        if (!r) {
            els.card.classList.add('empty');
            els.who.textContent = '';
            els.title.textContent = '';
            els.text.textContent = st.loading ? I18n.t('common.loading')
                : st.error ? I18n.t('common.loadFailed', { error: st.error })
                    : I18n.t('reviews.empty');
            els.more.textContent = '';
            return;
        }

        els.card.classList.remove('empty');
        els.who.innerHTML = '';
        const badge = document.createElement('span');
        badge.className = 'rv-badge rv-' + (r.type === 'positive' || r.type === 'negative' ? r.type : 'neutral');
        badge.textContent = typeLabel(r.type);
        els.who.appendChild(badge);
        const who = [r.author, r.date ? r.date.split('-').reverse().join('.') : '',
            r.helpful ? I18n.t('reviews.helpful', { n: r.helpful }) : ''].filter(Boolean);
        who.forEach(t => {
            const s = document.createElement('span');
            s.textContent = t;
            els.who.appendChild(s);
        });
        const src = document.createElement('span');
        src.className = 'rv-src';
        src.textContent = I18n.t('reviews.source');
        els.who.appendChild(src);

        els.title.textContent = r.title || '';
        els.title.classList.toggle('hidden', !r.title);
        els.text.textContent = r.text;
        els.text.scrollTop = 0;
        updateMore();
    }

    /**
     * Сколько ещё листать. Рецензии бывают на 16 тысяч знаков (это десяток экранов), и без этой строки
     * непонятно, дочитываешь ты её или только начал. Считается тем же шагом, которым листает ▼.
     */
    function updateMore() {
        if (!st) return;
        if (st.loading) { els.more.textContent = I18n.t('common.loading'); return; }
        const el = els.text;
        const hidden = el.scrollHeight - el.clientHeight;
        if (!current() || !el.clientHeight || hidden <= 0) { els.more.textContent = ''; return; }
        // последний шаг почти всегда неполный, поэтому низ считаем отдельно: иначе внизу висело бы
        // «3 из 4». Так каждое нажатие ▼ сдвигает счётчик ровно на единицу и последнее даёт n.
        const step = Math.max(80, el.clientHeight - SCROLL_OVERLAP);
        const n = Math.ceil(hidden / step) + 1;
        els.more.textContent = I18n.t('reviews.screen', {
            i: el.scrollTop >= hidden ? n : Math.floor(el.scrollTop / step) + 1,
            n
        });
    }

    /** Прокрутка текста экранами; вернёт false, если уже упёрлись в низ (тогда ▼ ничего не делает). */
    function scrollBy(dir) {
        const el = els.text;
        const step = Math.max(80, el.clientHeight - SCROLL_OVERLAP);
        const before = el.scrollTop;
        el.scrollTop = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, before + dir * step));
        updateMore();
        return el.scrollTop !== before;
    }

    function go(delta) {
        const next = st.idx + delta;
        if (next < 0) return;
        if (next >= st.items.length) {
            // дошли до конца загруженного: есть ли ещё страница
            if (!st.loading && st.page < st.pages) {
                st.advanceAfterLoad = true;
                loadPage(st.page + 1);
            }
            return;
        }
        st.idx = next;
        render();
    }

    function handleKey(key) {
        if (!st) return;
        if (key === 'back') return close();
        if (key === 'up') return void scrollBy(-1);
        if (key === 'down') return void scrollBy(1);
        if (key === 'left') return go(-1);
        if (key === 'right' || key === 'enter') return go(1);
    }

    return { init, open, close, isOpen, handleKey, setAddonUrl };
})();

if (typeof module !== 'undefined') module.exports = { ReviewsUI };
