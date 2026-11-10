'use strict';
// Что установщик говорит про чужие и неисправные пакеты и про отказы телевизора.
// Весь путь через HTTP установщика против поддельного TV (REST 8001 и sdb на свободных портах не выйдет —
// установщик ходит на :8001, поэтому тест занимает 127.0.0.1:8001 и 127.0.0.1:26101).
//   node test/errors-test.js

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const JSZip = require('jszip');
const fake = require('./fake-tv.js');

const cfg = (pkg, req) => '<?xml version="1.0"?><widget xmlns="http://www.w3.org/ns/widgets" xmlns:tizen="http://tizen.org/ns/widgets" id="x" version="2.0">'
    + '<tizen:application id="' + pkg + '.App" package="' + pkg + '" required_version="' + req + '"/><name>Чужое</name></widget>';
async function wgt(config, files) {
    const z = new JSZip();
    if (config) z.file('config.xml', config);
    for (const k of Object.keys(files || {})) z.file(k, files[k]);
    return z.generateAsync({ type: 'nodebuffer' });
}

(async () => {
    let answer = 'ok';
    const tv = fake.start({
        platform: '6.5',
        installedApps: ['Exists0001.App'],
        installOutput: (id) => ({
            ok: 'app_id[' + id + '] install completed\nspend time for wascmd is [5]ms\n',
            sign: 'app_id[' + id + '] install start\napp_id[' + id + '] install failed[118, -12] signature verification failed\nspend time for wascmd is [50]ms\n',
            odd: 'something strange\nspend time for wascmd is [5]ms\n'
        })[answer]
    });
    await tv.ready;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistv-installer-err-'));
    const proc = spawn(process.execPath, [path.join(__dirname, '../src/main.js')], {
        env: Object.assign({}, process.env, { ASSISTV_INSTALLER_DIR: dir, ASSISTV_INSTALLER_PORT: '18794', ASSISTV_INSTALLER_NO_BROWSER: '1' })
    });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    let passed = 0;
    const ok = (c, n) => { assert.ok(c, n); passed++; };
    try {
        for (let i = 0; i < 50 && !/k=[0-9a-f]+/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
        const k = out.match(/k=([0-9a-f]+)/)[1];
        const call = async (m, u, body, raw) => (await fetch('http://127.0.0.1:18794' + u, { method: m, headers: { 'X-Token': k }, body: raw || (body && JSON.stringify(body)) })).json();
        const file = (buf) => call('POST', '/api/package/file?name=a.wgt', null, buf);

        await call('POST', '/api/tv', { host: '127.0.0.1' });
        ok((await call('POST', '/api/connect')).platform === '6.5', 'подключение');

        ok((await file(Buffer.from('hello'))).error === 'not_wgt', 'не архив');
        ok((await file(await wgt(null, { 'index.html': 'x' }))).error === 'not_wgt', 'нет config.xml (.tpk и т.п.)');
        ok((await file(await wgt('<widget><name>x</name></widget>'))).error === 'not_wgt', 'нет tizen:application');

        await file(await wgt(cfg('NewTizen01', '9.0')));
        const tooNew = await call('POST', '/api/install', {});
        ok(tooNew.error === 'too_new' && /9\.0/.test(tooNew.detail), 'нужен телевизор новее');

        // отказ на приложении, которого на TV нет: удаление не предлагаем
        await file(await wgt(cfg('Broken0001', '3.0'), { 'index.html': 'x' }));
        answer = 'sign';
        let r = await call('POST', '/api/install', {});
        ok(!r.ok && r.code === '118, -12' && /signature/.test(r.line), 'отказ подписи — строка телевизора');
        ok(r.authorMismatch === false, 'нет на TV — удаление не предлагается');

        // то же, но приложение уже стоит: похоже на «другой автор» — предлагаем удалить
        await file(await wgt(cfg('Exists0001', '3.0'), { 'index.html': 'x' }));
        r = await call('POST', '/api/install', {});
        ok(r.authorMismatch === true, 'стоит на TV — предлагается удалить');
        r = await call('POST', '/api/install', { uninstallFirst: true });
        ok(tv.commands.includes('0 vd_appuninstall Exists0001') && r.authorMismatch === false, 'после удаления второй раз не предлагает');

        answer = 'odd';
        await file(await wgt(cfg('Broken0001', '3.0'), { 'index.html': 'x' }));
        r = await call('POST', '/api/install', {});
        ok(!r.ok && r.line === 'something strange', 'непонятный ответ — без служебной строки');

        answer = 'ok';
        r = await call('POST', '/api/install', {});
        ok(r.ok, 'обычная установка');
        console.log('OK errors-test: ' + passed + ' проверок');
    } finally {
        proc.kill();
        tv.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
