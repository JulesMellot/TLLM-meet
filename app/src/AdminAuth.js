'use strict';

/**
 * TLLM*meet - Admin sessions
 *
 * Only an admin (an account listed in HOST_USERS) may create rooms. The admin logs in once
 * through POST /login and receives a signed session cookie. Every privileged decision
 * (room creation, presenter role) is taken server-side from that cookie: never from the
 * requester IP, the typed display name or a client-side flag.
 *
 * The cookie is HttpOnly, Secure and SameSite=Lax, so page scripts cannot read it and
 * cross-site requests (fetch, WebSocket) do not carry it.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const COOKIE_NAME = 'tllm_admin';
const SCOPE = 'admin-session';
const JWT_OPTIONS = { algorithms: ['HS256'] };

function sha256(value) {
    return crypto.createHash('sha256').update(String(value)).digest();
}

// Constant-time string comparison (hash first so lengths always match)
function safeEqual(a, b) {
    return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function parseCookies(header) {
    const cookies = {};
    if (!header || typeof header !== 'string') return cookies;
    for (const part of header.split(';')) {
        const index = part.indexOf('=');
        if (index < 0) continue;
        const name = part.slice(0, index).trim();
        if (!name || name in cookies) continue;
        try {
            cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
        } catch {
            cookies[name] = part.slice(index + 1).trim();
        }
    }
    return cookies;
}

class AdminAuth {
    /**
     * @param {Object} options
     * @param {Array<{username:string,password:string,displayname?:string}>} options.users - HOST_USERS
     * @param {string} options.key - secret used to sign sessions (derived from JWT_SECRET)
     * @param {number} [options.sessionHours=12] - session lifetime
     */
    constructor({ users, key, sessionHours = 12 }) {
        if (!key) throw new Error('AdminAuth: missing signing key');
        this.users = Array.isArray(users) ? users.filter((u) => u && u.username && u.password) : [];
        this.key = key;
        this.sessionHours = Number(sessionHours) > 0 ? Number(sessionHours) : 12;
        this.revoked = new Map(); // sid -> expiry (ms)
        this.breakouts = new Map(); // breakout room id -> expiry (ms)
    }

    get cookieName() {
        return COOKIE_NAME;
    }

    hasAdmins() {
        return this.users.length > 0;
    }

    // Fingerprint of the credentials: changing the password in HOST_USERS invalidates open sessions
    fingerprint(user) {
        return crypto
            .createHmac('sha256', this.key)
            .update(`${user.username}\0${user.password}`)
            .digest('hex')
            .slice(0, 32);
    }

    findUser(username) {
        return this.users.find((u) => u.username === username) || null;
    }

    /**
     * Check a username/password pair against HOST_USERS.
     * Always walks the whole list so timing does not reveal which usernames exist.
     */
    verifyCredentials(username, password) {
        if (typeof username !== 'string' || typeof password !== 'string') return null;
        let match = null;
        for (const user of this.users) {
            const userOk = safeEqual(user.username, username);
            const passOk = safeEqual(user.password, password);
            if (userOk && passOk && !match) match = user;
        }
        return match;
    }

    createSession(user) {
        const sid = crypto.randomBytes(16).toString('hex');
        const token = jwt.sign({ scope: SCOPE, sub: user.username, fp: this.fingerprint(user), sid }, this.key, {
            algorithm: 'HS256',
            expiresIn: `${this.sessionHours}h`,
        });
        return { token, sid };
    }

    cookieHeader(value, maxAgeSeconds) {
        return [
            `${COOKIE_NAME}=${value}`,
            'Path=/',
            'HttpOnly',
            'Secure',
            'SameSite=Lax',
            `Max-Age=${maxAgeSeconds}`,
        ].join('; ');
    }

    issue(res, user) {
        const { token } = this.createSession(user);
        res.setHeader('Set-Cookie', this.cookieHeader(token, this.sessionHours * 3600));
        return token;
    }

    clear(req, res) {
        const session = this.verify(parseCookies(req?.headers?.cookie)[COOKIE_NAME]);
        if (session) this.revoked.set(session.sid, session.exp * 1000);
        res.setHeader('Set-Cookie', this.cookieHeader('', 0));
    }

    /**
     * Verify a session token. Returns { username, displayname, sid, exp } or null.
     */
    verify(token) {
        if (!token || typeof token !== 'string') return null;
        let decoded;
        try {
            decoded = jwt.verify(token, this.key, JWT_OPTIONS);
        } catch {
            return null;
        }
        if (!decoded || decoded.scope !== SCOPE || !decoded.sub || !decoded.sid) return null;
        this.pruneRevoked();
        if (this.revoked.has(decoded.sid)) return null;
        const user = this.findUser(decoded.sub);
        if (!user || !safeEqual(this.fingerprint(user), String(decoded.fp || ''))) return null;
        return {
            username: user.username,
            displayname: user.displayname || user.username,
            sid: decoded.sid,
            exp: decoded.exp,
        };
    }

    fromCookieHeader(header) {
        return this.verify(parseCookies(header)[COOKIE_NAME]);
    }

    fromRequest(req) {
        return this.fromCookieHeader(req?.headers?.cookie);
    }

    fromSocket(socket) {
        return this.fromCookieHeader(socket?.handshake?.headers?.cookie);
    }

    pruneRevoked(now = Date.now()) {
        for (const [sid, exp] of this.revoked) if (exp <= now) this.revoked.delete(sid);
        for (const [room, exp] of this.breakouts) if (exp <= now) this.breakouts.delete(room);
    }

    // A presenter assigned participants to this breakout room: their browsers may create it
    allowBreakout(roomId, ttlMs = 6 * 60 * 60 * 1000) {
        this.breakouts.set(String(roomId), Date.now() + ttlMs);
    }

    isBreakoutAllowed(roomId) {
        this.pruneRevoked();
        return this.breakouts.has(String(roomId));
    }
}

/**
 * Normalize a room name typed by the admin and append a random suffix,
 * e.g. "Point lundi" -> "point-lundi-k7f2ab".
 */
function makeRoomId(name, suffixLength = 6) {
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o/1/l/i
    const base = String(name || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
        .replace(/-+$/g, '');
    let suffix = '';
    const bytes = crypto.randomBytes(suffixLength);
    for (let i = 0; i < suffixLength; i++) suffix += alphabet[bytes[i] % alphabet.length];
    return base ? `${base}-${suffix}` : `visio-${suffix}`;
}

module.exports = { AdminAuth, makeRoomId, parseCookies, COOKIE_NAME };
