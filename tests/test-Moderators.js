'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Moderators, ModeratorError } = require('../app/src/Moderators');
const { AdminAuth } = require('../app/src/AdminAuth');

const KEY = 'k'.repeat(64);
const admins = [{ username: 'jules', password: 'S3cret-Pass', displayname: 'Jules' }];
const reserved = (name) => admins.some((u) => u.username.toLowerCase() === name.toLowerCase());
const PASS = 'Camille-Pass';

function fakeRes() {
    const headers = {};
    return { headers, setHeader: (name, value) => (headers[name.toLowerCase()] = value) };
}

function sessionOf(auth, user) {
    const res = fakeRes();
    auth.issue(res, user);
    return { headers: { cookie: res.headers['set-cookie'].split(';')[0] } };
}

// An admin makes a link, the person uses it
function newModerator(mods, username = 'camille', name = 'Camille') {
    const { token } = mods.invite({ name }, 'jules');
    return mods.accept(token, { username, password: PASS, confirm: PASS });
}

const fails = (fn, status) => assert.throws(fn, (err) => err instanceof ModeratorError && err.status === status);

describe('test-Moderators (comptes modérateurs)', () => {
    it('creates the account from an invitation link, the person choosing username and password', () => {
        const mods = new Moderators({ reserved });
        const { token, invite } = mods.invite({ name: ' Camille ' }, 'jules');
        assert.match(token, /^[A-Za-z0-9_-]{32}$/);
        assert.deepEqual(Object.keys(invite).sort(), ['expiresAt', 'id', 'kind', 'name']);
        assert.deepEqual(mods.invitation(token).kind, 'create');
        assert.equal(mods.invitation(token).name, 'Camille');

        const account = mods.accept(token, { username: 'camille', password: PASS, confirm: PASS });
        assert.equal(account.displayname, 'Camille');
        assert.equal(account.createdBy, 'jules');
        assert.equal(mods.verify('camille', PASS).username, 'camille');
        assert.equal(mods.verify('camille', 'camille-pass'), null);
        assert.equal(mods.verify('nobody', PASS), null);
        assert.equal(mods.verify('camille', undefined), null);
    });

    it('uses a link once only, and not after it expired or was cancelled', () => {
        let now = 1000;
        const mods = new Moderators({ reserved, now: () => now });
        const { token } = mods.invite({}, 'jules');
        mods.accept(token, { username: 'camille', password: PASS, confirm: PASS });
        assert.equal(mods.invitation(token), null);
        fails(() => mods.accept(token, { username: 'eve', password: PASS, confirm: PASS }), 404);

        const late = mods.invite({}, 'jules').token;
        now += 8 * 24 * 3600 * 1000;
        assert.equal(mods.invitation(late), null);
        fails(() => mods.accept(late, { username: 'eve', password: PASS, confirm: PASS }), 404);

        const cancelled = mods.invite({}, 'jules');
        mods.cancelInvite(cancelled.invite.id);
        assert.equal(mods.invitation(cancelled.token), null);
        assert.equal(mods.invitation('x'.repeat(32)), null);
        assert.equal(mods.invitation('../../etc/passwd'), null);
    });

    it('rejects admin usernames, duplicates, odd usernames, weak or mismatched passwords', () => {
        const mods = new Moderators({ reserved });
        newModerator(mods);
        const { token } = mods.invite({}, 'jules');
        const cases = [
            [{ username: 'jules', password: PASS, confirm: PASS }, 409],
            [{ username: 'JULES', password: PASS, confirm: PASS }, 409],
            [{ username: 'Camille', password: PASS, confirm: PASS }, 409],
            [{ username: 'eve', password: 'short', confirm: 'short' }, 400],
            [{ username: 'eve', password: 'x'.repeat(37), confirm: 'x'.repeat(37) }, 400],
            [{ username: 'eve', password: PASS, confirm: PASS + '!' }, 400],
            [{ username: 'eve', password: PASS }, 400],
            [{ username: 'e', password: PASS, confirm: PASS }, 400],
            [{ username: 'a b', password: PASS, confirm: PASS }, 400],
            [{ username: 'élodie', password: PASS, confirm: PASS }, 400],
            [{ username: ['eve'], password: PASS, confirm: PASS }, 400],
        ];
        for (const [input, status] of cases) fails(() => mods.accept(token, input), status);
        // the link still works after mistakes
        assert.equal(mods.accept(token, { username: 'eve', password: PASS, confirm: PASS }).username, 'eve');
    });

    it('sets a new password from a reset link; a new link replaces the previous one', () => {
        const mods = new Moderators({ reserved });
        const account = newModerator(mods);
        const first = mods.resetLink(account.id, 'jules').token;
        const { token } = mods.resetLink(account.id, 'jules');
        assert.equal(mods.invitation(first), null);
        assert.deepEqual(mods.invitation(token).kind, 'reset');
        fails(() => mods.accept(token, { password: 'Nouveau-Pass', confirm: 'Autre-Pass' }), 400);
        mods.accept(token, { password: 'Nouveau-Pass', confirm: 'Nouveau-Pass', username: 'ignored' });
        assert.equal(mods.verify('camille', PASS), null);
        assert.equal(mods.verify('camille', 'Nouveau-Pass').username, 'camille');
        assert.equal(mods.get('ignored'), null);
        fails(() => mods.resetLink('nope', 'jules'), 404);
    });

    it('shows the admin names and pending links, never usernames, passwords or links', () => {
        const mods = new Moderators({ reserved });
        const account = newModerator(mods);
        const reset = mods.resetLink(account.id, 'jules');
        const invite = mods.invite({ name: 'Dominique' }, 'jules');
        const list = mods.list();
        const text = JSON.stringify(list);
        for (const secret of ['camille', PASS, reset.token, invite.token]) assert.ok(!text.includes(secret), secret);
        assert.equal(list.moderators[0].displayname, 'Camille');
        assert.equal(list.moderators[0].reset.kind, 'reset');
        assert.deepEqual(
            list.invites.map((i) => i.name),
            ['Dominique']
        );
    });

    it('removes an account with its pending links', () => {
        const mods = new Moderators({ reserved });
        const account = newModerator(mods);
        const { token } = mods.resetLink(account.id, 'jules');
        mods.remove(account.id);
        assert.equal(mods.verify('camille', PASS), null);
        assert.equal(mods.invitation(token), null);
        fails(() => mods.remove(account.id), 404);
    });

    it('stores hashes only, and keeps accounts and links across restarts', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tllm-mods-'));
        const file = path.join(dir, 'moderateurs.json');
        const mods = new Moderators({ file, reserved });
        newModerator(mods);
        const { token } = mods.invite({}, 'jules');
        const raw = fs.readFileSync(file, 'utf8');
        assert.ok(!raw.includes(PASS));
        assert.ok(!raw.includes(token));
        assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
        const again = new Moderators({ file, reserved });
        assert.equal(again.verify('camille', PASS).username, 'camille');
        assert.equal(again.invitation(token).kind, 'create');
    });

    describe('with AdminAuth', () => {
        it('logs a moderator in with the moderator role, and an admin with the admin role', () => {
            const mods = new Moderators({ reserved });
            newModerator(mods);
            const auth = new AdminAuth({ users: admins, key: KEY, moderators: mods });
            const mod = auth.verifyCredentials('camille', PASS);
            assert.equal(auth.fromRequest(sessionOf(auth, mod)).role, 'moderator');
            assert.equal(auth.fromRequest(sessionOf(auth, mod)).displayname, 'Camille');
            const admin = auth.verifyCredentials('jules', 'S3cret-Pass');
            assert.equal(auth.fromRequest(sessionOf(auth, admin)).role, 'admin');
            assert.equal(auth.verifyCredentials('camille', 'S3cret-Pass'), null);
        });

        it('closes the moderator session when the password changes or the account is removed', () => {
            const mods = new Moderators({ reserved });
            const account = newModerator(mods);
            const auth = new AdminAuth({ users: admins, key: KEY, moderators: mods });
            const req = sessionOf(auth, auth.verifyCredentials('camille', PASS));
            assert.ok(auth.fromRequest(req));
            const { token } = mods.resetLink(account.id, 'jules');
            assert.ok(auth.fromRequest(req), 'a pending link does not log anyone out');
            mods.accept(token, { password: 'Nouveau-Pass', confirm: 'Nouveau-Pass' });
            assert.equal(auth.fromRequest(req), null);
            const req2 = sessionOf(auth, auth.verifyCredentials('camille', 'Nouveau-Pass'));
            assert.ok(auth.fromRequest(req2));
            mods.remove(account.id);
            assert.equal(auth.fromRequest(req2), null);
        });

        it('never lets a moderator session pass for an admin of the same name', () => {
            // An account created before the same name was added to HOST_USERS
            const mods = new Moderators();
            newModerator(mods, 'alice', 'Alice');
            const before = new AdminAuth({ users: admins, key: KEY, moderators: mods });
            const req = sessionOf(before, before.verifyCredentials('alice', PASS));
            const after = new AdminAuth({
                users: [...admins, { username: 'alice', password: 'Alice-Admin-Pass' }],
                key: KEY,
                moderators: mods,
            });
            assert.equal(after.fromRequest(req), null);
            assert.equal(after.verifyCredentials('alice', 'Alice-Admin-Pass').username, 'alice');
            assert.equal(after.verifyCredentials('alice', PASS), null);
        });
    });
});
