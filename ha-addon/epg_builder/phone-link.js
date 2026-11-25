/**
 * «Посмотреть позже» с телефона: адреса webhook для приложения «AssisTV: To TV» (android/ в репозитории).
 *
 * Аддон сам ищет в Home Assistant автоматизацию с триггером webhook, которая вызывает watchlist_add
 * (пример — ha-config/assistv-watchlist-webhook.yaml), и собирает из неё адрес для каждого человека из
 * списка phones (…/api/webhook/<id>?to=<имя>). Начало адреса — внешний адрес HA (или внутренний, если
 * внешнего нет или webhook только для домашней сети). Нет такой автоматизации — раздел просто объясняет,
 * зачем он нужен. Адрес webhook — секрет: страница с ним открывается только через панель в HA.
 */
const CACHE_MS = 2 * 60 * 1000;
let cache = null;   // { at, data }
let lastId = '';    // id найденной автоматизации — в следующий раз проверяем её первой

async function core(path) {
    const res = await fetch('http://supervisor/core/api' + path, {
        headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}` },
        signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

const asList = v => Array.isArray(v) ? v : v ? [v] : [];

/** Триггер webhook автоматизации (новый вид `trigger: webhook` и старый `platform: webhook`). */
function webhookTrigger(cfg) {
    return asList(cfg.triggers || cfg.trigger).find(t => t && (t.trigger || t.platform) === 'webhook' && t.webhook_id);
}

/** Список phones {имя: notify.…} из шага variables; порядок как в YAML (первый — по умолчанию). */
function findPhones(actions) {
    for (const a of asList(actions)) {
        if (a && a.variables && a.variables.phones && typeof a.variables.phones === 'object') {
            return Object.keys(a.variables.phones).filter(k => /^[\w.-]+$/.test(k));
        }
    }
    return [];
}

/** Ищем автоматизацию «Посмотреть позже»: webhook + вызов watchlist_add. Конфиги читаем пачками — автоматизаций бывают сотни. */
async function findAutomation() {
    const states = await core('/states');
    const autos = states.filter(s => s.entity_id.startsWith('automation.') && s.attributes && s.attributes.id)
        .sort((a, b) => (b.attributes.id === lastId) - (a.attributes.id === lastId));
    for (let i = 0; i < autos.length; i += 12) {
        const part = autos.slice(i, i + 12);
        const cfgs = await Promise.all(part.map(s => core('/config/automation/config/' + encodeURIComponent(s.attributes.id)).catch(() => null)));
        for (let j = 0; j < part.length; j++) {
            const cfg = cfgs[j], s = part[j];
            if (!cfg) continue;
            const trig = webhookTrigger(cfg);
            const actions = cfg.actions || cfg.action;
            if (!trig || JSON.stringify(actions || '').indexOf('watchlist_add') < 0) continue;
            lastId = s.attributes.id;
            return {
                entity: s.entity_id, name: s.attributes.friendly_name || cfg.alias || s.entity_id, on: s.state === 'on',
                webhookId: String(trig.webhook_id), localOnly: trig.local_only !== false, phones: findPhones(actions)
            };
        }
    }
    return null;
}

/**
 * Что показать на странице: { found: false } или
 * { found, name, on, localOnly, base, external, links: [{who, url}] }. Ошибка API — { error }.
 * base пустой — в HA не задан ни внешний, ни внутренний адрес: тогда url — только путь, начало подставит страница
 * (адрес, по которому открыт HA).
 */
async function info({ fresh } = {}) {
    if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.data;
    let data;
    try {
        const auto = await findAutomation();
        if (!auto) data = { found: false };
        else {
            const conf = await core('/config').catch(() => ({}));
            const external = !auto.localOnly && conf.external_url ? String(conf.external_url) : '';
            const base = (external || conf.internal_url || '').replace(/\/+$/, '');
            const path = '/api/webhook/' + encodeURIComponent(auto.webhookId);
            const links = auto.phones.length
                ? auto.phones.map(who => ({ who, url: base + path + '?to=' + encodeURIComponent(who) }))
                : [{ who: '', url: base + path }];
            data = { found: true, name: auto.name, on: auto.on, localOnly: auto.localOnly, base, external: !!external, links };
        }
    } catch (e) {
        data = { error: e.message };
    }
    cache = { at: Date.now(), data };
    return data;
}

/** Ссылка, по которой приложение на телефоне само сохраняет адрес (камера → QR → приложение). Та же сборка — в
 *  скрипте страницы (renderPhoneSection в server.js), когда начало адреса берётся из браузера. */
function setupLink(url) {
    return 'assistv-send://setup?url=' + encodeURIComponent(url);
}

module.exports = { info, setupLink, _test: { webhookTrigger, findPhones } };
