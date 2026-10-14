'use strict';

const rateLimit = require('express-rate-limit');
const config = require('../config');

const MINUTE_MS = 60 * 1000;

const { ipFromRequest } = require('../ClientIp');

// Extract client IP (X-Forwarded-For is only trusted per TRUST_PROXY, see ClientIp.js)
const ipKeyGenerator = (req) => ipFromRequest(req, config?.server?.trustProxy);

// Pluralize "N minute(s)" consistently across limiter messages
const minutesLabel = (n) => `${n} minute${n === 1 ? '' : 's'}`;

const toMinutes = (windowMs) => Math.ceil(windowMs / MINUTE_MS);

/**
 * Build an express-rate-limit middleware keyed per IP with standard headers.
 * `messageKey` is the response body property holding the message ('error' | 'message').
 */
function createIpLimiter({ windowMs, max, text, messageKey = 'error' }) {
    return rateLimit({
        windowMs,
        max,
        standardHeaders: true,
        legacyHeaders: false,
        message: { [messageKey]: `${text} Please try again after ${minutesLabel(toMinutes(windowMs))}.` },
        keyGenerator: (req) => ipKeyGenerator(req),
    });
}

/**
 * In-memory sliding window limiter (per key), used for Socket.IO events.
 * Returns true if the hit is allowed, false if the limit is exceeded.
 */
function createSlidingWindowLimiter({ windowMs, max }) {
    const hitsByKey = new Map(); // key -> number[] (timestamps)

    // Periodic cleanup to bound memory.
    setInterval(
        () => {
            const cutoff = Date.now() - windowMs;
            for (const [key, hits] of hitsByKey) {
                const kept = hits.filter((t) => t > cutoff);
                if (kept.length === 0) hitsByKey.delete(key);
                else hitsByKey.set(key, kept);
            }
        },
        Math.max(windowMs, MINUTE_MS)
    ).unref?.();

    return function check(key) {
        const now = Date.now();
        const windowStart = now - windowMs;
        const hits = (hitsByKey.get(key) || []).filter((t) => t > windowStart);
        if (hits.length >= max) {
            hitsByKey.set(key, hits);
            return false;
        }
        hits.push(now);
        hitsByKey.set(key, hits);
        return true;
    };
}

/**
 * Create all application rate limiters from the config.
 * @param {Object} deps
 * @param {(req) => string} deps.getRequesterKey - per-requester key (admin session > IP)
 */
function createRateLimiters({ getRequesterKey }) {
    // Login attempts: failures only, per username+IP and, more loosely, per username
    // (so one IP cannot brute-force, and many IPs together are still capped).
    const maxAttempts = parseInt(config?.security?.host?.maxAttempts, 10) || 5;
    const minBlockTime = parseInt(config?.security?.host?.minBlockTime, 10) || 15; // minutes
    const loginMessage = {
        message: `Too many login attempts. Please try again after ${minutesLabel(minBlockTime)}.`,
    };
    const loginUsername = (req) =>
        typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase().slice(0, 64) : '';
    const loginLimiter = rateLimit({
        windowMs: minBlockTime * MINUTE_MS,
        max: maxAttempts,
        skipSuccessfulRequests: true,
        standardHeaders: true,
        legacyHeaders: false,
        message: loginMessage,
        keyGenerator: (req) => `${loginUsername(req)}|${ipKeyGenerator(req)}`,
    });
    const loginUserLimiter = rateLimit({
        windowMs: minBlockTime * MINUTE_MS,
        max: maxAttempts * 6,
        skipSuccessfulRequests: true,
        standardHeaders: true,
        legacyHeaders: false,
        message: loginMessage,
        keyGenerator: (req) => `user:${loginUsername(req)}`,
    });

    // Waiting page polls /isRoomActive every few seconds; cap probing of room names
    const roomStatusLimiter = createIpLimiter({
        windowMs: MINUTE_MS,
        max: 120,
        text: 'Too many requests.',
        messageKey: 'message',
    });

    // createRoom (per IP), shared by Socket.IO `createRoom` and HTTP /createRoomToken.
    // Prevents unauthenticated sockets from spamming arbitrary room entries
    // into the in-memory roomList.
    const createRoomCfg = config.features?.createRoomRateLimit || {};
    const createRoomWindowMs = createRoomCfg.windowMs || MINUTE_MS;
    const createRoomMax = createRoomCfg.max || 10;
    const createRoomLimiterMinutes = toMinutes(createRoomWindowMs);

    // The endpoint runs the room creation policy (join token / user lookups), so cap request volume.
    const createRoomTokenLimiter = createIpLimiter({
        windowMs: createRoomWindowMs,
        max: createRoomMax,
        text: 'Too many room token requests.',
        messageKey: 'message',
    });

    const checkCreateRoomLimit = createSlidingWindowLimiter({ windowMs: createRoomWindowMs, max: createRoomMax });

    return {
        loginLimiter,
        loginUserLimiter,
        roomStatusLimiter,
        createRoomTokenLimiter,
        checkCreateRoomLimit,
        createRoomLimiterMinutes,
    };
}

module.exports = { createRateLimiters, ipKeyGenerator, minutesLabel };
