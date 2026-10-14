'use strict';

const config = require('../config');
const Logger = require('../Logger');
const log = new Logger('RestrictAccessByIP');

const { enabled = false, allowedIPs = [] } = config?.security?.middleware?.IpWhitelist || {};
const { ipFromRequest } = require('../ClientIp');

const restrictAccessByIP = (req, res, next) => {
    if (!enabled) return next();
    // Security: X-Forwarded-For is only honoured per TRUST_PROXY (see ClientIp.js),
    // otherwise the header is attacker-controlled and would bypass the allow-list.
    const clientIP = ipFromRequest(req, config?.server?.trustProxy);
    log.debug('Check IP', clientIP);
    if (allowedIPs.includes(clientIP)) {
        next();
    } else {
        log.info('Forbidden: Access denied from this IP address', { clientIP: clientIP });
        res.status(403).json({ error: 'Forbidden', message: 'Access denied from this IP address.' });
    }
};

module.exports = restrictAccessByIP;
