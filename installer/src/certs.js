'use strict';
// Сертификаты для подписи пакета — без Tizen Studio.
//   Tizen 7 и новее: сертификат Samsung (нужен вход в учётную запись Samsung, привязан к DUID телевизора);
//   старее:           сертификат Tizen, делается на месте, вход не нужен.
// Порядок запросов к Samsung взят из tizen.js (github.com/reisxd/tizen.js, GPL-3.0).
// Автор хранится и не меняется: приложение обновляется поверх, только пока автор тот же.

const forge = require('node-forge');
const JSZip = require('jszip');
const fs = require('fs');
const path = require('path');

const TIZEN_CERTGEN = 'https://download.tizen.org/sdk/tizenstudio/official/binary/certificate-generator_0.1.4_ubuntu-64.zip';
const TIZEN_EXT_INFO = 'https://download.tizen.org/sdk/tizenstudio/official/extension_info.xml';
const SAMSUNG_EXT_FALLBACK = 'https://download.tizen.org/sdk/extensions/tizen-certificate-extension_2.0.70.zip';
const SAMSUNG_CA = 'https://svdca.samsungqbe.com/apis/v3';
// пароли из открытого Tizen SDK — одинаковые у всех
const TIZEN_CA_KEY_PASS = 'tizencertificatefordevelopercaroqkfwk';
const TIZEN_DISTRIBUTOR_PASS = 'tizenpkcs12passfordsigner';

// Вход Samsung для Tizen Studio (клиент v285zxnl3h). С redirect_uri Samsung после входа сам отправляет форму
// с полем code (JSON: access_token, userId, inputEmailID) на localhost:4794 — адрес разрешён только этот.
// Адрес signInGate из README tizen.js лишь показывает эти данные на странице — не годится.
const SAMSUNG_LOGIN_URL = 'https://account.samsung.com/mobile/account/check.do?serviceID=v285zxnl3h&actionID=StartOAuth2&accessToken=Y&redirect_uri=http://localhost:4794/signin/callback';

function randomPassword() {
    return forge.util.bytesToHex(forge.random.getBytesSync(12));
}

async function download(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
    return Buffer.from(await res.arrayBuffer());
}

function toP12(privateKey, certs, password) {
    const asn1 = forge.pkcs12.toPkcs12Asn1(privateKey, certs, password, { generateLocalKeyId: true, friendlyName: 'UserCertificate' });
    return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary').toString('base64');
}

function openP12(base64, password) {
    const der = Buffer.from(base64, 'base64').toString('binary');
    return forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), false, password);
}

function pemCerts(text) {
    return text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
}

class Certs {
    // dir — папка с настройками установщика (сертификаты пользователя и скачанные корневые)
    constructor(dir) {
        this.dir = dir;
        this.file = path.join(dir, 'certificates.json');
        fs.mkdirSync(dir, { recursive: true });
        try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { this.data = {}; }
    }

    save() {
        const tmp = this.file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
        fs.renameSync(tmp, this.file);
    }

    _cache(name) { return path.join(this.dir, 'ca', name); }

    // ---------- Tizen (телевизоры до Tizen 7) ----------

    async _tizenFiles() {
        const names = ['tizen-developer-ca.cer', 'tizen-developer-ca-privatekey.pem', 'tizen-distributor-signer.p12'];
        if (!names.every((n) => fs.existsSync(this._cache(n)))) {
            const zip = await JSZip.loadAsync(await download(TIZEN_CERTGEN));
            const base = 'data/tools/certificate-generator/certificates/';
            const src = {
                'tizen-developer-ca.cer': base + 'developer/tizen-developer-ca.cer',
                'tizen-developer-ca-privatekey.pem': base + 'developer/tizen-developer-ca-privatekey.pem',
                'tizen-distributor-signer.p12': base + 'distributor/sdk-public/tizen-distributor-signer.p12'
            };
            fs.mkdirSync(this._cache(''), { recursive: true });
            for (const n of names) {
                const f = zip.file(src[n]);
                if (!f) throw new Error('Tizen SDK: ' + src[n] + ' not found');
                fs.writeFileSync(this._cache(n), await f.async('nodebuffer'));
            }
        }
        return {
            caPem: fs.readFileSync(this._cache(names[0]), 'utf8'),
            caKeyPem: fs.readFileSync(this._cache(names[1]), 'utf8'),
            distributor: fs.readFileSync(this._cache(names[2])).toString('base64')
        };
    }

    // { author, distributor } — готовые forge-объекты PKCS#12
    async tizenProfile() {
        const files = await this._tizenFiles();
        if (!this.data.tizen) {
            const caKey = forge.pki.decryptRsaPrivateKey(files.caKeyPem, TIZEN_CA_KEY_PASS);
            if (!caKey) throw new Error('Tizen SDK: CA key');
            // в файле центра может быть цепочка — нужен тот сертификат, чей ключ у нас
            const caPem = pemCerts(files.caPem).find((p) => {
                const c = forge.pki.certificateFromPem(p);
                return c.publicKey.n.equals(caKey.n);
            });
            if (!caPem) throw new Error('Tizen SDK: CA certificate');
            const ca = forge.pki.certificateFromPem(caPem);
            // размер ключа и расширения — как у сертификата из Tizen Studio (проверено на Tizen 3)
            const keys = forge.pki.rsa.generateKeyPair(1024);
            const cert = forge.pki.createCertificate();
            cert.publicKey = keys.publicKey;
            cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(8)).replace(/^[89a-f]/, '1');
            cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
            cert.validity.notAfter = new Date(Date.now() + 20 * 365 * 24 * 3600 * 1000);
            cert.setSubject([{ name: 'commonName', value: 'AssisTV Installer' }]);
            cert.setIssuer(ca.subject.attributes);
            cert.setExtensions([
                { name: 'basicConstraints', cA: true },
                { name: 'keyUsage', keyCertSign: true, digitalSignature: true, nonRepudiation: true, keyEncipherment: true, dataEncipherment: true },
                { name: 'extKeyUsage', codeSigning: true }
            ]);
            cert.sign(caKey, forge.md.sha512.create());
            const password = randomPassword();
            this.data.tizen = { author: toP12(keys.privateKey, [forge.pki.certificateToPem(cert), caPem], password), password };
            this.save();
        }
        return {
            kind: 'tizen',
            author: openP12(this.data.tizen.author, this.data.tizen.password),
            distributor: openP12(files.distributor, TIZEN_DISTRIBUTOR_PASS)
        };
    }

    // ---------- Samsung (Tizen 7 и новее) ----------

    async _samsungFiles() {
        const names = ['vd_tizen_dev_author_ca.cer', 'vd_tizen_dev_public2.crt', 'vd_tizen_dev_partner2.crt'];
        if (!names.every((n) => fs.existsSync(this._cache(n)))) {
            let url = SAMSUNG_EXT_FALLBACK;
            try {
                const xml = (await download(TIZEN_EXT_INFO)).toString('utf8');
                const m = xml.match(/<name>\s*Samsung Certificate Extension\s*<\/name>[\s\S]*?<repository>\s*([^<\s]+)\s*<\/repository>/);
                if (m) url = m[1];
            } catch (e) { /* возьмём известную версию */ }
            const outer = await JSZip.loadAsync(await download(url));
            const addonName = Object.keys(outer.files).find((n) => n.endsWith('.zip'));
            const addon = await JSZip.loadAsync(await outer.files[addonName].async('nodebuffer'));
            const jarName = Object.keys(addon.files).find((n) => n.endsWith('.jar'));
            const jar = await JSZip.loadAsync(await addon.files[jarName].async('nodebuffer'));
            fs.mkdirSync(this._cache(''), { recursive: true });
            for (const n of Object.keys(jar.files)) {
                if (/\.(crt|cer)$/.test(n)) fs.writeFileSync(this._cache(path.basename(n)), await jar.files[n].async('nodebuffer'));
            }
            const missing = names.filter((n) => !fs.existsSync(this._cache(n)));
            if (missing.length) throw new Error('Samsung extension: ' + missing.join(', ') + ' not found');
        }
        return {
            authorCa: fs.readFileSync(this._cache(names[0]), 'utf8'),
            partnerCa: fs.readFileSync(this._cache(names[2]), 'utf8')
        };
    }

    // есть ли сертификат Samsung, в который вписан этот телевизор
    hasSamsungFor(duid) {
        const s = this.data.samsung;
        return !!(s && s.author && s.distributor && (s.duids || []).includes(duid));
    }

    async _samsungPost(kind, access, fields, csrPem) {
        const form = new FormData();
        form.append('access_token', access.accessToken);
        form.append('user_id', access.userId);
        form.append('platform', 'VD');
        for (const k of Object.keys(fields)) form.append(k, fields[k]);
        form.append('csr', new Blob([csrPem], { type: 'application/octet-stream' }), kind + '.csr');
        const res = await fetch(SAMSUNG_CA + '/' + kind + 's', { method: 'POST', body: form, signal: AbortSignal.timeout(90000) });
        const text = await res.text();
        if (!res.ok) throw new Error('Samsung (' + kind + ') HTTP ' + res.status + ': ' + text.slice(0, 300));
        return text;
    }

    // access = { accessToken, userId, email } — пришло со страницы входа Samsung.
    // Автор создаётся один раз; распространитель — заново, со всеми известными телевизорами.
    async createSamsung(access, duid, onStep) {
        const step = onStep || (() => {});
        const files = await this._samsungFiles();
        const s = this.data.samsung || (this.data.samsung = {});
        if (s.userId && s.userId !== access.userId) {
            // другая учётная запись Samsung — прежний автор ей не принадлежит
            delete s.author; delete s.distributor; s.duids = [];
        }
        s.userId = access.userId;
        s.password = s.password || randomPassword();

        if (!s.author) {
            step('author');
            const keys = forge.pki.rsa.generateKeyPair(2048);
            const csr = forge.pki.createCertificationRequest();
            csr.publicKey = keys.publicKey;
            csr.setSubject([{ name: 'commonName', value: 'AssisTV Installer' }]);
            csr.sign(keys.privateKey, forge.md.sha512.create());
            const pem = await this._samsungPost('author', access, {}, forge.pki.certificationRequestToPem(csr));
            s.author = toP12(keys.privateKey, [pem, files.authorCa], s.password);
            this.save();
        }

        step('distributor');
        const duids = Array.from(new Set([...(s.duids || []), duid]));
        const keys = forge.pki.rsa.generateKeyPair(2048);
        const csr = forge.pki.createCertificationRequest();
        csr.publicKey = keys.publicKey;
        csr.setSubject([{ name: 'commonName', value: 'TizenSDK' }, { name: 'emailAddress', value: access.email || 'user@example.com' }]);
        csr.setAttributes([{
            name: 'extensionRequest',
            extensions: [{
                name: 'subjectAltName',
                altNames: [{ type: 6, value: 'URN:tizen:packageid=' }].concat(duids.map((d) => ({ type: 6, value: 'URN:tizen:deviceid=' + d })))
            }]
        }]);
        csr.sign(keys.privateKey, forge.md.sha512.create());
        const csrPem = forge.pki.certificationRequestToPem(csr);
        const fields = { privilege_level: 'Partner', developer_type: 'Individual' };
        // как в tizen.js: первый ответ кладётся на TV как device-profile.xml, второй — сам сертификат
        const profileXml = await this._samsungPost('distributor', access, fields, csrPem);
        const pem = await this._samsungPost('distributor', access, fields, csrPem);
        s.distributor = toP12(keys.privateKey, [pem, files.partnerCa], s.password);
        s.deviceProfile = profileXml;
        s.duids = duids;
        this.save();
    }

    samsungProfile() {
        const s = this.data.samsung;
        return {
            kind: 'samsung',
            author: openP12(s.author, s.password),
            distributor: openP12(s.distributor, s.password),
            deviceProfile: s.deviceProfile || ''
        };
    }
}

module.exports = { Certs, SAMSUNG_LOGIN_URL };
