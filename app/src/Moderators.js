'use strict';

// TLLM*meet: moderator accounts. The admins listed in HOST_USERS create them from the home page.
// A moderator logs in on /login like an admin and does what an admin does (open rooms, be
// presenter, run date polls), but cannot manage accounts.
// Kept in DATA_DIR/moderateurs.json. Passwords are stored as scrypt hashes, never in clear.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_MODERATORS = 100;
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$/;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 36; // same limit as the login form
const NAME_MAX = 60;

class ModeratorError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    return { salt, hash: crypto.scryptSync(String(password), salt, 32).toString('hex') };
}

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
        this.accounts = new Map(); // username -> { username, displayname, salt, hash, createdAt, createdBy }
        this.load();
    }

    load() {
        if (!this.file) return;
        try {
            const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            for (const m of data.moderators || [])
                if (m?.username && m.hash && m.salt) this.accounts.set(m.username, m);
        } catch (err) {
            if (err.code !== 'ENOENT') this.log.error('Moderators: cannot read the data file', { error: err.message });
        }
    }

    // Accounts are written at once: losing one would lock its owner out
    save() {
        if (!this.file) return;
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            const tmp = `${this.file}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({ version: 1, moderators: Array.from(this.accounts.values()) }), {
                mode: 0o600,
            });
            fs.renameSync(tmp, this.file);
        } catch (err) {
            this.log.error('Moderators: cannot write the data file (is DATA_DIR writable?)', { error: err.message });
            throw new ModeratorError('Le compte n’a pas pu être enregistré.', 500);
        }
    }

    static checkPassword(password) {
        if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
            throw new ModeratorError(`Le mot de passe doit faire entre ${PASSWORD_MIN} et ${PASSWORD_MAX} caractères.`);
        }
    }

    // Exact match, like HOST_USERS
    get(username) {
        return typeof username === 'string' ? this.accounts.get(username) || null : null;
    }

    taken(username) {
        const lower = username.toLowerCase();
        if (this.reserved(username)) return true;
        for (const name of this.accounts.keys()) if (name.toLowerCase() === lower) return true;
        return false;
    }

    create({ username, password, displayname } = {}, createdBy = null) {
        username = typeof username === 'string' ? username.trim() : '';
        if (!USERNAME.test(username)) {
            throw new ModeratorError(
                'L’identifiant doit faire 2 à 32 caractères : lettres sans accent, chiffres, point, tiret ou tiret bas.'
            );
        }
        Moderators.checkPassword(password);
        if (this.taken(username)) throw new ModeratorError('Cet identifiant est déjà pris.', 409);
        if (this.accounts.size >= MAX_MODERATORS) throw new ModeratorError('Trop de comptes modérateurs.');
        const account = {
            username,
            displayname: (typeof displayname === 'string' ? displayname.trim() : '').slice(0, NAME_MAX) || username,
            ...hashPassword(password),
            createdAt: this.now(),
            createdBy,
        };
        this.accounts.set(username, account);
        try {
            this.save();
        } catch (err) {
            this.accounts.delete(username);
            throw err;
        }
        return Moderators.summary(account);
    }

    setPassword(username, password) {
        const account = this.get(username);
        if (!account) throw new ModeratorError('Compte introuvable.', 404);
        Moderators.checkPassword(password);
        const previous = { salt: account.salt, hash: account.hash };
        Object.assign(account, hashPassword(password));
        try {
            this.save();
        } catch (err) {
            Object.assign(account, previous);
            throw err;
        }
        return Moderators.summary(account);
    }

    remove(username) {
        const account = this.get(username);
        if (!account) throw new ModeratorError('Compte introuvable.', 404);
        this.accounts.delete(username);
        try {
            this.save();
        } catch (err) {
            this.accounts.set(username, account);
            throw err;
        }
        return true;
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

    list() {
        return Array.from(this.accounts.values())
            .sort((a, b) => a.createdAt - b.createdAt)
            .map(Moderators.summary);
    }

    static summary(account) {
        return {
            username: account.username,
            displayname: account.displayname,
            createdAt: account.createdAt,
            createdBy: account.createdBy || null,
        };
    }
}

module.exports = { Moderators, ModeratorError };
