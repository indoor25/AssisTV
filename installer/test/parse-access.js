'use strict';
// разбор ответа Samsung: JSON и текст, скопированный из просмотрщика (поля с переводами строк)
const assert = require('assert');
process.env.ASSISTV_NO_MAIN = '1';
const { parseAccess } = require('../src/main.js');
const json = JSON.stringify({ _csrf: { token: 't' }, access_token: 'AAA111', userId: 'user1', inputEmailID: 'a@b.c', client_id: 'x' });
const viewer = 'object\n{13}\n_csrf\n{3}\ntoken\n:\n"zzz"\naccess_token\n:\n"AAA111"\ntoken_type\n:\n"bearer"\naccess_token_expires_in\n:\n"89329"\nuserId\n:\n"user1"\ninputEmailID\n:\n"a@b.c"\n';
for (const [name, text] of [['json', json], ['viewer', viewer]]) {
    const a = parseAccess(text);
    assert.deepStrictEqual(a, { accessToken: 'AAA111', userId: 'user1', email: 'a@b.c' }, name);
}
assert.strictEqual(parseAccess('nothing'), null);
console.log('OK parse-access');
