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

describe('HtmlInjector asset versioning', () => {
    const path = require('path');
    const HtmlInjector = require('../app/src/HtmlInjector');
    const view = path.join(__dirname, '../public/views/Room.html');
    const versionAssets = HtmlInjector.prototype.versionAssets;

    it('adds a content hash to local JS/CSS and leaves CDN, missing and outside files alone', () => {
        const html = [
            '<script src="../js/Room.js"></script>',
            '<link href="/css/tllm.css" rel="stylesheet" />',
            '<script src="https://cdn.jsdelivr.net/npm/xss@1.0.15/dist/xss.min.js"></script>',
            '<script src="../js/DoesNotExist.js"></script>',
            '<script src="../js/../../package.json"></script>',
        ].join('\n');
        const out = versionAssets(html, view);
        assert.match(out, /src="\.\.\/js\/Room\.js\?v=[0-9a-f]{10}"/);
        assert.match(out, /href="\/css\/tllm\.css\?v=[0-9a-f]{10}"/);
        assert.ok(out.includes('xss.min.js"'));
        assert.ok(out.includes('src="../js/DoesNotExist.js"'));
        assert.ok(out.includes('src="../js/../../package.json"'));
    });
});

describe('Room polls (model)', () => {
    const Room = require('../app/src/Room');
    const fakeRoom = () => {
        const room = Object.create(Room.prototype);
        room.polls = [];
        return room;
    };

    it('keys votes by participant, so two people with the same name both count', () => {
        const room = fakeRoom();
        const { id } = room.createPoll('Q?', ['A', 'B']);
        assert.ok(room.votePoll(id, 'sock-1', 'Jean', 'A'));
        assert.ok(room.votePoll(id, 'sock-2', 'Jean', ['B']));
        const [view] = room.pollsView('sock-1', true);
        assert.deepEqual(view.counts, [1, 1]);
        assert.deepEqual(view.voters, [
            { name: 'Jean', choices: ['A'] },
            { name: 'Jean', choices: ['B'] },
        ]);
        assert.deepEqual(view.myVotes, ['A']);
    });

    it('hides voters from non-presenters and refuses unknown options or closed polls', () => {
        const room = fakeRoom();
        const poll = room.createPoll('Q?', ['A', 'B']);
        assert.equal(room.votePoll(poll.id, 's', 'X', 'C'), false);
        assert.equal(room.votePoll(poll.id, 's', 'X', ['A', 'C']), false);
        room.votePoll(poll.id, 's', 'X', 'A');
        assert.equal(room.pollsView('other', false)[0].voters, null);
        room.closePoll(poll.id);
        assert.equal(room.votePoll(poll.id, 's2', 'Y', 'B'), false);
    });

    it('takes one answer, or several when the poll allows it, and lets a vote be withdrawn', () => {
        const room = fakeRoom();
        const single = room.createPoll('Q?', ['A', 'B', 'C']);
        assert.equal(room.votePoll(single.id, 's', 'X', ['A', 'B']), false);
        const multi = room.createPoll('Q2?', ['A', 'B', 'C'], { multiple: true });
        assert.ok(room.votePoll(multi.id, 's1', 'X', ['A', 'C']));
        assert.ok(room.votePoll(multi.id, 's2', 'Y', ['C']));
        assert.equal(room.votePoll(multi.id, 's2', 'Y', ['C', 'C']), false, 'no double vote');
        let view = room.pollsView('s1')[1];
        assert.deepEqual(view.counts, [1, 0, 2]);
        assert.equal(view.total, 2, 'people, not answers');
        assert.ok(room.votePoll(multi.id, 's1', 'X', []));
        view = room.pollsView('s1')[1];
        assert.deepEqual(view.counts, [0, 0, 1]);
        assert.deepEqual(view.myVotes, []);
    });

    it('never keeps names in an anonymous poll, even for presenters', () => {
        const room = fakeRoom();
        const poll = room.createPoll('Q?', ['A', 'B'], { anonymous: true });
        room.votePoll(poll.id, 's1', 'Jean', 'A');
        assert.equal(poll.voters.get('s1').name, null);
        const [view] = room.pollsView('admin', true);
        assert.equal(view.voters, null);
        assert.deepEqual(view.counts, [1, 0]);
    });

    it('hides the results from participants until the poll is closed', () => {
        const room = fakeRoom();
        const poll = room.createPoll('Q?', ['A', 'B'], { hideResults: true });
        room.votePoll(poll.id, 's1', 'Jean', 'A');
        let view = room.pollsView('s1', false)[0];
        assert.equal(view.counts, null);
        assert.equal(view.total, 1);
        assert.deepEqual(view.myVotes, ['A']);
        assert.deepEqual(room.pollsView('admin', true)[0].counts, [1, 0]);
        room.closePoll(poll.id);
        view = room.pollsView('s1', false)[0];
        assert.deepEqual(view.counts, [1, 0]);
    });

    it('can be edited until the first vote only', () => {
        const room = fakeRoom();
        const { id } = room.createPoll('Q?', ['A', 'B']);
        assert.ok(room.editPoll(id, 'Q2?', ['A', 'C']));
        assert.equal(room.pollsView('s1')[0].editable, true);
        room.votePoll(id, 's1', 'X', 'A');
        assert.equal(room.editPoll(id, 'Q3?', ['A', 'D']), false);
        const [view] = room.pollsView('s1');
        assert.equal(view.question, 'Q2?');
        assert.equal(view.editable, false);
    });

    it('closes on its own after the chosen delay', async () => {
        const room = fakeRoom();
        let closedBy = null;
        const poll = room.createPoll('Q?', ['A', 'B'], { durationMs: 40 }, (p) => (closedBy = p.id));
        assert.ok(poll.closesAt > Date.now());
        await new Promise((r) => setTimeout(r, 80));
        assert.equal(poll.closed, true);
        assert.equal(closedBy, poll.id);
        const other = room.createPoll('Q2?', ['A', 'B'], { durationMs: 40 }, () => (closedBy = 'other'));
        room.deletePoll(other.id);
        await new Promise((r) => setTimeout(r, 80));
        assert.equal(closedBy, poll.id, 'a deleted poll does not fire');
    });
});
