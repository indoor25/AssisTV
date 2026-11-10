'use strict';
// Пакет .wgt: прочитать config.xml, переподписать.

const JSZip = require('jszip');
const Signature = require('./vendor/packageSigner.js');

const SIGNATURE_FILE = /^(author-signature|signature\d+)\.xml$/;

const unxml = (s) => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// { name, version, appId, packageId, signed }
async function inspect(buffer) {
    let zip;
    try { zip = await JSZip.loadAsync(buffer); } catch (e) { throw Object.assign(new Error('not_wgt'), { code: 'not_wgt' }); }
    const cfg = zip.file('config.xml');
    if (!cfg) throw Object.assign(new Error('not_wgt'), { code: 'not_wgt' });
    const xml = await cfg.async('string');
    const app = xml.match(/<tizen:application\b[^>]*>/);
    const attr = (tag, name) => { const m = tag && tag.match(new RegExp('\\b' + name + '\\s*=\\s*"([^"]*)"')); return m ? unxml(m[1]) : ''; };
    const widget = xml.match(/<widget\b[^>]*>/);
    const name = xml.match(/<name\b[^>]*>([^<]*)<\/name>/);
    const info = {
        name: name ? unxml(name[1]).trim() : '',
        version: attr(widget && widget[0], 'version'),
        appId: attr(app && app[0], 'id'),
        packageId: attr(app && app[0], 'package'),
        requiredVersion: attr(app && app[0], 'required_version'),
        signed: !!(zip.file('author-signature.xml') && zip.file('signature1.xml'))
    };
    if (!info.packageId || !info.appId) throw Object.assign(new Error('not_wgt'), { code: 'not_wgt' });
    return info;
}

// profile = { author, distributor } — PKCS#12 (forge). Старые подписи выбрасываются.
async function resign(buffer, profile) {
    const zip = await JSZip.loadAsync(buffer);
    const files = [];
    for (const name of Object.keys(zip.files).sort()) {
        const f = zip.files[name];
        if (f.dir || SIGNATURE_FILE.test(name)) continue;
        files.push({ uri: encodeURIComponent(name), data: await f.async('nodebuffer') });
    }
    const withAuthor = await new Signature('AuthorSignature', files).sign(profile.author);
    const signed = await new Signature('DistributorSignature', withAuthor).sign(profile.distributor);
    const out = new JSZip();
    for (const f of signed) out.file(decodeURIComponent(f.uri), f.data);
    return out.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { inspect, resign };
