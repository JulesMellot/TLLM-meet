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

function fakeRes() {
    const headers = {};
    return { headers, setHeader: (name, value) => (headers[name.toLowerCase()] = value) };
}

function sessionOf(auth, user) {
    const res = fakeRes();
    auth.issue(res, user);
    return { headers: { cookie: res.headers['set-cookie'].split(';')[0] } };
}

describe('test-Moderators (comptes modérateurs)', () => {
    it('creates an account and checks its password', () => {
        const mods = new Moderators({ reserved });
        const account = mods.create(
            { username: 'camille', password: 'Camille-Pass', displayname: ' Camille ' },
            'jules'
        );
        assert.deepEqual(Object.keys(account).sort(), ['createdAt', 'createdBy', 'displayname', 'username']);
        assert.equal(account.displayname, 'Camille');
        assert.equal(account.createdBy, 'jules');
        assert.equal(mods.verify('camille', 'Camille-Pass').username, 'camille');
        assert.equal(mods.verify('camille', 'camille-pass'), null);
        assert.equal(mods.verify('Camille', 'Camille-Pass'), null);
        assert.equal(mods.verify('nobody', 'Camille-Pass'), null);
        assert.equal(mods.verify('camille', undefined), null);
    });

    it('rejects admin usernames, duplicates, weak passwords and odd usernames', () => {
        const mods = new Moderators({ reserved });
        mods.create({ username: 'camille', password: 'Camille-Pass' });
        const cases = [
            [{ username: 'jules', password: 'Long-enough-1' }, 409],
            [{ username: 'JULES', password: 'Long-enough-1' }, 409],
            [{ username: 'Camille', password: 'Long-enough-1' }, 409],
            [{ username: 'eve', password: 'short' }, 400],
            [{ username: 'eve', password: 'x'.repeat(37) }, 400],
            [{ username: 'e', password: 'Long-enough-1' }, 400],
            [{ username: 'a b', password: 'Long-enough-1' }, 400],
            [{ username: 'élodie', password: 'Long-enough-1' }, 400],
            [{ username: ['eve'], password: 'Long-enough-1' }, 400],
        ];
        for (const [input, status] of cases) {
            assert.throws(
                () => mods.create(input),
                (err) => err instanceof ModeratorError && err.status === status,
                JSON.stringify(input)
            );
        }
        assert.equal(mods.list().length, 1);
    });

    it('stores hashes only, and keeps the accounts across restarts', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tllm-mods-'));
        const file = path.join(dir, 'moderateurs.json');
        const mods = new Moderators({ file, reserved });
        mods.create({ username: 'camille', password: 'Camille-Pass' });
        const raw = fs.readFileSync(file, 'utf8');
        assert.ok(!raw.includes('Camille-Pass'));
        assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
        const again = new Moderators({ file, reserved });
        assert.equal(again.verify('camille', 'Camille-Pass').username, 'camille');
        again.remove('camille');
        assert.equal(new Moderators({ file }).list().length, 0);
    });

    it('changes a password and removes an account', () => {
        const mods = new Moderators({ reserved });
        mods.create({ username: 'camille', password: 'Camille-Pass' });
        mods.setPassword('camille', 'Camille-New-1');
        assert.equal(mods.verify('camille', 'Camille-Pass'), null);
        assert.equal(mods.verify('camille', 'Camille-New-1').username, 'camille');
        assert.throws(() => mods.setPassword('camille', 'short'), ModeratorError);
        assert.throws(
            () => mods.setPassword('nobody', 'Long-enough-1'),
            (err) => err.status === 404
        );
        mods.remove('camille');
        assert.equal(mods.verify('camille', 'Camille-New-1'), null);
        assert.throws(
            () => mods.remove('camille'),
            (err) => err.status === 404
        );
    });

    describe('with AdminAuth', () => {
        it('logs a moderator in with the moderator role, and an admin with the admin role', () => {
            const mods = new Moderators({ reserved });
            mods.create({ username: 'camille', password: 'Camille-Pass', displayname: 'Camille' });
            const auth = new AdminAuth({ users: admins, key: KEY, moderators: mods });
            const mod = auth.verifyCredentials('camille', 'Camille-Pass');
            assert.equal(auth.fromRequest(sessionOf(auth, mod)).role, 'moderator');
            assert.equal(auth.fromRequest(sessionOf(auth, mod)).displayname, 'Camille');
            const admin = auth.verifyCredentials('jules', 'S3cret-Pass');
            assert.equal(auth.fromRequest(sessionOf(auth, admin)).role, 'admin');
            assert.equal(auth.verifyCredentials('camille', 'S3cret-Pass'), null);
        });

        it('closes the moderator session when the password changes or the account is removed', () => {
            const mods = new Moderators({ reserved });
            mods.create({ username: 'camille', password: 'Camille-Pass' });
            const auth = new AdminAuth({ users: admins, key: KEY, moderators: mods });
            const req = sessionOf(auth, auth.verifyCredentials('camille', 'Camille-Pass'));
            assert.ok(auth.fromRequest(req));
            mods.setPassword('camille', 'Camille-New-1');
            assert.equal(auth.fromRequest(req), null);
            const req2 = sessionOf(auth, auth.verifyCredentials('camille', 'Camille-New-1'));
            assert.ok(auth.fromRequest(req2));
            mods.remove('camille');
            assert.equal(auth.fromRequest(req2), null);
        });

        it('never lets a moderator session pass for an admin of the same name', () => {
            // An account created before the same name was added to HOST_USERS
            const mods = new Moderators();
            mods.create({ username: 'alice', password: 'Alice-Mod-Pass' });
            const before = new AdminAuth({ users: admins, key: KEY, moderators: mods });
            const req = sessionOf(before, before.verifyCredentials('alice', 'Alice-Mod-Pass'));
            const after = new AdminAuth({
                users: [...admins, { username: 'alice', password: 'Alice-Admin-Pass' }],
                key: KEY,
                moderators: mods,
            });
            assert.equal(after.fromRequest(req), null);
            assert.equal(after.verifyCredentials('alice', 'Alice-Admin-Pass').username, 'alice');
            assert.equal(after.verifyCredentials('alice', 'Alice-Mod-Pass'), null);
        });
    });
});
