'use strict';

// TLLM*meet: moderator accounts. An admin (HOST_USERS) creates an invitation link from the home
// page and gives it to the person, who picks a username and a password on /invitation/<token>.
// A forgotten password works the same way: the admin makes a reset link for the account.
// The admin never sees nor chooses the username or the password.
//
// A moderator logs in on /login, opens rooms, runs them and their date polls, but only their own.
// Kept in DATA_DIR/moderateurs.json: scrypt password hashes, and only the hash of each link.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_MODERATORS = 100;
const MAX_INVITES = 50;
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$/;
const TOKEN = /^[A-Za-z0-9_-]{32}$/;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 36; // same limit as the login form
const NAME_MAX = 60;
const HOUR = 3600 * 1000;
const INVITE_TTL = { create: 7 * 24 * HOUR, reset: 48 * HOUR };

class ModeratorError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    return { salt, hash: crypto.scryptSync(String(password), salt, 32).toString('hex') };
}

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const newId = () => crypto.randomBytes(8).toString('hex');

// Hash used when the username is unknown, so a failed login costs the same time either way
const DUMMY = hashPassword('tllm-dummy-password');

class Moderators {
    /**
     * @param {Object} options
     * @param {string} [options.file] - JSON file (no file: kept in memory, for tests)
     * @param {(username:string) => boolean} [options.reserved] - usernames taken by HOST_USERS
     */
    constructor({ file, reserved = () => false, now = () => Date.now(), log = console } = {}) {
        this.file = file;
        this.reserved = reserved;
        this.now = now;
        this.log = log;
        this.accounts = new Map(); // username -> { id, username, displayname, salt, hash, createdAt, createdBy }
        this.invites = new Map(); // token hash -> { id, kind, displayname, account, createdAt, expiresAt, createdBy }
        this.load();
    }

    load() {
        if (!this.file) return;
        try {
            const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            for (const m of data.moderators || []) {
                if (m?.username && m.hash && m.salt) this.accounts.set(m.username, { id: newId(), ...m });
            }
            for (const i of data.invites || []) if (i?.tokenHash && i.id) this.invites.set(i.tokenHash, i);
        } catch (err) {
            if (err.code !== 'ENOENT') this.log.error('Moderators: cannot read the data file', { error: err.message });
        }
    }

    // Written at once: losing an account would lock its owner out
    save() {
        if (!this.file) return;
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            const tmp = `${this.file}.${process.pid}.tmp`;
            const invites = Array.from(this.invites, ([tokenHash, invite]) => ({ tokenHash, ...invite }));
            fs.writeFileSync(
                tmp,
                JSON.stringify({ version: 2, moderators: Array.from(this.accounts.values()), invites }),
                { mode: 0o600 }
            );
            fs.renameSync(tmp, this.file);
        } catch (err) {
            this.log.error('Moderators: cannot write the data file (is DATA_DIR writable?)', { error: err.message });
            throw new ModeratorError('Le changement n’a pas pu être enregistré.', 500);
        }
    }

    // Applies a change and saves it, or puts everything back as it was
    commit(change) {
        const accounts = new Map(Array.from(this.accounts, ([k, v]) => [k, { ...v }]));
        const invites = new Map(this.invites);
        try {
            const result = change();
            this.save();
            return result;
        } catch (err) {
            this.accounts = accounts;
            this.invites = invites;
            throw err;
        }
    }

    // ---------- accounts ----------

    // Exact match, like HOST_USERS
    get(username) {
        return typeof username === 'string' ? this.accounts.get(username) || null : null;
    }

    byId(id) {
        for (const account of this.accounts.values()) if (account.id === id) return account;
        return null;
    }

    taken(username) {
        const lower = username.toLowerCase();
        if (this.reserved(username)) return true;
        for (const name of this.accounts.keys()) if (name.toLowerCase() === lower) return true;
        return false;
    }

    static checkPassword(password, confirm) {
        if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
            throw new ModeratorError(`Le mot de passe doit faire entre ${PASSWORD_MIN} et ${PASSWORD_MAX} caractères.`);
        }
        if (password !== confirm) throw new ModeratorError('Les deux mots de passe ne sont pas identiques.');
    }

    remove(id) {
        const account = this.byId(id);
        if (!account) throw new ModeratorError('Compte introuvable.', 404);
        return this.commit(() => {
            this.accounts.delete(account.username);
            for (const [key, invite] of this.invites) if (invite.account === id) this.invites.delete(key);
            return true;
        });
    }

    // Returns the account when the password matches, else null (constant work for unknown names)
    verify(username, password) {
        if (typeof password !== 'string') return null;
        const account = this.get(username);
        const { salt, hash } = account || DUMMY;
        const actual = Buffer.from(hashPassword(password, salt).hash, 'hex');
        const ok = crypto.timingSafeEqual(actual, Buffer.from(hash, 'hex'));
        return ok && account ? account : null;
    }

    // ---------- invitation and reset links ----------

    prune() {
        const now = this.now();
        for (const [key, invite] of this.invites) if (invite.expiresAt <= now) this.invites.delete(key);
    }

    addInvite(fields, createdBy) {
        this.prune();
        if (this.invites.size >= MAX_INVITES) throw new ModeratorError('Trop de liens en attente.');
        const token = crypto.randomBytes(24).toString('base64url');
        const now = this.now();
        const invite = { id: newId(), createdAt: now, expiresAt: now + INVITE_TTL[fields.kind], createdBy, ...fields };
        this.invites.set(hashToken(token), invite);
        return { token, invite: Moderators.inviteSummary(invite) };
    }

    // Link to create an account. name: who it is for, shown to the admin and used as display name
    invite({ name } = {}, createdBy = null) {
        const displayname = (typeof name === 'string' ? name.trim() : '').slice(0, NAME_MAX);
        if (this.accounts.size >= MAX_MODERATORS) throw new ModeratorError('Trop de comptes modérateurs.');
        return this.commit(() => this.addInvite({ kind: 'create', displayname, account: null }, createdBy));
    }

    // Link to choose a new password. A new link replaces the previous one for this account
    resetLink(id, createdBy = null) {
        const account = this.byId(id);
        if (!account) throw new ModeratorError('Compte introuvable.', 404);
        return this.commit(() => {
            for (const [key, invite] of this.invites) if (invite.account === id) this.invites.delete(key);
            return this.addInvite({ kind: 'reset', displayname: account.displayname, account: id }, createdBy);
        });
    }

    cancelInvite(id) {
        const entry = Array.from(this.invites).find(([, invite]) => invite.id === id);
        if (!entry) throw new ModeratorError('Lien introuvable.', 404);
        return this.commit(() => this.invites.delete(entry[0]));
    }

    findInvite(token) {
        if (typeof token !== 'string' || !TOKEN.test(token)) return null;
        this.prune();
        const key = hashToken(token);
        const invite = this.invites.get(key);
        if (!invite) return null;
        if (invite.kind === 'reset' && !this.byId(invite.account)) {
            this.invites.delete(key);
            return null;
        }
        return { key, invite };
    }

    // What the invitation page shows
    invitation(token) {
        const found = this.findInvite(token);
        if (!found) return null;
        const { invite } = found;
        return { kind: invite.kind, name: invite.displayname || null, expiresAt: invite.expiresAt };
    }

    /**
     * Use a link: creates the account (username, password, confirm) or sets the new password
     * (password, confirm). The link works once. Returns the account.
     */
    accept(token, { username, password, confirm } = {}) {
        const found = this.findInvite(token);
        if (!found) throw new ModeratorError('Ce lien n’est plus valable. Demandez-en un nouveau.', 404);
        const { key, invite } = found;
        Moderators.checkPassword(password, confirm);

        if (invite.kind === 'reset') {
            const account = this.byId(invite.account);
            return this.commit(() => {
                Object.assign(account, hashPassword(password));
                this.invites.delete(key);
                return this.accounts.get(account.username);
            });
        }

        username = typeof username === 'string' ? username.trim() : '';
        if (!USERNAME.test(username)) {
            throw new ModeratorError(
                'L’identifiant doit faire 2 à 32 caractères : lettres sans accent, chiffres, point, tiret ou tiret bas.'
            );
        }
        if (this.taken(username))
            throw new ModeratorError('Cet identifiant est déjà pris, choisissez-en un autre.', 409);
        if (this.accounts.size >= MAX_MODERATORS) throw new ModeratorError('Trop de comptes modérateurs.');
        return this.commit(() => {
            this.accounts.set(username, {
                id: newId(),
                username,
                displayname: invite.displayname || username,
                ...hashPassword(password),
                createdAt: this.now(),
                createdBy: invite.createdBy || null,
            });
            this.invites.delete(key);
            return this.accounts.get(username);
        });
    }

    // ---------- what the admin sees (never usernames, passwords or links) ----------

    list() {
        this.prune();
        const invites = Array.from(this.invites.values());
        const moderators = Array.from(this.accounts.values())
            .sort((a, b) => a.createdAt - b.createdAt)
            .map((account) => {
                const reset = invites.find((i) => i.account === account.id);
                return {
                    id: account.id,
                    displayname: account.displayname,
                    createdAt: account.createdAt,
                    reset: reset ? Moderators.inviteSummary(reset) : null,
                };
            });
        return {
            moderators,
            invites: invites
                .filter((i) => i.kind === 'create')
                .sort((a, b) => a.createdAt - b.createdAt)
                .map(Moderators.inviteSummary),
        };
    }

    static inviteSummary(invite) {
        return { id: invite.id, kind: invite.kind, name: invite.displayname || null, expiresAt: invite.expiresAt };
    }
}

module.exports = { Moderators, ModeratorError };
