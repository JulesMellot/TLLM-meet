'use strict';

const assert = require('assert/strict');
const jwt = require('jsonwebtoken');
const { AdminAuth, makeRoomId, parseCookies, COOKIE_NAME } = require('../app/src/AdminAuth');
const { resolveClientIp, parseTrustProxy } = require('../app/src/ClientIp');

const KEY = 'k'.repeat(64);
const users = [
    { username: 'jules', password: 'S3cret-Pass', displayname: 'Jules' },
    { username: 'alice', password: 'Other-Pass1', displayname: '' },
];

function fakeRes() {
    const headers = {};
    return { headers, setHeader: (name, value) => (headers[name.toLowerCase()] = value) };
}

function cookieFrom(res) {
    return res.headers['set-cookie'].split(';')[0];
}

describe('AdminAuth (TLLM*meet admin sessions)', () => {
    it('accepts only exact HOST_USERS credentials', () => {
        const auth = new AdminAuth({ users, key: KEY });
        assert.equal(auth.verifyCredentials('jules', 'S3cret-Pass').username, 'jules');
        assert.equal(auth.verifyCredentials('jules', 's3cret-pass'), null);
        assert.equal(auth.verifyCredentials('Jules', 'S3cret-Pass'), null); // display name is not a login
        assert.equal(auth.verifyCredentials('jules', ''), null);
        assert.equal(auth.verifyCredentials('nobody', 'S3cret-Pass'), null);
        assert.equal(auth.verifyCredentials(undefined, undefined), null);
        assert.equal(auth.verifyCredentials({ username: 'jules' }, ['S3cret-Pass']), null);
    });

    it('issues an HttpOnly, Secure, SameSite=Lax cookie without credentials inside', () => {
        const auth = new AdminAuth({ users, key: KEY });
        const res = fakeRes();
        auth.issue(res, users[0]);
        const header = res.headers['set-cookie'];
        assert.match(header, new RegExp(`^${COOKIE_NAME}=`));
        assert.match(header, /HttpOnly/);
        assert.match(header, /Secure/);
        assert.match(header, /SameSite=Lax/);
        const token = cookieFrom(res).split('=')[1];
        assert.ok(!Buffer.from(token.split('.')[1], 'base64url').toString().includes('S3cret-Pass'));
    });

    it('recognises its own session from a cookie header (request and socket)', () => {
        const auth = new AdminAuth({ users, key: KEY });
        const res = fakeRes();
        auth.issue(res, users[0]);
        const cookie = `other=1; ${cookieFrom(res)}; x=y`;
        assert.equal(auth.fromRequest({ headers: { cookie } }).displayname, 'Jules');
        assert.equal(auth.fromSocket({ handshake: { headers: { cookie } } }).username, 'jules');
        assert.equal(auth.fromRequest({ headers: {} }), null);
    });

    it('rejects forged, foreign, expired and wrong-scope tokens', () => {
        const auth = new AdminAuth({ users, key: KEY });
        const good = auth.createSession(users[0]).token;
        const [h, p, sig] = good.split('.');
        const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
        const tampered = [h, Buffer.from(JSON.stringify({ ...payload, sub: 'alice' })).toString('base64url'), sig].join(
            '.'
        );
        const none = [Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'), p, ''].join('.');
        const otherKey = jwt.sign(payload, 'x'.repeat(64));
        const wrongScope = jwt.sign({ ...payload, scope: 'create-room' }, KEY);
        const expired = jwt.sign({ ...payload, exp: Math.floor(Date.now() / 1000) - 10 }, KEY);
        for (const token of [tampered, none, otherKey, wrongScope, expired, 'garbage', '']) {
            assert.equal(auth.verify(token), null, token);
        }
        assert.equal(auth.verify(good).username, 'jules');
    });

    it('invalidates a session on logout and when the password changes', () => {
        const auth = new AdminAuth({ users, key: KEY });
        const res = fakeRes();
        auth.issue(res, users[0]);
        const cookie = cookieFrom(res);
        auth.clear({ headers: { cookie } }, fakeRes());
        assert.equal(auth.fromCookieHeader(cookie), null);

        const token = auth.createSession(users[0]).token;
        const changed = new AdminAuth({
            users: [{ username: 'jules', password: 'New-Pass-2', displayname: 'Jules' }],
            key: KEY,
        });
        assert.equal(changed.verify(token), null);
        const removed = new AdminAuth({ users: [users[1]], key: KEY });
        assert.equal(removed.verify(token), null);
    });

    it('allows breakout room creation only after a presenter assigned it, and not forever', () => {
        const auth = new AdminAuth({ users, key: KEY });
        assert.equal(auth.isBreakoutAllowed('room-a_breakout_1'), false);
        auth.allowBreakout('room-a_breakout_1');
        assert.equal(auth.isBreakoutAllowed('room-a_breakout_1'), true);
        auth.allowBreakout('room-a_breakout_2', -1);
        assert.equal(auth.isBreakoutAllowed('room-a_breakout_2'), false);
    });
});

describe('makeRoomId', () => {
    it('slugifies the name and appends a random suffix', () => {
        const id = makeRoomId('Point lundi');
        assert.match(id, /^point-lundi-[a-z2-9]{6}$/);
        assert.notEqual(makeRoomId('Point lundi'), makeRoomId('Point lundi'));
    });

    it('handles accents, symbols, empty and long names', () => {
        assert.match(makeRoomId('Réunion d’équipe #3 !'), /^reunion-d-equipe-3-[a-z2-9]{6}$/);
        assert.match(makeRoomId(''), /^visio-[a-z2-9]{6}$/);
        assert.match(makeRoomId('<script>alert(1)</script>'), /^script-alert-1-script-[a-z2-9]{6}$/);
        assert.ok(makeRoomId('x'.repeat(200)).length <= 47);
        assert.doesNotMatch(makeRoomId('../../etc/passwd'), /\.\./);
    });
});

describe('parseCookies', () => {
    it('parses and keeps the first occurrence of a name', () => {
        assert.deepEqual(parseCookies('a=1; b=2; a=3'), { a: '1', b: '2' });
        assert.deepEqual(parseCookies(''), {});
        assert.deepEqual(parseCookies(undefined), {});
    });
});

describe('ClientIp (TRUST_PROXY)', () => {
    it('ignores X-Forwarded-For unless proxies are trusted', () => {
        assert.equal(
            resolveClientIp({ forwardedFor: '6.6.6.6', remoteAddress: '10.0.0.2', trustProxy: false }),
            '10.0.0.2'
        );
    });

    it('takes the address seen by the N trusted proxies, so a spoofed header is ignored', () => {
        const chain = '6.6.6.6, 1.1.1.1, 172.70.0.1'; // spoofed, real client (added by Cloudflare), Cloudflare edge
        assert.equal(resolveClientIp({ forwardedFor: chain, remoteAddress: '10.0.0.2', trustProxy: 2 }), '1.1.1.1');
        assert.equal(
            resolveClientIp({ forwardedFor: '1.1.1.1, 172.70.0.1', remoteAddress: '10.0.0.2', trustProxy: 2 }),
            '1.1.1.1'
        );
    });

    it('parses TRUST_PROXY values', () => {
        assert.equal(parseTrustProxy(undefined), false);
        assert.equal(parseTrustProxy('false'), false);
        assert.equal(parseTrustProxy('true'), true);
        assert.equal(parseTrustProxy('2'), 2);
        assert.equal(parseTrustProxy('abc'), false);
    });
});

describe('parseHostUsers (HOST_USERS)', () => {
    const { parseHostUsers } = require('../app/src/AdminAuth');

    it('parses accounts separated by |', () => {
        assert.deepEqual(parseHostUsers('jules:secret1:Jules|alice:secret2:Alice M'), [
            { username: 'jules', password: 'secret1', displayname: 'Jules' },
            { username: 'alice', password: 'secret2', displayname: 'Alice M' },
        ]);
    });

    it('ignores the quotes and spaces an admin panel may keep around the value', () => {
        const expected = [{ username: 'jules', password: 'secret1', displayname: 'Jules' }];
        assert.deepEqual(parseHostUsers('"jules:secret1:Jules"'), expected);
        assert.deepEqual(parseHostUsers("'jules:secret1:Jules'"), expected);
        assert.deepEqual(parseHostUsers('  jules:secret1:Jules \n'), expected);
        assert.deepEqual(parseHostUsers(' jules : secret1 : Jules '), expected);
    });

    it('keeps a colon inside the password when the display name is given', () => {
        assert.deepEqual(parseHostUsers('jules:pa:ss:Jules'), [
            { username: 'jules', password: 'pa:ss', displayname: 'Jules' },
        ]);
    });

    it('accepts a missing display name and skips empty entries', () => {
        assert.deepEqual(parseHostUsers('jules:secret1|'), [
            { username: 'jules', password: 'secret1', displayname: '' },
        ]);
        assert.deepEqual(parseHostUsers(''), []);
        assert.deepEqual(parseHostUsers(undefined), []);
        assert.deepEqual(parseHostUsers('""'), []);
    });
});
