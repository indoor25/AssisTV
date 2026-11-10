'use strict';
// Проверка без телевизора: клиент sdb против поддельного TV, разбор пакета, подпись.
//   node test/selftest.js            (подпись Tizen скачивает сертификаты SDK с download.tizen.org)
//   node test/selftest.js --offline  (без этой части)

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');
const forge = require('node-forge');
const { Sdb } = require('../src/sdb.js');
const pkg = require('../src/pkg.js');
const { Certs } = require('../src/certs.js');
const fake = require('./fake-tv.js');

let passed = 0;
const ok = (cond, name) => { assert.ok(cond, name); passed++; };

async function sampleWgt(signed) {
    const zip = new JSZip();
    zip.file('config.xml', '<?xml version="1.0"?>\n<widget xmlns="http://www.w3.org/ns/widgets" xmlns:tizen="http://tizen.org/ns/widgets" id="http://example.com/t" version="1.2.3">\n'
        + '<tizen:application id="TestPkg001.Hello" package="TestPkg001" required_version="3.0"/>\n<name>Hello &amp; TV</name>\n<content src="index.html"/>\n</widget>\n');
    zip.file('index.html', '<h1>hi</h1>');
    zip.file('js/app.js', 'console.log(1)');
    zip.file('img/пробел и юникод.txt', 'x');
    if (signed) { zip.file('author-signature.xml', '<old/>'); zip.file('signature1.xml', '<old/>'); }
    return zip.generateAsync({ type: 'nodebuffer' });
}

// подпись XML настоящая: SignatureValue сходится с ключом из первого сертификата, хеши файлов верные
function checkSignature(xml, files) {
    const signedInfo = xml.match(/<SignedInfo>[\s\S]*<\/SignedInfo>/)[0].replace('<SignedInfo>', '<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">');
    const value = xml.match(/<SignatureValue>([\s\S]*?)<\/SignatureValue>/)[1].replace(/\s/g, '');
    const certB64 = xml.match(/<X509Certificate>([\s\S]*?)<\/X509Certificate>/)[1].replace(/\s/g, '');
    const pem = '-----BEGIN CERTIFICATE-----\n' + certB64.match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----';
    ok(crypto.createVerify('RSA-SHA512').update(signedInfo).verify(pem, value, 'base64'), 'подпись сходится');
    for (const m of xml.matchAll(/<Reference URI="([^"#][^"]*)">[\s\S]*?<DigestValue>([\s\S]*?)<\/DigestValue>/g)) {
        const data = files[decodeURIComponent(m[1])];
        ok(data && crypto.createHash('sha512').update(data).digest('base64') === m[2].replace(/\s/g, ''), 'хеш файла ' + m[1]);
    }
    return forge.pki.certificateFromPem(pem);
}

(async () => {
    // --- разбор пакета ---
    const wgt = await sampleWgt(true);
    const info = await pkg.inspect(wgt);
    ok(info.name === 'Hello & TV' && info.version === '1.2.3' && info.appId === 'TestPkg001.Hello' && info.packageId === 'TestPkg001' && info.signed, 'config.xml');
    ok(!(await pkg.inspect(await sampleWgt(false))).signed, 'без подписи');
    await pkg.inspect(Buffer.from('not a zip')).then(() => ok(false, 'не zip'), (e) => ok(e.code === 'not_wgt', 'не zip'));

    // --- sdb против поддельного TV ---
    const tv = fake.start({ sdbPort: 0, rest: false, platform: '6.5', duid: 'ABCD1234EFGH' });
    const { sdbPort } = await tv.ready;
    const sdb = new Sdb('127.0.0.1', sdbPort);
    await sdb.connect();
    ok(sdb.connected, 'подключение');
    ok(await sdb.platformVersion() === '6.5', 'версия Tizen');
    ok(await sdb.duid() === 'ABCD1234EFGH', 'DUID');
    const big = crypto.randomBytes(300 * 1024 + 123);
    let last = 0;
    await sdb.push('/home/owner/share/tmp/sdk_tools/package.wgt', big, (p) => { last = p; });
    ok(last === 1 && tv.files['/home/owner/share/tmp/sdk_tools/package.wgt'].equals(big), 'отправка файла 300 КБ');
    await sdb.push('/tmp/empty', Buffer.alloc(0));
    ok(tv.files['/tmp/empty'].length === 0, 'пустой файл');
    const out = await sdb.shell('0 vd_appinstall TestPkg001 /home/owner/share/tmp/sdk_tools/package.wgt', 5000, (t) => /spend time/.test(t));
    ok(/install completed/.test(out), 'команда установки');
    sdb.close();
    tv.close();
    await new Sdb('127.0.0.1', 1).connect(1500).then(() => ok(false, 'закрытый порт'), (e) => ok(['refused', 'timeout', 'network', 'no_answer'].includes(e.code), 'закрытый порт'));
    // TV закрывает соединение, не ответив (чужой Host PC IP)
    const deaf = net.createServer((s) => s.destroy());
    await new Promise((r) => deaf.listen(0, '127.0.0.1', r));
    await new Sdb('127.0.0.1', deaf.address().port).connect(3000).then(() => ok(false, 'сброс'), (e) => ok(e.code === 'rejected' || e.code === 'reset', 'сброс: ' + e.code));
    deaf.close();

    // --- подпись сертификатом Tizen ---
    if (!process.argv.includes('--offline')) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistv-installer-test-'));
        try {
            const certs = new Certs(dir);
            const profile = await certs.tizenProfile();
            const signed = await pkg.resign(wgt, profile);
            const zip = await JSZip.loadAsync(signed);
            const files = {};
            for (const n of Object.keys(zip.files)) files[n] = await zip.files[n].async('nodebuffer');
            ok(!files['author-signature.xml'].toString().includes('<old/>'), 'старая подпись заменена');
            const author = checkSignature(files['author-signature.xml'].toString(), files);
            ok(author.issuer.getField('CN').value === 'Tizen Developers CA', 'автор от Tizen Developers CA');
            const dist = checkSignature(files['signature1.xml'].toString(), files);
            ok(/Distributor/.test(dist.subject.getField('CN').value), 'распространитель Tizen');
            ok((await pkg.inspect(signed)).signed, 'пакет читается');
            // автор не меняется между запусками — иначе приложение не обновить поверх
            const pemOf = (p) => forge.pki.certificateToPem(p.author.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag][0].cert);
            ok(pemOf(await new Certs(dir).tizenProfile()) === pemOf(profile), 'автор сохраняется');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
    console.log('OK: ' + passed + ' проверок');
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
