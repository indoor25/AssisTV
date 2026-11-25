// «Посмотреть позже» с телефона (ha-addon/epg_builder/phone-link.js): поиск автоматизации с webhook и адреса
// для телефонов — на заглушке API Home Assistant. node tools/phone-link-test.js
const phoneLink = require('../ha-addon/epg_builder/phone-link.js');
let ok = 0, bad = 0;
const check = (c, m) => { c ? ok++ : (bad++, console.log('FAIL', m)); };

const WATCH = {
    alias: 'AssisTV: Watch later', triggers: [{ trigger: 'webhook', webhook_id: 'secret-id-123', local_only: false }],
    actions: [{ variables: { phones: { me: 'notify.mobile_app_my_phone', anna: 'notify.mobile_app_anna_phone' } } },
        { action: 'script.iptv_zapros', data: { request: { action: 'watchlist_add', text: '{{ text }}' } } }]
};
const OTHER = { alias: 'Свет', triggers: [{ trigger: 'webhook', webhook_id: 'light' }], actions: [{ action: 'light.toggle' }] };
let autos, conf;
global.fetch = async url => {
    const p = url.replace('http://supervisor/core/api', '');
    const json = d => ({ ok: true, json: async () => d });
    if (p === '/states') return json(Object.keys(autos).map(id => ({ entity_id: 'automation.' + id, state: autos[id].off ? 'off' : 'on', attributes: { id, friendly_name: autos[id].alias } })));
    if (p === '/config') return json(conf);
    const m = p.match(/^\/config\/automation\/config\/(.+)$/);
    if (m && autos[decodeURIComponent(m[1])]) return json(autos[decodeURIComponent(m[1])]);
    return { ok: false, status: 404 };
};

(async () => {
    autos = { light: OTHER }; conf = { external_url: 'https://ha.example.org/', internal_url: 'http://192.0.2.5:8123' };
    let r = await phoneLink.info({ fresh: true });
    check(r.found === false, 'нет автоматизации — found false');

    autos = { light: OTHER, watch: WATCH };
    r = await phoneLink.info({ fresh: true });
    check(r.found && r.name === 'AssisTV: Watch later' && r.on, 'найдена');
    check(r.links.length === 2 && r.links[0].who === 'me' && r.links[1].who === 'anna', 'люди по порядку phones');
    check(r.links[0].url === 'https://ha.example.org/api/webhook/secret-id-123?to=me', 'внешний адрес и ?to=');
    check(r.external && !r.localOnly, 'внешний');

    autos = { watch: Object.assign({}, WATCH, { triggers: [{ platform: 'webhook', webhook_id: 'x' }], actions: WATCH.actions.slice(1), off: true }) };
    r = await phoneLink.info({ fresh: true });
    check(r.found && !r.on && r.localOnly, 'старый platform:, выключена, local_only по умолчанию');
    check(r.links.length === 1 && r.links[0].url === 'http://192.0.2.5:8123/api/webhook/x', 'без phones — один адрес, внутренний');

    conf = {};
    r = await phoneLink.info({ fresh: true });
    check(r.found && r.base === '' && r.links[0].url === '/api/webhook/x', 'нет адреса HA');

    global.fetch = async () => { throw new Error('down'); };
    r = await phoneLink.info({ fresh: true });
    check(r.error === 'down', 'ошибка API');

    const link = phoneLink.setupLink('https://h/api/webhook/a?to=b');
    check(link === 'assistv-send://setup?url=https%3A%2F%2Fh%2Fapi%2Fwebhook%2Fa%3Fto%3Db', 'ссылка для приложения');
    const qr = require('../ha-addon/epg_builder/node_modules/qrcode-generator');
    const q = qr(0, 'M'); q.addData(link); q.make();
    check(/^<svg[^>]*viewBox/.test(q.createSvgTag({ cellSize: 4, margin: 4, scalable: true })), 'QR — svg');

    console.log(`phone-link: ${ok} ok, ${bad} fail`);
    process.exit(bad ? 1 : 0);
})();
