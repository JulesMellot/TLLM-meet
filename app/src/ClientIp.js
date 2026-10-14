'use strict';

/**
 * Resolve the client IP behind reverse proxies.
 *
 * TRUST_PROXY:
 * - unset / false : ignore X-Forwarded-For, use the socket address
 * - true          : legacy behaviour, trust the left-most X-Forwarded-For entry (spoofable)
 * - N (number)    : trust exactly N proxies in front of the app and take the address they saw.
 *                   Cloudflare + Coolify (Traefik) => TRUST_PROXY=2. A client cannot spoof this,
 *                   because the trusted proxies append to the right of whatever it sends.
 */

function parseTrustProxy(value) {
    if (value === undefined || value === null || value === '' || value === false || value === 'false') return false;
    if (value === true || value === 'true') return true;
    const hops = parseInt(value, 10);
    return Number.isInteger(hops) && hops > 0 ? hops : false;
}

function normalize(ip) {
    if (!ip) return '';
    const trimmed = String(ip).trim();
    return trimmed.startsWith('::ffff:') ? trimmed.slice(7) : trimmed;
}

function resolveClientIp({ forwardedFor, remoteAddress, trustProxy }) {
    const remote = normalize(remoteAddress);
    if (!trustProxy || !forwardedFor) return remote;
    const forwarded = String(forwardedFor)
        .split(',')
        .map((ip) => normalize(ip))
        .filter(Boolean);
    if (trustProxy === true) return forwarded[0] || remote;
    const chain = [...forwarded, remote];
    const index = Math.max(0, chain.length - 1 - trustProxy);
    return chain[index] || remote;
}

function ipFromRequest(req, trustProxy) {
    return resolveClientIp({
        forwardedFor: req?.headers?.['x-forwarded-for'],
        remoteAddress: req?.socket?.remoteAddress || req?.ip,
        trustProxy,
    });
}

function ipFromSocket(socket, trustProxy) {
    return resolveClientIp({
        forwardedFor: socket?.handshake?.headers?.['x-forwarded-for'],
        remoteAddress: socket?.handshake?.address,
        trustProxy,
    });
}

module.exports = { parseTrustProxy, resolveClientIp, ipFromRequest, ipFromSocket };
