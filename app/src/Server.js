'use strict';

/*
███████ ███████ ██████  ██    ██ ███████ ██████  
██      ██      ██   ██ ██    ██ ██      ██   ██ 
███████ █████   ██████  ██    ██ █████   ██████  
     ██ ██      ██   ██  ██  ██  ██      ██   ██ 
███████ ███████ ██   ██   ████   ███████ ██   ██                                           

prod dependencies: {
    axios                   : https://www.npmjs.com/package/axios
    chokidar                : https://www.npmjs.com/package/chokidar
    colors                  : https://www.npmjs.com/package/colors
    compression             : https://www.npmjs.com/package/compression
    cors                    : https://www.npmjs.com/package/cors
    crypto-js               : https://www.npmjs.com/package/crypto-js
    dompurify               : https://www.npmjs.com/package/dompurify
    express                 : https://www.npmjs.com/package/express
    he                      : https://www.npmjs.com/package/he
    helmet                  : https://www.npmjs.com/package/helmet
    httpolyglot             : https://www.npmjs.com/package/httpolyglot
    js-yaml                 : https://www.npmjs.com/package/js-yaml
    jsdom                   : https://www.npmjs.com/package/jsdom
    jsonwebtoken            : https://www.npmjs.com/package/jsonwebtoken
    mediasoup               : https://www.npmjs.com/package/mediasoup
    mediasoup-client        : https://www.npmjs.com/package/mediasoup-client
    socket.io               : https://www.npmjs.com/package/socket.io
    swagger-ui-express      : https://www.npmjs.com/package/swagger-ui-express
    uuid                    : https://www.npmjs.com/package/uuid
}

dev dependencies: {
    @babel/core             : https://www.npmjs.com/package/@babel/core
    @babel/preset-env       : https://www.npmjs.com/package/@babel/preset-env
    babel-loader            : https://www.npmjs.com/package/babel-loader
    mocha                   : https://www.npmjs.com/package/mocha
    node-fetch              : https://www.npmjs.com/package/node-fetch
    nodemon                 : https://www.npmjs.com/package/nodemon
    prettier                : https://www.npmjs.com/package/prettier
    proxyquire              : https://www.npmjs.com/package/proxyquire
    should                  : https://www.npmjs.com/package/should
    sinon                   : https://www.npmjs.com/package/sinon
    webpack                 : https://www.npmjs.com/package/webpack
    webpack-cli             : https://www.npmjs.com/package/webpack-cli
}
*/

/**
 * MiroTalk SFU - Server component
 *
 * @link    GitHub: https://github.com/miroslavpejic85/mirotalksfu
 * @link    Official Live demo: https://sfu.mirotalk.com
 * @license For open source use: AGPLv3
 * @license For commercial or closed source, contact us at license.mirotalk@gmail.com or purchase directly via CodeCanyon
 * @license CodeCanyon: https://codecanyon.net/item/mirotalk-sfu-webrtc-realtime-video-conferences/40769970
 * @author  Miroslav Pejic - miroslav.pejic.85@gmail.com
 * @version 2.6.25
 *
 */

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const socketIo = require('socket.io');
const httpolyglot = require('httpolyglot');
const mediasoup = require('mediasoup');
const mediasoupClient = require('mediasoup-client');
const http = require('http');
const path = require('path');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const helmet = require('helmet');
const config = require('./config');
const checkXSS = require('./XSS');
const Room = require('./Room');
const Peer = require('./Peer');
const { AdminAuth, makeRoomId } = require('./AdminAuth');
const { ipFromRequest, ipFromSocket } = require('./ClientIp');
const ServerApi = require('./ServerApi');
const { getJwtKeys } = require('./JwtSecret');
const Logger = require('./Logger');
const Validator = require('./Validator');
const RoomPassword = require('./RoomPassword');
const HtmlInjector = require('./HtmlInjector');
const { CollabStore } = require('./Collab');
const { DatePolls, DatePollError } = require('./DatePolls');
const { RoomRegistry } = require('./RoomRegistry');
const { Transcripts } = require('./Transcripts');
const { Moderators, ModeratorError } = require('./Moderators');
const log = new Logger('Server');
const yaml = require('js-yaml');
const swaggerUi = require('swagger-ui-express');
const swaggerDocument = yaml.load(fs.readFileSync(path.join(__dirname, '/../api/swagger.yaml'), 'utf8'));
const restrictAccessByIP = require('./middleware/IpWhitelist');
const { applyEmbedHeaders, embedAllowedOrigins, embedCsp } = require('./middleware/EmbedHeaders');
const packageJson = require('../../package.json');

// Rate limiters
const { createRateLimiters, ipKeyGenerator, minutesLabel } = require('./middleware/RateLimiters');

// Derive a stable per-requester rate-limit key (admin session > IP)
const getRequesterKey = (req) => {
    const admin = adminAuth.fromRequest(req);
    return admin ? `admin:${admin.username}` : ipKeyGenerator(req);
};

const {
    loginLimiter,
    loginUserLimiter,
    roomStatusLimiter,
    createRoomTokenLimiter,
    checkCreateRoomLimit,
    createRoomLimiterMinutes,
    rdvAnswerLimiter,
    rdvReadLimiter,
    invitationLimiter,
} = createRateLimiters({ getRequesterKey });

// Branding configuration
const brandHtmlInjection = config?.ui?.brand?.htmlInjection ?? true;

// Whisper transcription helpers (pure, unit-testable)
const { resolveAudioExtension, decodeAudioPayload, filterTranscript } = require('./lib/whisper');

const app = express();

const options = {
    cert: fs.readFileSync(path.join(__dirname, config?.server?.ssl.cert || '../ssl/cert.pem'), 'utf-8'),
    key: fs.readFileSync(path.join(__dirname, config?.server?.ssl.key || '../ssl/key.pem'), 'utf-8'),
};

const corsOptions = {
    origin: config.server?.cors?.origin || '*',
    methods: config.server?.cors?.methods || ['GET', 'POST'],
};

const server = httpolyglot.createServer(options, app);

const io = socketIo(server, {
    maxHttpBufferSize: 1e7,
    transports: ['websocket'],
    cors: corsOptions,
});

const host = config?.server?.hostUrl || `http://localhost:${config?.server?.listen?.port || 3010}`;
const trustProxy = config?.server?.trustProxy || false;

// Fail closed: refuse to start with a missing, weak or publicly known JWT secret.
let jwtKeys;
try {
    jwtKeys = getJwtKeys(config?.security?.jwt?.key);
} catch (err) {
    log.error('Invalid JWT configuration', err.message);
    process.exit(1);
}

const jwtCfg = {
    JWT_EXP: config?.security?.jwt?.exp || '1h',
};

const JWT_VERIFY_OPTIONS = { algorithms: ['HS256'] };

// Short-lived token bound to a room, issued by GET /createRoomToken only to the admin (or for a
// breakout room a presenter opened). The Socket.IO `createRoom` event always requires it.
const CREATE_ROOM_TOKEN_EXP = '2m';

function createCreateRoomToken(roomId) {
    return jwt.sign({ scope: 'create-room', roomId: String(roomId) }, jwtKeys.createRoom, {
        expiresIn: CREATE_ROOM_TOKEN_EXP,
    });
}

function isCreateRoomTokenValid(token, roomId) {
    if (!token || typeof token !== 'string') return false;
    try {
        const decoded = jwt.verify(token, jwtKeys.createRoom, JWT_VERIFY_OPTIONS);
        return decoded?.scope === 'create-room' && decoded.roomId === String(roomId);
    } catch {
        return false;
    }
}

// TLLM*meet: admins are the accounts listed in HOST_USERS. Only they can create rooms.
const hostCfg = {
    users: config?.security?.host?.users || [],
};

if (!Array.isArray(hostCfg.users) || hostCfg.users.length === 0) {
    log.error('HOST_USERS is empty: set at least one admin account (username:password:displayname) in .env');
    process.exit(1);
}

if (hostCfg.users.some((user) => !user || !user.username || !Validator.isValidPassword(user.password))) {
    throw new Error('HOST_USERS passwords must contain between 1 and 36 characters');
}

// Fail closed: refuse to start with publicly known credentials
const PUBLIC_DEFAULT_CREDENTIALS = [
    { username: 'admin', password: 'admin' },
    { username: 'guest', password: 'guest' },
    { username: 'username', password: 'password' },
    { username: 'username2', password: 'password2' },
    { username: 'username3', password: 'password3' },
];
if (
    hostCfg.users.some((u) =>
        PUBLIC_DEFAULT_CREDENTIALS.some((d) => u.username === d.username && u.password === d.password)
    )
) {
    log.error(
        'HOST_USERS contains publicly known default credentials (admin/admin, guest/guest, username/password...). Set your own in .env'
    );
    process.exit(1);
}

// TLLM*meet: data kept between deployments (date polls, rooms, moderator accounts). On Coolify,
// DATA_DIR is a persistent volume.
const dataDir = process.env.DATA_DIR || path.join(__dirname, '../../data');

// Moderator accounts, created by an admin from the home page (see Moderators.js)
const moderators = new Moderators({
    file: path.join(dataDir, 'moderateurs.json'),
    reserved: (username) => hostCfg.users.some((u) => u.username.toLowerCase() === username.toLowerCase()),
    log,
});

const adminAuth = new AdminAuth({
    users: hostCfg.users,
    key: jwtKeys.adminSession,
    sessionHours: config?.security?.host?.sessionHours,
    moderators,
});

const restApi = {
    basePath: '/api/v1', // api endpoint path
    docs: host + '/api/v1/docs', // api docs
    allowed: config.api?.allowed || {},
};

// directory
const dir = {
    public: path.join(__dirname, '../../public'),
};

// html views
const views = {
    html: path.join(__dirname, '../../public/views'),
    landing: path.join(__dirname, '../../', 'public/views/landing.html'),
    login: path.join(__dirname, '../../', 'public/views/login.html'),
    customizeRoom: path.join(__dirname, '../../', 'public/views/customizeRoom.html'),
    notFound: path.join(__dirname, '../../', 'public/views/404.html'),
    permission: path.join(__dirname, '../../', 'public/views/permission.html'),
    privacy: path.join(__dirname, '../../', 'public/views/privacy.html'),
    room: path.join(__dirname, '../../', 'public/views/Room.html'),
    whoAreYou: path.join(__dirname, '../../', 'public/views/whoAreYou.html'),
    rdv: path.join(__dirname, '../../', 'public/views/rdv.html'),
    rdvAdmin: path.join(__dirname, '../../', 'public/views/rdvAdmin.html'),
    after: path.join(__dirname, '../../', 'public/views/after.html'),
    invitation: path.join(__dirname, '../../', 'public/views/invitation.html'),
};

const filesPath = [
    views.landing,
    views.room,
    views.login,
    views.whoAreYou,
    views.customizeRoom,
    views.rdv,
    views.rdvAdmin,
    views.after,
    views.invitation,
];

const htmlInjector = new HtmlInjector(filesPath, config.ui.brand);

const roomList = new Map(); // All Rooms

// TLLM*meet: date polls, kept in DATA_DIR/rendez-vous.json (see DatePolls.js)
const meetingTimeZone = (() => {
    const zone = process.env.MEETING_TIMEZONE || 'Europe/Paris';
    try {
        new Intl.DateTimeFormat('fr-FR', { timeZone: zone });
        return zone;
    } catch {
        log.warn('MEETING_TIMEZONE is not a valid time zone, using Europe/Paris', { zone });
        return 'Europe/Paris';
    }
})();
// The rooms the organiser opened (name typed at creation, last use), for the home and the door page
const roomRegistry = new RoomRegistry({ file: path.join(dataDir, 'salles.json'), log });
const datePolls = new DatePolls({
    file: path.join(dataDir, 'rendez-vous.json'),
    timeZone: meetingTimeZone,
    makeRoomId,
    // The room reserved for a fixed date carries the poll title
    onFix: (poll) => roomRegistry.remember(poll.fixed.room, { name: poll.title, owner: poll.owner }),
    log,
});
setInterval(() => datePolls.checkDeadlines(), 60 * 1000).unref();
// Meeting transcriptions, one file per meeting in DATA_DIR/transcriptions (see Transcripts.js)
const transcripts = new Transcripts({
    dir: path.join(dataDir, 'transcriptions'),
    retentionDays: process.env.TRANSCRIPTION_RETENTION_DAYS || 30,
    timeZone: meetingTimeZone,
    log,
});
transcripts.purge();
setInterval(() => transcripts.purge(), 6 * 3600 * 1000).unref();

// TLLM*meet: editor and whiteboard content, kept per room by the server (see Collab.js)
const collab = new CollabStore({}, (roomId, exceptSocketId, event, payload) => {
    roomList.get(roomId)?.broadCast(exceptSocketId, event, payload);
});

const presenters = {}; // Collect presenters grp by roomId

const webRtcServerActive = config.mediasoup.webRtcServerActive;

// ip (server local IPv4)
const IP = webRtcServerActive
    ? config.mediasoup.webRtcServerOptions.listenInfos[0].ip
    : config.mediasoup.webRtcTransport.listenInfos[0].ip;

// announcedAddress (server public IPv4)
let announcedAddress = webRtcServerActive
    ? config.mediasoup.webRtcServerOptions.listenInfos[0].announcedAddress
    : config.mediasoup.webRtcTransport.listenInfos[0].announcedAddress;

// All mediasoup workers
const workers = [];
let nextMediasoupWorkerIdx = 0;

// Autodetect announcedAddress with multiple fallback services
if (!announcedAddress && IP === '0.0.0.0') {
    const detectPublicIp = async () => {
        const services = config.system?.services?.ip || [
            'http://api.ipify.org',
            'http://ipinfo.io/ip',
            'http://ifconfig.me/ip',
        ];

        for (const service of services) {
            try {
                const ip = await fetchPublicIp(service);
                if (ip) {
                    announcedAddress = ip;
                    updateAnnouncedAddress(ip);
                    startServer();
                    return;
                }
            } catch (err) {
                log.warn(`Failed to detect IP from ${service}`, err.message);
            }
        }
        throw new Error('All public IP detection services failed! Please check your network connection');
    };

    detectPublicIp().catch((err) => {
        log.error('Public IP detection failed', err.message);
        process.exit(1);
    });
} else {
    startServer();
}

function fetchPublicIp(serviceUrl) {
    return new Promise((resolve, reject) => {
        http.get(serviceUrl, (resp) => {
            if (resp.statusCode !== 200) {
                return reject(new Error(`HTTP ${resp.statusCode}`));
            }
            let data = '';
            resp.on('data', (chunk) => (data += chunk));
            resp.on('end', () => resolve(data.toString().trim()));
        }).on('error', reject);
    });
}

function updateAnnouncedAddress(ip) {
    const target = webRtcServerActive
        ? config.mediasoup.webRtcServerOptions.listenInfos
        : config.mediasoup.webRtcTransport.listenInfos;

    target.forEach((info) => {
        info.announcedAddress = ip;
    });
}

function startServer() {
    // Start the app
    app.set('trust proxy', trustProxy); // Enables trust for proxy headers (e.g., X-Forwarded-For) based on the trustProxy setting
    app.use(helmet.noSniff()); // Enable content type sniffing prevention
    app.use(applyEmbedHeaders); // Apply iframe embedding restrictions (CSP frame-ancestors / X-Frame-Options)
    // TLLM*meet: compress before serving static files (JS/CSS were sent uncompressed before)
    app.use(compression());
    // Use all static files from the public folder
    app.use(
        express.static(dir.public, {
            setHeaders: (res, filePath) => {
                if (filePath.endsWith('.js')) {
                    res.setHeader('Content-Type', 'application/javascript');
                } //...
                // TLLM*meet: versioned URLs (?v=<hash>, added by HtmlInjector) never change content
                if (res.req?.query?.v) {
                    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
                }
            },
        })
    );
    app.use(cors(corsOptions));
    app.use(express.json({ limit: '50mb' })); // Handles JSON payloads
    app.use(express.urlencoded({ extended: true, limit: '50mb' })); // Handles URL-encoded payloads
    app.use(express.raw({ type: 'video/webm', limit: '50mb' })); // Handles raw binary data
    app.use(restApi.basePath + '/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument)); // api docs

    // IP Whitelist check ...
    app.use(restrictAccessByIP);

    // Logs requests
    /*
    app.use((req, res, next) => {
        log.debug('New request:', {
            headers: req.headers,
            body: req.body,
            method: req.method,
            path: req.originalUrl,
        });
        next();
    });
    */

    // Remove trailing slashes in url handle bad requests
    app.use((err, req, res, next) => {
        if (err && (err instanceof SyntaxError || err.status === 400 || 'body' in err)) {
            log.error('Request Error', {
                header: req.headers,
                body: req.body,
                error: err.message,
            });
            return res.status(400).send({ status: 404, message: err.message }); // Bad request
        }

        // Prevent open redirect attacks by checking if the path is an external domain
        const cleanPath = req.path.replace(/^\/+/, '');
        if (/^([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}/.test(cleanPath)) {
            return res.status(400).send('Bad Request: Potential Open Redirect Detected');
        }

        if (req.path.endsWith('/') && req.path.length > 1) {
            let query = req.url.substring(req.path.length).replace(/\/$/, ''); // Ensure query params don't end in '/'
            return res.redirect(301, req.path.slice(0, -1) + query);
        }

        next();
    });

    // Admin display name (prefills the join form). Guests get no profile.
    app.get('/profile', (req, res) => {
        const admin = adminAuth.fromRequest(req);
        res.set('Cache-Control', 'no-store');
        if (admin) {
            return res.json({ name: admin.displayname, peer_name: { force: false, name: true } });
        }
        return res.status(201).json({ email: false, name: false, peer_name: false });
    });

    // Admin session state, used by the landing page to show the "new meeting" form
    app.get('/admin/session', (req, res) => {
        const admin = adminAuth.fromRequest(req);
        res.set('Cache-Control', 'no-store');
        return res.json(admin ? { admin: true, role: admin.role, name: admin.displayname } : { admin: false });
    });

    // ---------- TLLM*meet: moderator accounts, managed by the HOST_USERS admins only ----------
    // The admin makes links; the person picks the username and password on /invitation/<token>.
    const INVITATION = /^[A-Za-z0-9_-]{32}$/;
    const invitationUrl = (token) => `${host}/invitation/${token}`;
    const moderatorReply = (res, fn) => {
        res.set('Cache-Control', 'no-store');
        try {
            return res.json(fn());
        } catch (err) {
            if (err instanceof ModeratorError) return res.status(err.status).json({ error: err.message });
            log.error('Moderators', { error: err.message });
            return res.status(500).json({ error: 'Erreur du serveur.' });
        }
    };
    const moderatorsOnly = (handler) => (req, res) => {
        const admin = adminAuth.fromRequest(req);
        if (!admin) return res.status(401).json({ error: 'unauthorized' });
        if (admin.role !== 'admin') return res.status(403).json({ error: 'Réservé à l’administrateur.' });
        return moderatorReply(res, () => handler(req, admin));
    };

    app.get(
        '/api/admin/moderators',
        moderatorsOnly(() => moderators.list())
    );
    app.post(
        '/api/admin/moderators/invitations',
        moderatorsOnly((req, admin) => {
            const { token, invite } = moderators.invite({ name: req.body?.name }, admin.username);
            log.info('Moderator invitation created', { by: admin.username });
            return { ...invite, url: invitationUrl(token) };
        })
    );
    app.delete(
        '/api/admin/moderators/invitations/:id',
        moderatorsOnly((req) => ({ ok: moderators.cancelInvite(req.params.id) }))
    );
    app.post(
        '/api/admin/moderators/:id/reset',
        moderatorsOnly((req, admin) => {
            const { token, invite } = moderators.resetLink(req.params.id, admin.username);
            log.info('Moderator password reset link created', { by: admin.username });
            return { ...invite, url: invitationUrl(token) };
        })
    );
    app.delete(
        '/api/admin/moderators/:id',
        moderatorsOnly((req, admin) => {
            moderators.remove(req.params.id);
            log.info('Moderator removed', { id: req.params.id, by: admin.username });
            return { ok: true };
        })
    );

    // The person who received the link: create the account, or choose a new password
    app.get('/invitation/:token', (req, res) => {
        if (!INVITATION.test(req.params.token)) return res.status(404).sendFile(views.notFound);
        res.set('Cache-Control', 'no-store');
        return htmlInjector.injectHtml(views.invitation, res);
    });
    app.get('/api/invitation/:token', rdvReadLimiter, (req, res) =>
        moderatorReply(res, () => {
            const invitation = moderators.invitation(req.params.token);
            if (!invitation) throw new ModeratorError('Ce lien n’est plus valable. Demandez-en un nouveau.', 404);
            return invitation;
        })
    );
    app.post('/api/invitation/:token', invitationLimiter, (req, res) =>
        moderatorReply(res, () => {
            const kind = moderators.invitation(req.params.token)?.kind;
            const account = moderators.accept(req.params.token, req.body || {});
            log.info(kind === 'reset' ? 'Moderator password changed' : 'Moderator account created', {
                username: account.username,
                ip: getIP(req),
            });
            adminAuth.issue(res, account); // logged in right away
            return { ok: true, name: account.displayname };
        })
    );

    // Admin creates a meeting: the server turns the typed name into a room id with a random suffix
    app.post('/admin/rooms', (req, res) => {
        const admin = adminAuth.fromRequest(req);
        if (!admin) {
            return res.status(401).json({ message: 'unauthorized' });
        }
        const name = typeof req.body?.name === 'string' ? req.body.name : '';
        const room = makeRoomId(name);
        roomRegistry.remember(room, { name: name.trim() || null, owner: admin.username });
        res.set('Cache-Control', 'no-store');
        return res.json({ room, url: '/join/' + encodeURIComponent(room) });
    });

    // ---------- TLLM*meet: state of the rooms (door page and organiser home) ----------
    const firstName = (peer) =>
        String(peer?.peer_info?.peer_name ?? peer?.peer_name ?? '')
            .trim()
            .split(/\s+/)[0]
            .slice(0, 30);
    const organizerName = (owner) => {
        const user = owner ? adminAuth.findUser(owner) : null;
        return user ? user.displayname || user.username : null;
    };

    // The fixed meeting reserved for this room that is coming or under way
    function roomBooking(roomId) {
        const now = Date.now();
        let found = null;
        for (const poll of datePolls.polls.values()) {
            if (poll.status !== 'fixed' || poll.fixed?.room !== roomId || poll.fixed.end < now) continue;
            if (!found || poll.fixed.start < found.fixed.start) found = poll;
        }
        return found;
    }

    function roomState(roomId) {
        const room = roomList.get(roomId);
        const peers = room ? Array.from(room.peers.values()) : [];
        const known = roomRegistry.get(roomId);
        const booking = roomBooking(roomId);
        return {
            id: roomId,
            name: roomRegistry.name(roomId),
            active: !!room,
            since: room ? roomRegistry.since(roomId) : null,
            count: peers.length,
            people: peers.map(firstName).filter(Boolean).slice(0, 6),
            organizer: organizerName(known?.owner || booking?.owner),
            booking: booking && { title: booking.title, start: booking.fixed.start, end: booking.fixed.end },
            lastUsedAt: known ? Math.max(known.lastClosedAt || 0, known.lastOpenedAt || 0) || null : null,
        };
    }

    // Door page: anyone holding the link sees the room's sign (name, open or not, first names inside)
    app.get('/api/room/:id', roomStatusLimiter, (req, res) => {
        const id = req.params.id;
        if (!Validator.isValidRoomName(id) || id.length > 80) return res.status(400).json({ error: 'invalid room' });
        res.set('Cache-Control', 'no-store');
        const state = roomState(id);
        delete state.lastUsedAt;
        return res.json(state);
    });

    // Organiser home: rooms (live, booked, recent), agenda of fixed meetings, polls waiting for answers
    app.get('/api/admin/overview', (req, res) => {
        const admin = adminAuth.fromRequest(req);
        if (!admin) return res.status(401).json({ error: 'unauthorized' });
        res.set('Cache-Control', 'no-store');
        const now = Date.now();
        // An admin sees every room and poll; a moderator only their own
        const everything = admin.role === 'admin';
        const polls = everything ? datePolls.listAll() : datePolls.list(admin.username);
        const ids = new Set();
        for (const id of roomList.keys()) {
            if (!id.includes('_breakout_') && (everything || ownsRoom(admin, id))) ids.add(id);
        }
        for (const p of polls) if (p.status === 'fixed' && p.fixed.end > now) ids.add(p.fixed.room);
        for (const r of roomRegistry.recent(everything ? null : admin.username, everything ? 30 : 12)) ids.add(r.id);
        const mine = (owner) => !owner || owner === admin.username;
        const organizerOf = (owner) => (mine(owner) ? null : organizerName(owner) || owner);

        const rank = (r) => (r.active ? 0 : r.booking && r.booking.start - now < 24 * 3600 * 1000 ? 1 : 2);
        const rooms = Array.from(ids)
            .map((id) => {
                const state = roomState(id);
                const owner = roomRegistry.get(id)?.owner || roomBooking(id)?.owner;
                const transcript = transcripts.latest(id);
                return {
                    ...state,
                    organizer: organizerOf(owner),
                    transcript: transcript && { id: transcript.id, status: transcript.status },
                };
            })
            .sort(
                (a, b) =>
                    rank(a) - rank(b) ||
                    (a.active ? b.count - a.count : 0) ||
                    (a.booking && b.booking ? a.booking.start - b.booking.start : 0) ||
                    (b.lastUsedAt || 0) - (a.lastUsedAt || 0)
            );
        const agenda = polls
            .filter((p) => p.status === 'fixed' && p.fixed.end > now)
            .sort((a, b) => a.fixed.start - b.fixed.start)
            .slice(0, 12)
            .map((p) => ({
                id: p.id,
                title: p.title,
                start: p.fixed.start,
                end: p.fixed.end,
                room: p.fixed.room,
                auto: p.fixed.auto,
                organizer: mine(p.owner) ? null : p.organizer,
                available: p.participants.filter((x) => x.answers[p.fixed.slot] !== 'no').length,
                answers: p.participants.length,
            }));
        const waiting = polls
            .filter((p) => p.status === 'open')
            .map((p) => ({
                id: p.id,
                title: p.title,
                answers: p.participants.length,
                expected: p.expected,
                deadline: p.deadline,
                slots: p.slots.length,
                organizer: mine(p.owner) ? null : p.organizer,
            }));
        return res.json({
            now,
            timeZone: meetingTimeZone,
            name: admin.displayname,
            role: admin.role,
            rooms,
            agenda,
            polls: waiting,
        });
    });

    // ---------- TLLM*meet: date polls (see DatePolls.js) ----------
    const RDV_ID = /^[a-z0-9]{10}$/;
    const rdvOwner = (req) => adminAuth.fromRequest(req);
    const rdvReply = (res, fn) => {
        res.set('Cache-Control', 'no-store');
        try {
            return res.json(fn());
        } catch (err) {
            if (err instanceof DatePollError) return res.status(err.status).json({ error: err.message });
            log.error('Date polls', { error: err.message });
            return res.status(500).json({ error: 'Erreur du serveur.' });
        }
    };
    const rdvAdminOnly = (handler) => (req, res) => {
        const admin = rdvOwner(req);
        if (!admin) return res.status(401).json({ error: 'unauthorized' });
        return rdvReply(res, () => handler(req, admin));
    };
    // An admin manages every poll as if it were theirs; a moderator only their own
    const rdvActor = (admin, id) =>
        admin.role === 'admin' ? datePolls.get(id)?.owner || admin.username : admin.username;
    const canManagePoll = (admin, poll) => !!admin && (admin.role === 'admin' || admin.username === poll.owner);

    // ---------- TLLM*meet: meeting transcriptions (see Transcripts.js) ----------
    // Only the organiser of the room (or an admin) lists, downloads and deletes them
    const transcriptOwner = (req, res) => {
        const admin = adminAuth.fromRequest(req);
        res.set('Cache-Control', 'no-store');
        if (!admin) {
            res.status(401).json({ error: 'unauthorized' });
            return null;
        }
        if (!transcripts.eligible(req.params.room) || !ownsRoom(admin, req.params.room)) {
            res.status(404).json({ error: 'not found' });
            return null;
        }
        return admin;
    };

    app.get('/api/transcriptions/:room', (req, res) => {
        if (!transcriptOwner(req, res)) return;
        return res.json({
            room: req.params.room,
            retentionDays: transcripts.retentionMs / 86400000,
            sessions: transcripts.list(req.params.room),
        });
    });

    app.get('/transcriptions/:room/:id.txt', (req, res) => {
        if (!transcriptOwner(req, res)) return;
        const { room, id } = req.params;
        const t = transcripts.read(room, id);
        if (!t) return res.status(404).json({ error: 'not found' });
        const status = transcripts.status(room, id);
        if (status !== 'ready' && status !== 'paused') {
            return res.status(409).json({ error: 'La transcription n’est pas terminée.', status });
        }
        t.name = roomRegistry.name(room);
        const day = new Intl.DateTimeFormat('fr-CA', { timeZone: meetingTimeZone }).format(new Date(t.startedAt));
        res.set({
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': `attachment; filename="transcription-${room}-${day}.txt"`,
        });
        return res.send(transcripts.toText(t));
    });

    app.delete('/api/transcriptions/:room/:id', (req, res) => {
        if (!transcriptOwner(req, res)) return;
        if (!transcripts.remove(req.params.room, req.params.id)) return res.status(404).json({ error: 'not found' });
        return res.json({ ok: true });
    });

    // After leaving a call (see TllmRoom.js)
    app.get('/apres/:id', (req, res) => {
        if (!Validator.isValidRoomName(req.params.id)) return res.status(404).sendFile(views.notFound);
        return htmlInjector.injectHtml(views.after, res);
    });

    app.get('/rdv', (req, res) => htmlInjector.injectHtml(views.rdvAdmin, res));
    app.get('/rdv/:id', (req, res) => {
        if (!RDV_ID.test(req.params.id)) return res.status(404).sendFile(views.notFound);
        return htmlInjector.injectHtml(views.rdv, res);
    });

    // Calendar subscription: empty until the date is set, then the meeting and its link
    app.get('/rdv/:id/agenda.ics', (req, res) => {
        const poll = datePolls.get(req.params.id);
        if (!poll) return res.status(404).type('text/plain').send('Not found');
        res.set({
            'Content-Type': 'text/calendar; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Content-Disposition': 'inline; filename="agenda.ics"',
        });
        return res.send(datePolls.feed(poll, host));
    });

    // One event to add by hand, once the date is set
    app.get('/rdv/:id/rendez-vous.ics', (req, res) => {
        const poll = datePolls.get(req.params.id);
        const file = poll && datePolls.eventFile(poll, host);
        if (!file) return res.status(404).type('text/plain').send('Not found');
        res.set({
            'Content-Type': 'text/calendar; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Content-Disposition': 'attachment; filename="rendez-vous.ics"',
        });
        return res.send(file);
    });

    app.get(
        '/api/rdv',
        rdvAdminOnly((req, admin) => ({
            timeZone: meetingTimeZone,
            polls: (admin.role === 'admin' ? datePolls.listAll() : datePolls.list(admin.username)).map((p) => ({
                ...datePolls.summary(p),
                organizer: p.owner === admin.username ? null : p.organizer,
            })),
        }))
    );
    app.post(
        '/api/rdv',
        rdvAdminOnly((req, admin) => {
            const poll = datePolls.create(admin.username, admin.displayname, req.body);
            return { id: poll.id, url: `/rdv/${poll.id}` };
        })
    );
    app.get('/api/rdv/:id', rdvReadLimiter, (req, res) =>
        rdvReply(res, () => {
            const poll = datePolls.get(req.params.id);
            if (!poll) throw new DatePollError('Sondage introuvable.', 404);
            const admin = rdvOwner(req);
            return datePolls.view(poll, { admin: canManagePoll(admin, poll) });
        })
    );
    app.post('/api/rdv/:id/answers', rdvAnswerLimiter, (req, res) =>
        rdvReply(res, () => datePolls.answer(req.params.id, req.body))
    );
    app.put('/api/rdv/:id/answers/:pid', rdvAnswerLimiter, (req, res) =>
        rdvReply(res, () => ({
            ok: datePolls.updateAnswer(req.params.id, req.params.pid, req.get('x-answer-token'), req.body),
        }))
    );
    app.delete(
        '/api/rdv/:id/answers/:pid',
        rdvAdminOnly((req, admin) => ({
            ok: datePolls.removeAnswer(req.params.id, rdvActor(admin, req.params.id), req.params.pid),
        }))
    );
    app.post(
        '/api/rdv/:id/fix',
        rdvAdminOnly((req, admin) =>
            datePolls.view(datePolls.fix(req.params.id, rdvActor(admin, req.params.id), req.body?.slot), {
                admin: true,
            })
        )
    );
    app.post(
        '/api/rdv/:id/close',
        rdvAdminOnly((req, admin) =>
            datePolls.view(datePolls.close(req.params.id, rdvActor(admin, req.params.id)), { admin: true })
        )
    );
    app.delete(
        '/api/rdv/:id',
        rdvAdminOnly((req, admin) => ({ ok: datePolls.remove(req.params.id, rdvActor(admin, req.params.id)) }))
    );

    // Logout: revoke the admin session and clear the cookie
    app.get('/logout', (req, res) => {
        adminAuth.clear(req, res);
        res.redirect('/');
    });

    // Favicon
    app.get('/favicon.ico', (req, res) => res.status(204).end());

    // UI buttons configuration
    app.get('/config', (req, res) => {
        res.status(200).json({ message: config?.ui?.buttons || false });
    });

    // Brand configuration
    app.get('/brand', (req, res) => {
        res.status(200).json({ message: brandHtmlInjection ? config?.ui?.brand : false });
    });

    // UI themes configuration
    app.get('/themes', (req, res) => {
        res.status(200).json({ message: config?.ui?.themes ? config.ui.themes : false });
    });

    // main page (admin: new meeting form, guest: "you need a link")
    app.get('/', (req, res) => {
        return htmlInjector.injectHtml(views.landing, res);
    });

    // Legacy page: rooms are now created from the main page by the admin
    app.get('/newroom', (req, res) => {
        res.redirect('/');
    });

    // Customize room (join link options): admin only
    app.get('/customizeRoom', (req, res) => {
        if (!adminAuth.fromRequest(req)) return res.redirect('/');
        htmlInjector.injectHtml(views.customizeRoom, res);
    });

    // Check if room active (exists): used by the "meeting has not started yet" page
    app.post('/isRoomActive', roomStatusLimiter, (req, res) => {
        const roomId = typeof req.body?.roomId === 'string' ? req.body.roomId : '';
        if (!roomId || !Validator.isValidRoomName(roomId)) {
            return res.status(400).json({ message: false });
        }
        res.set('Cache-Control', 'no-store');
        return res.status(200).json({ message: roomList.has(roomId) });
    });

    // Issue a short-lived token that authorizes the Socket.IO `createRoom` event for this room.
    // Only the admin session (cookie) or a breakout room opened by a presenter qualifies.
    // Guests joining a running meeting skip the limiter (no token needed, the room exists)
    const createRoomTokenGate = (req, res, next) => {
        const room = typeof req.query?.room === 'string' ? req.query.room : '';
        if (room && roomList.has(room)) {
            res.set('Cache-Control', 'no-store');
            return res.json({ required: false, token: null, exists: true });
        }
        return createRoomTokenLimiter(req, res, next);
    };

    app.get('/createRoomToken', createRoomTokenGate, (req, res) => {
        const room = typeof req.query?.room === 'string' ? req.query.room : '';

        if (!room || !Validator.isValidRoomName(room)) {
            return res.status(400).json({ message: 'Invalid room' });
        }

        res.set('Cache-Control', 'no-store');

        if (!ownsRoom(adminAuth.fromRequest(req), room) && !isAuthorizedBreakout(room)) {
            log.warn('Room creation token denied', { room, ip: getIP(req) });
            return res.status(403).json({ required: true, token: null });
        }

        return res.json({ required: true, token: createCreateRoomToken(room) });
    });

    // Serve the room page if the meeting exists (or the admin is opening it), else the waiting page
    function serveRoomOrWaiting(req, res, roomId) {
        if (roomList.has(roomId) || ownsRoom(adminAuth.fromRequest(req), roomId) || isAuthorizedBreakout(roomId)) {
            return htmlInjector.injectHtml(views.room, res);
        }
        const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
        return res.redirect('/whoAreYou/' + encodeURIComponent(roomId) + query);
    }

    // Handle Direct join room with params: /join?room=xxx&name=xxx&audio=1...
    app.get('/join/', (req, res) => {
        const room = typeof req.query?.room === 'string' ? req.query.room : '';
        if (!room || !Validator.isValidRoomName(room)) {
            return res.redirect('/');
        }
        return serveRoomOrWaiting(req, res, room);
    });

    // join room by id
    app.get('/join/:roomId', (req, res) => {
        const { roomId } = req.params;
        if (!roomId || !Validator.isValidRoomName(roomId)) {
            log.warn('/join/:roomId invalid', roomId);
            return res.redirect('/');
        }
        return serveRoomOrWaiting(req, res, roomId);
    });

    // not specified correctly the room id
    app.get('/join/\\*', (req, res) => {
        res.redirect('/');
    });

    // if not allow video/audio
    app.get('/permission', (req, res) => {
        res.sendFile(views.permission);
    });

    // privacy policy
    app.get('/privacy', (req, res) => {
        res.sendFile(views.privacy);
    });

    // "This meeting has not started yet": polls /isRoomActive and joins when the admin opens it
    app.get('/whoAreYou/:roomId', (req, res) => {
        htmlInjector.injectHtml(views.whoAreYou, res);
    });

    // Admin login page
    app.get('/login', (req, res) => {
        return htmlInjector.injectHtml(views.login, res);
    });

    // Legacy route
    app.get('/logged', (req, res) => {
        res.redirect('/');
    });

    // ####################################################
    // AXIOS
    // ####################################################

    // Admin login: checks HOST_USERS and the moderator accounts, then sets the session cookie.
    // Credentials are never logged.
    app.post('/login', loginLimiter, loginUserLimiter, (req, res) => {
        const ip = getIP(req);
        const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
        const password = typeof req.body?.password === 'string' ? req.body.password : '';

        if (!username || !password) {
            return res.status(400).json({ message: 'Missing username or password' });
        }

        if (!Validator.isValidPassword(password)) {
            return res.status(400).json({ message: 'Invalid password' });
        }

        const user = adminAuth.verifyCredentials(username, password);

        if (!user) {
            // Helps diagnose a mistyped HOST_USERS. An unknown username is not logged (it may be a password typed in the wrong field)
            const known = !!adminAuth.findUser(username);
            log.warn(
                'Admin login failed',
                known ? { ip, username, reason: 'wrong password' } : { ip, reason: 'unknown username' }
            );
            return res.status(401).json({ message: 'unauthorized' });
        }

        adminAuth.issue(res, user);
        log.info('Admin login', { username: user.username, role: adminAuth.roleOf(user), ip });
        res.set('Cache-Control', 'no-store');
        return res.status(200).json({ ok: true, name: user.displayname || user.username });
    });

    // Join roomId redirect to /join?room=roomId
    app.get('/:roomId', (req, res) => {
        const { roomId } = checkXSS(req.params);

        if (!Validator.isValidRoomName(roomId)) {
            log.warn('/:roomId not valid', roomId);
            return res.redirect('/');
        }

        log.debug(`Detected roomId --> redirect to /join?room=${roomId}`);
        res.redirect(`/join/${roomId}`);
    });

    // ####################################################
    // REST API
    // ####################################################

    app.get(restApi.basePath + '/stats', (req, res) => {
        try {
            // Check if endpoint allowed
            if (restApi.allowed && !restApi.allowed.stats) {
                return res.status(403).json({
                    success: false,
                    error: 'This endpoint has been disabled. Please contact the administrator for further information.',
                });
            }
            // check if user was authorized for the api call
            const { host, authorization } = req.headers;
            const api = new ServerApi(host, authorization);

            if (!api.isAuthorized()) {
                log.debug('MiroTalk get meetings - Unauthorized', {
                    header: req.headers,
                    body: req.body,
                });
                return res.status(403).json({ error: 'Unauthorized!' });
            }

            const { timestamp, totalRooms, totalUsers } = api.getStats(roomList);

            res.json({
                success: true,
                timestamp,
                totalRooms,
                totalUsers,
            });

            // log.debug the output if all done
            log.debug('MiroTalk get stats - Authorized', {
                header: req.headers,
                body: req.body,
                timestamp,
                totalRooms,
                totalUsers,
            });
        } catch (error) {
            console.error('Error fetching stats', error);
            res.status(500).json({ success: false, error: 'Failed to retrieve stats.' });
        }
    });

    // request meetings list
    app.get(restApi.basePath + '/meetings', (req, res) => {
        // Check if endpoint allowed
        if (restApi.allowed && !restApi.allowed.meetings) {
            return res.status(403).json({
                error: 'This endpoint has been disabled. Please contact the administrator for further information.',
            });
        }
        // check if user was authorized for the api call
        const { host, authorization } = req.headers;
        const api = new ServerApi(host, authorization);
        if (!api.isAuthorized()) {
            log.debug('MiroTalk get meetings - Unauthorized', {
                header: req.headers,
                body: req.body,
            });
            return res.status(403).json({ error: 'Unauthorized!' });
        }
        // Get meetings
        const meetings = api.getMeetings(roomList);
        res.json({ meetings: meetings });
        // log.debug the output if all done
        log.debug('MiroTalk get meetings - Authorized', {
            header: req.headers,
            body: req.body,
            meetings: meetings,
        });
    });

    // request meeting room endpoint
    app.post(restApi.basePath + '/meeting', (req, res) => {
        // Check if endpoint allowed
        if (restApi.allowed && !restApi.allowed.meeting) {
            return res.status(403).json({
                error: 'This endpoint has been disabled. Please contact the administrator for further information.',
            });
        }
        // check if user was authorized for the api call
        const { host, authorization } = req.headers;
        const api = new ServerApi(host, authorization);
        if (!api.isAuthorized()) {
            log.debug('MiroTalk get meeting - Unauthorized', {
                header: req.headers,
                body: req.body,
            });
            return res.status(403).json({ error: 'Unauthorized!' });
        }
        // setup meeting URL
        const meetingURL = api.getMeetingURL();
        res.json({ meeting: meetingURL });
        // log.debug the output if all done
        log.debug('MiroTalk get meeting - Authorized', {
            header: req.headers,
            body: req.body,
            meeting: meetingURL,
        });
    });

    // request join room endpoint
    app.post(restApi.basePath + '/join', (req, res) => {
        // Check if endpoint allowed
        if (restApi.allowed && !restApi.allowed.join) {
            return res.status(403).json({
                error: 'This endpoint has been disabled. Please contact the administrator for further information.',
            });
        }
        // check if user was authorized for the api call
        const { host, authorization } = req.headers;
        const api = new ServerApi(host, authorization);
        if (!api.isAuthorized()) {
            log.debug('MiroTalk get join - Unauthorized', {
                header: req.headers,
                body: req.body,
            });
            return res.status(403).json({ error: 'Unauthorized!' });
        }
        // setup Join URL
        const joinURL = api.getJoinURL(req.body);
        res.json({ join: joinURL });
        // log.debug the output if all done
        log.debug('MiroTalk get join - Authorized', {
            header: req.headers,
            body: req.body,
            join: joinURL,
        });
    });

    // request token endpoint
    app.post(restApi.basePath + '/token', (req, res) => {
        // Check if endpoint allowed
        if (restApi.allowed && !restApi.allowed.token) {
            return res.status(403).json({
                error: 'This endpoint has been disabled. Please contact the administrator for further information.',
            });
        }
        // check if user was authorized for the api call
        const { host, authorization } = req.headers;
        const api = new ServerApi(host, authorization);
        if (!api.isAuthorized()) {
            log.debug('MiroTalk get token - Unauthorized', {
                header: req.headers,
                body: req.body,
            });
            return res.status(403).json({ error: 'Unauthorized!' });
        }
        // Get Token
        const token = api.getToken(req.body);
        res.json({ token: token });
        // log.debug the output if all done
        log.debug('MiroTalk get token - Authorized', {
            header: req.headers,
            body: req.body,
            token: token,
        });
    });

    // request end meeting room endpoint
    app.delete(restApi.basePath + '/meeting/:room', (req, res) => {
        try {
            // Check if endpoint allowed
            if (restApi.allowed && !restApi.allowed.meetingEnd) {
                return res.status(403).json({
                    success: false,
                    error: 'This endpoint has been disabled. Please contact the administrator for further information.',
                });
            }
            // check if user was authorized for the api call
            const { host, authorization } = req.headers;
            const api = new ServerApi(host, authorization);
            if (!api.isAuthorized()) {
                log.debug('MiroTalk end meeting - Unauthorized', {
                    header: req.headers,
                    body: req.body,
                });
                return res.status(403).json({ error: 'Unauthorized!' });
            }
            // End the meeting
            const { room } = req.params;
            const { redirect } = req.body || {};
            const result = api.endMeeting(roomList, room, redirect);
            const status = result.success ? 200 : 404;
            res.status(status).json(result);
            // log.debug the output if all done
            log.debug('MiroTalk end meeting - Authorized', {
                header: req.headers,
                room: room,
                result: result,
            });
        } catch (error) {
            console.error('Error ending meeting', error);
            res.status(500).json({ success: false, error: 'Failed to end meeting.' });
        }
    });

    // ####################################################
    // not match any of page before, so 404 not found
    app.use((req, res) => {
        res.sendFile(views.notFound);
    });

    // Global error handler for URIError and other errors
    app.use((err, req, res, next) => {
        if (err instanceof URIError) {
            log.warn('Malformed URI detected', {
                url: req.url,
                ip: getIP(req),
                error: err.message,
            });
            return res.status(400).send({ status: 400, message: 'Invalid URL encoding' });
        }
        // Handle other errors
        log.error('Unhandled error', {
            url: req.url,
            error: err.message,
            stack: err.stack,
        });
        res.status(500).send({ status: 500, message: 'Internal server error' });
    });

    // ####################################################
    // SERVER CONFIG
    // ####################################################

    function getServerConfig() {
        const safeConfig = {
            // Network & Connectivity
            network: {
                server_listen: host,
                trust_proxy: trustProxy,
                sfu: {
                    announcedIP: announcedAddress,
                    listenIP: IP,
                    numWorker: config.mediasoup?.numWorkers,
                    rtcMinPort: config.mediasoup?.worker?.rtcMinPort,
                    rtcMaxPort: config.mediasoup?.worker?.rtcMaxPort,
                },
            },

            // Security & Authentication
            security: {
                cors: corsOptions,
                embed: {
                    allowedOrigins: embedAllowedOrigins.length ? embedAllowedOrigins : 'any',
                    csp: embedCsp ? embedCsp.csp : 'not set (embedding allowed from any origin)',
                },
                jwtCfg: jwtCfg,
                admins: {
                    count: hostCfg.users.length,
                    usernames: hostCfg.users.map((u) => u.username),
                    moderators: moderators.accounts.size,
                    sessionHours: adminAuth.sessionHours,
                }, // never log passwords
                middleware: {
                    IpWhitelist: config?.security?.middleware?.IpWhitelist?.enabled
                        ? config.security.middleware.IpWhitelist
                        : false,
                    //...
                },
            },

            // API & Services
            api: {
                rest_api: restApi,
            },

            // Media Configuration
            media: {
                mediasoup: {
                    listenInfos: config.mediasoup?.webRtcTransport?.listenInfos,
                    worker_bin: mediasoup?.workerBin,
                },
            },

            // Communication Integrations
            integrations: {},

            // UI & Branding
            ui: {
                brand: config.ui?.brand,
                buttons: config.ui?.buttons,
            },

            // Monitoring
            monitoring: {
                system_info: config.system?.info,
            },

            // Features & Functionality
            features: {
                survey: config.features?.survey?.enabled ? config.features.survey : false,
                redirect: config.features?.redirect?.enabled ? config.features.redirect : false,
            },

            // Global Moderation & Management
            moderation: {
                room: {
                    maxParticipants: config?.moderation?.room?.maxParticipants || 1000,
                    lobby: config?.moderation?.room?.lobby || false,
                },
            },

            // Version Information
            versions: {
                app: packageJson?.version,
                node: process.versions.node,
                server_version: mediasoup?.version,
                client_version: mediasoupClient?.version,
            },
        };

        return safeConfig;
    }

    // ####################################################
    // HANDLE SERVER CLIENT ERRORS
    // ####################################################

    server.on('clientError', (err, socket) => {
        if (socket.writable) {
            socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        }
        socket.destroy();
        log.warn('Client connection error', { error: err.message, code: err.code });
    });

    // ####################################################
    // START SERVER
    // ####################################################

    function startServer() {
        server.listen(config?.server?.listen?.port || 3010, () => {
            log.log(
                `%c
    
        ███████╗██╗ ██████╗ ███╗   ██╗      ███████╗███████╗██████╗ ██╗   ██╗███████╗██████╗ 
        ██╔════╝██║██╔════╝ ████╗  ██║      ██╔════╝██╔════╝██╔══██╗██║   ██║██╔════╝██╔══██╗
        ███████╗██║██║  ███╗██╔██╗ ██║█████╗███████╗█████╗  ██████╔╝██║   ██║█████╗  ██████╔╝
        ╚════██║██║██║   ██║██║╚██╗██║╚════╝╚════██║██╔══╝  ██╔══██╗╚██╗ ██╔╝██╔══╝  ██╔══██╗
        ███████║██║╚██████╔╝██║ ╚████║      ███████║███████╗██║  ██║ ╚████╔╝ ███████╗██║  ██║
        ╚══════╝╚═╝ ╚═════╝ ╚═╝  ╚═══╝      ╚══════╝╚══════╝╚═╝  ╚═╝  ╚═══╝  ╚══════╝╚═╝  ╚═╝ started...
    
        `,
                'font-family:monospace'
            );

            log.info('Server config', getServerConfig());

            // Warn if default secrets are still in use
            if (config.api?.keySecret === 'mirotalksfu_default_secret') {
                log.warn('WARNING: API_KEY_SECRET is set to the default value. Change it before deploying!');
            }
        });
    }

    // ####################################################
    // WORKERS
    // ####################################################

    (async () => {
        try {
            await createWorkers();
            startServer();
        } catch (err) {
            log.error('Create Worker ERROR --->', err);
            process.exit(1);
        }
    })();

    async function createWorkers() {
        const { numWorkers } = config.mediasoup;

        const { logLevel, logTags, disableLiburing } = config.mediasoup.worker;

        log.info('WORKERS:', numWorkers);

        for (let i = 0; i < numWorkers; i++) {
            //
            const worker = await mediasoup.createWorker({
                logLevel: logLevel,
                logTags: logTags,
                disableLiburing: Boolean(disableLiburing),
            });

            if (webRtcServerActive) {
                const webRtcServerOptions = clone(config.mediasoup.webRtcServerOptions);
                const portIncrement = i;

                for (const listenInfo of webRtcServerOptions.listenInfos) {
                    if (!listenInfo.portRange) {
                        listenInfo.port += portIncrement;
                    }
                }

                log.info('Create a WebRtcServer', {
                    worker_pid: worker.pid,
                    webRtcServerOptions: webRtcServerOptions,
                });

                const webRtcServer = await worker.createWebRtcServer(webRtcServerOptions);
                worker.appData.webRtcServer = webRtcServer;
            }

            worker.on('died', () => {
                log.error('Mediasoup worker died, exiting in 5 seconds...', worker.pid);

                setTimeout(() => process.exit(1), 5000);
            });

            workers.push(worker);

            /*
            setInterval(async () => {
                const usage = await worker.getResourceUsage();
                log.debug('mediasoup Worker resource usage', { worker_pid: worker.pid, usage: usage });
                const dump = await worker.dump();
                log.debug('mediasoup Worker dump', { worker_pid: worker.pid, dump: dump });
            }, 120000);
            */
        }
    }

    async function getMediasoupWorker() {
        const worker = workers[nextMediasoupWorkerIdx];
        if (++nextMediasoupWorkerIdx === workers.length) nextMediasoupWorkerIdx = 0;
        return worker;
    }

    // ####################################################
    // SOCKET IO
    // ####################################################

    const PRE_JOIN_EVENTS = new Set(['createRoom', 'join', 'clientError', 'error']);

    io.on('connection', (socket) => {
        // Security: only sockets that were admitted to the room (join accepted, lobby included) may use
        // room events. Rejected/unjoined sockets can still be bound to a room id by 'createRoom'.
        socket.use((packet, next) => {
            const [event, payload] = packet;
            if (PRE_JOIN_EVENTS.has(event)) return next();
            if (event === 'roomAction' && payload?.action === 'checkPassword') return next();
            if (roomExists(socket) && getPeer(socket)) return next();

            log.warn('Blocked event from a socket that is not a room member', { event, peer_id: socket.id });
            const ack = packet[packet.length - 1];
            if (typeof ack === 'function') ack({ error: 'Not in room' });
        });

        socket.on('clientError', (error) => {
            try {
                log.error('Client error', error.message);
                socket.disconnect(true); // true indicates a forced disconnection
            } catch (error) {
                log.error('Error handling Client error', error.message);
            }
        });

        socket.on('error', (error) => {
            try {
                log.error('Socket error', error.message);
                socket.disconnect(true); // true indicates a forced disconnection
            } catch (error) {
                log.error('Error handling socket error', error.message);
            }
        });

        socket.on('createRoom', async ({ room_id, token }, callback) => {
            // Security: reject invalid room ids (XSS / path traversal / empty).
            if (!Validator.isValidRoomName(room_id)) {
                log.warn('[createRoom] - Invalid room name', { room_id });
                return callback({ error: 'invalid room name' });
            }

            // Joining an existing meeting is not a creation: not rate-limited, so a whole office
            // behind one public IP can join at the same time.
            if (roomList.has(room_id)) {
                socket.room_id = room_id;
                return callback({ error: 'already exists' });
            }

            // Security: per-IP rate limit to prevent roomList spam/enumeration.
            const ip = getIpSocket(socket);
            if (!checkCreateRoomLimit(ip)) {
                log.warn('[createRoom] - Rate limit exceeded', { ip, room_id });
                return callback({
                    error: `Too many room creation requests. Please try again after ${minutesLabel(createRoomLimiterMinutes)}.`,
                });
            }

            // Security: only the admin (or a presenter-opened breakout room) gets a creation token.
            if (!isCreateRoomTokenValid(token, room_id)) {
                log.warn('[createRoom] - Room creation not authorized', { ip, room_id });
                return callback({ error: 'Room creation not authorized' });
            }

            socket.room_id = room_id;

            try {
                const worker = await getMediasoupWorker();
                const room = await new Room(socket.room_id, worker, io).ready();
                roomList.set(socket.room_id, room);
                roomRegistry.opened(socket.room_id);
                log.debug('Created room', { room_id: socket.room_id });
                callback({ room_id: socket.room_id });
            } catch (error) {
                log.error('Create room failed', { room_id: socket.room_id, error: error.message });
                callback({ error: 'Failed to initialize room' });
            }
        });

        socket.on('join', async (dataObject, cb) => {
            if (!roomExists(socket)) {
                return cb({
                    error: 'Room does not exist',
                });
            }

            // Get peer IPv4 (::1 Its the loopback address in ipv6, equal to 127.0.0.1 in ipv4)
            const peer_ip = getIpSocket(socket);

            const data = checkXSS(dataObject);

            // Never trust nor log client-side role/token fields
            if (data?.peer_info) {
                delete data.peer_info.peer_token;
                data.peer_info.peer_presenter = false;
            }

            log.debug('User joined', data);

            if (!Validator.isValidRoomName(socket.room_id)) {
                log.warn('[Join] - Invalid room name', socket.room_id);
                return cb('invalid');
            }

            const room = getRoom(socket);

            const { peer_name, peer_id, peer_uuid, os_name, os_version, browser_name, browser_version } =
                data.peer_info;

            // TLLM*meet: the presenter role comes only from a verified session (cookie sent with the Socket.IO
            // handshake): an admin in every room, a moderator in their own rooms. Client flags
            // (peer_presenter, peer_token) are ignored.
            const admin = adminAuth.fromSocket(socket);
            const is_presenter = ownsRoom(admin, socket.room_id);

            // check if banned...
            if (room.isBanned(peer_uuid)) {
                log.debug('[Join] - peer is banned!', {
                    room_id: data.room_id,
                    peer: {
                        name: peer_name,
                        uuid: peer_uuid,
                        os_name: os_name,
                        os_version: os_version,
                        browser_name: browser_name,
                        browser_version: browser_version,
                    },
                });
                return cb('isBanned');
            }

            const usernameExists = [...room.getPeers().values()].some(
                (peer) => peer.id !== socket.id && peer.peer_name === peer_name
            );
            if (usernameExists) return cb('isNameInUse');

            // The admin (or the moderator who owns the room) is always presenter (and cannot be demoted). A guest is presenter only if a
            // presenter promoted this very socket during the meeting (stored server-side).
            const configuredPresenter = is_presenter;
            const shouldRegisterPresenter = is_presenter;
            const isPresenter = is_presenter || isPeerPresenter(socket.room_id, socket.id, peer_name, peer_uuid);

            // Security: admission checks must run BEFORE the peer is added to the room, otherwise a
            // rejected peer would keep access to the media plane and room broadcasts.
            if (room.isJoinLocked() && !isPresenter) {
                log.debug('The user was rejected because the room is locked for new participants');
                return cb('isJoinLocked');
            }

            if (room.isLocked() && !isPresenter && !isSocketUnlocked(socket, room)) {
                log.debug('The user was rejected because the room is locked, and they are not a presenter');
                return cb('isLocked');
            }

            // Remove old peer with same socket.id before adding new one
            const existingPeer = room.getPeer(socket.id);
            if (existingPeer) {
                room.removePeer(socket.id);
            }

            room.addPeer(new Peer(socket.id, data));

            if (!(socket.room_id in presenters)) presenters[socket.room_id] = {};

            // Set the presenters
            const presenter = {
                peer_ip: peer_ip,
                peer_name: peer_name,
                peer_uuid: peer_uuid,
                is_presenter: is_presenter,
                is_configured_presenter: configuredPresenter,
            };

            // Register the admin as presenter of this room
            if (shouldRegisterPresenter) {
                presenter.is_presenter = true;
                presenters[socket.room_id][socket.id] = presenter;
            }

            log.debug('[Join] - Connected presenters grp by roomId', presenters);

            const peer = room.getPeer(socket.id);

            if (!peer) {
                return cb({
                    error: 'Peer does not exist in the room',
                });
            }

            log.debug('[Join] - Is Peer presenter', {
                roomId: socket.room_id,
                peer_name: peer_name,
                peer_presenter: isPresenter,
            });

            peer.updatePeerInfo({ type: 'presenter', status: isPresenter });

            if ((room.isLobbyEnabled() || room.isGlobalLobbyEnabled()) && !isPresenter) {
                log.debug(
                    'The user is currently waiting to join the room because the lobby is enabled, and they are not a presenter'
                );
                peer.updatePeerInfo({ type: 'lobby', status: true });
                room.broadCast(socket.id, 'roomLobby', {
                    peer_id: peer_id,
                    peer_name: peer_name,
                    lobby_status: 'waiting',
                });
                return cb('isLobby');
            }

            // Notify main room when a peer joins a breakout room
            if (socket.room_id.includes('_breakout_')) {
                notifyMainRoomBreakoutCountChanged(socket.room_id);
            }

            const roomJson = room.toJson();

            cb(roomJson);
        });

        socket.on('getRouterRtpCapabilities', (_, callback) => {
            if (!roomExists(socket)) {
                return callback({ error: 'Room not found' });
            }

            const { room, peer } = getRoomAndPeer(socket);

            if (isPeerInLobby(peer)) {
                return callback({ error: 'In lobby' });
            }

            const peerInfo = getPeerInfo(peer);

            log.debug('Request: getRouterRtpCapabilities', peerInfo);

            try {
                const rtpCapabilities = room.getRtpCapabilities();
                callback(rtpCapabilities);
            } catch (err) {
                log.error('Failed to get Router RTP Capabilities', {
                    error: err.message,
                    peerInfo,
                });
                callback({ error: err.message });
            }
        });

        socket.on('createWebRtcTransport', async (_, callback) => {
            if (!roomExists(socket)) {
                return callback({ error: 'Room not found' });
            }

            const { room, peer } = getRoomAndPeer(socket);

            if (isPeerInLobby(peer)) {
                return callback({ error: 'In lobby' });
            }

            const peerInfo = getPeerInfo(peer);

            log.debug('Create WebRTC transport request received', peerInfo);

            try {
                const createWebRtcTransport = await room.createWebRtcTransport(socket.id);
                callback(createWebRtcTransport);
            } catch (err) {
                log.warn('Create WebRTC Transport warning', { error: err.message, peerInfo });
                callback({ error: err.message });
            }
        });

        socket.on('connectTransport', async ({ transport_id, dtlsParameters }, callback) => {
            if (!roomExists(socket)) {
                return callback({ error: 'Room not found' });
            }

            const { room, peer } = getRoomAndPeer(socket);

            if (isPeerInLobby(peer)) {
                return callback({ error: 'In lobby' });
            }

            const peerInfo = getPeerInfo(peer);

            log.debug('Connect transport request received', { transport_id, peerInfo });

            try {
                const connectTransport = await room.connectPeerTransport(socket.id, transport_id, dtlsParameters);
                callback(connectTransport);
            } catch (err) {
                log.warn('Connect transport warning', { error: err.message, peerInfo });
                callback({ error: err.message });
            }
        });

        socket.on('restartIce', async ({ transport_id }, callback) => {
            if (!roomExists(socket)) {
                return callback({ error: 'Room not found' });
            }

            const peer = getPeer(socket);

            if (!peer) {
                return callback({ error: 'Peer not found' });
            }

            if (isPeerInLobby(peer)) {
                return callback({ error: 'In lobby' });
            }

            const peerInfo = getPeerInfo(peer);

            log.debug('Restart ICE request received', { transport_id: transport_id, peerInfo });

            try {
                const transport = peer.getTransport(transport_id);

                if (!transport) {
                    log.warn(`Restart ICE attempt failed. Transport with ID "${transport_id}" not found.`);
                    return callback({ error: `Transport with id "${transport_id}" not found` });
                }

                const iceParameters = await transport.restartIce();

                log.debug('ICE Restart successful', { transport_id: transport_id, iceParameters });

                callback(iceParameters);
            } catch (err) {
                log.warn('Restart ICE warning', { error: err.message, peerInfo });
                callback({ error: err.message });
            }
        });

        socket.on('produce', async ({ producerTransportId, kind, appData, rtpParameters }, callback, errback) => {
            if (!roomExists(socket)) {
                return callback({ error: 'Room not found' });
            }

            const { room, peer } = getRoomAndPeer(socket);

            if (!peer) {
                return callback({ error: 'Peer not found' });
            }

            if (isPeerInLobby(peer)) {
                return callback({ error: 'In lobby' });
            }

            // TLLM*meet: screen sharing is for presenters and for the people they allowed
            if (appData?.mediaType === 'screenType' && !canShareSocket(socket)) {
                return callback({ error: 'Screen sharing not allowed' });
            }

            const peerInfo = getPeerInfo(peer);

            const data = {
                room_id: room.id,
                peer_name: peerInfo.peer_name,
                peer_id: socket.id,
                kind: kind,
                type: appData.mediaType,
                status: true,
            };

            peer.updatePeerInfo(data);

            try {
                const producer_id = await room.produce(
                    socket.id,
                    producerTransportId,
                    rtpParameters,
                    kind,
                    appData.mediaType
                );

                log.debug('Produce', {
                    kind: kind,
                    type: appData.mediaType,
                    producer_id: producer_id,
                    peer_id: socket.id,
                    peerInfo: peerInfo,
                });

                // add & monitor producer audio level and dominant speaker
                if (kind === 'audio') {
                    await Promise.all([
                        room.addProducerToAudioLevelObserver({ producerId: producer_id }),
                        room.addProducerToActiveSpeakerObserver({ producerId: producer_id }),
                    ]);
                }

                callback({ producer_id });
            } catch (err) {
                log.warn('Producer transport error', {
                    error: err,
                    peerInfo,
                });
                callback({ error: err.message });
            }
        });

        socket.on('consume', async ({ consumerTransportId, producerId, rtpCapabilities, type }, callback) => {
            if (!roomExists(socket)) {
                return callback({ error: 'Room not found' });
            }

            const { room, peer } = getRoomAndPeer(socket);

            if (!peer) {
                return callback({ error: 'Peer not found' });
            }

            if (isPeerInLobby(peer)) {
                return callback({ error: 'In lobby' });
            }

            const peerInfo = getPeerInfo(peer);

            try {
                const params = await room.consume(socket.id, consumerTransportId, producerId, rtpCapabilities, type);

                log.debug('Consuming', {
                    producer_type: type,
                    producer_id: producerId,
                    consumer_id: params ? params.id : undefined,
                    peerInfo: peerInfo,
                });

                callback(params);
            } catch (err) {
                const producerUnavailable = err.code === 'PRODUCER_NOT_FOUND';
                const details = {
                    error: err,
                    type,
                    consumerTransportId,
                    producerId,
                    rtpCapabilities,
                    peerInfo,
                };

                if (producerUnavailable) {
                    log.debug('Consumer skipped because producer is no longer available', details);
                } else {
                    log.warn('Consumer transport error', details);
                }

                callback({ error: err.message, code: err.code, retryable: err.retryable });
            }
        });

        // ####################################################
        // DATA CHANNEL (DataProducer / DataConsumer)
        // ####################################################

        socket.on('produceData', async ({ transportId, sctpStreamParameters, label, protocol, appData }, callback) => {
            if (!roomExists(socket)) {
                return callback({ error: 'Room not found' });
            }

            const { room, peer } = getRoomAndPeer(socket);

            if (!peer) {
                return callback({ error: 'Peer not found' });
            }

            if (isPeerInLobby(peer)) {
                return callback({ error: 'In lobby' });
            }

            const peerInfo = getPeerInfo(peer);

            try {
                const dataProducerId = await room.produceData(
                    socket.id,
                    transportId,
                    sctpStreamParameters,
                    label,
                    protocol,
                    appData
                );

                log.debug('ProduceData', {
                    dataProducer_id: dataProducerId,
                    peer_id: socket.id,
                    label: label,
                    peerInfo: peerInfo,
                });

                callback({ id: dataProducerId });
            } catch (err) {
                log.warn('ProduceData error', {
                    error: err.message,
                    peerInfo,
                });
                callback({ error: err.message });
            }
        });

        socket.on('consumeData', async ({ consumerTransportId, dataProducerId }, callback) => {
            if (!roomExists(socket)) {
                return callback({ error: 'Room not found' });
            }

            const { room, peer } = getRoomAndPeer(socket);

            if (!peer) {
                return callback({ error: 'Peer not found' });
            }

            if (isPeerInLobby(peer)) {
                return callback({ error: 'In lobby' });
            }

            const peerInfo = getPeerInfo(peer);

            try {
                const params = await room.consumeData(socket.id, consumerTransportId, dataProducerId);

                log.debug('ConsumeData', {
                    dataProducer_id: dataProducerId,
                    dataConsumer_id: params ? params.id : undefined,
                    peerInfo: peerInfo,
                });

                callback(params);
            } catch (err) {
                log.warn('ConsumeData error', {
                    error: err.message,
                    consumerTransportId,
                    dataProducerId,
                    peerInfo,
                });
                callback({ error: err.message });
            }
        });

        socket.on('getDataProducers', () => {
            if (!roomExists(socket)) return;

            const { room, peer } = getRoomAndPeer(socket);

            if (isPeerInLobby(peer)) return;

            const peerInfo = getPeerInfo(peer);

            log.debug('Get Data Producers', peerInfo);

            const dataProducerList = room.getDataProducerListForPeer(socket.id);

            // Notify the requesting peer about existing data producers
            for (const dataProducerInfo of dataProducerList) {
                socket.emit('newDataProducer', dataProducerInfo);
            }
        });

        socket.on('producerClosed', (data) => {
            if (!roomExists(socket)) return;

            const { room, peer } = getRoomAndPeer(socket);

            if (isPeerInLobby(peer)) return;

            const peerInfo = getPeerInfo(peer);

            if (peer) peer.updatePeerInfo(data); // peer_info.audio OR video OFF

            try {
                room.closeProducer(socket.id, data.producer_id);
            } catch (err) {
                log.warn('Producer Close error', {
                    error: err.message,
                    peerInfo,
                });
            }
        });

        socket.on('pauseProducer', async ({ producer_id, type }, callback) => {
            if (!roomExists(socket)) {
                return callback({ error: 'Room not found' });
            }

            const peer = getPeer(socket);

            if (!peer) {
                return callback({
                    error: `Peer with ID: ${socket.id} for producer with id "${producer_id}" type "${type}" not found`,
                });
            }

            if (isPeerInLobby(peer)) {
                return callback({ error: 'In lobby' });
            }

            const producer = peer.getProducer(producer_id);

            if (!producer) {
                return callback({ error: `Producer with id "${producer_id}" type "${type}" not found` });
            }

            const peerInfo = getPeerInfo(peer);

            try {
                await producer.pause();

                log.debug('Producer paused', { producer_id, type, peerInfo });

                callback('successfully');
            } catch (error) {
                log.warn('Pause producer', {
                    error: error,
                    peerInfo,
                });
                callback({ error: error.message });
            }
        });

        socket.on('resumeProducer', async ({ producer_id, type }, callback) => {
            if (!roomExists(socket)) {
                return callback({ error: 'Room not found' });
            }

            const peer = getPeer(socket);

            if (!peer) {
                return callback({
                    error: `peer with ID: "${socket.id}" for producer with id "${producer_id}" type "${type}" not found`,
                });
            }

            if (isPeerInLobby(peer)) {
                return callback({ error: 'In lobby' });
            }

            const producer = peer.getProducer(producer_id);

            if (!producer) {
                return callback({ error: `producer with id "${producer_id}" type "${type}" not found` });
            }

            const peerInfo = getPeerInfo(peer);

            try {
                await producer.resume();

                log.debug('Producer resumed', { producer_id, type, peerInfo });

                callback('successfully');
            } catch (error) {
                log.warn('Resume producer', {
                    error: error,
                    peerInfo,
                });
                callback({ error: error.message });
            }
        });

        socket.on('resumeConsumer', async ({ consumer_id, type }, callback) => {
            if (!roomExists(socket)) {
                return callback({ error: 'Room not found' });
            }

            const peer = getPeer(socket);

            if (!peer) {
                return callback({
                    error: `peer with ID: "${socket.id}" for consumer with id "${consumer_id}" type "${type}" not found`,
                });
            }

            if (isPeerInLobby(peer)) {
                return callback({ error: 'In lobby' });
            }

            const consumer = peer.getConsumer(consumer_id);

            if (!consumer) {
                return callback({ error: `consumer with id "${consumer_id}" type "${type}" not found` });
            }

            const peerInfo = getPeerInfo(peer);

            try {
                await consumer.resume();

                log.debug('Consumer resumed', { consumer_id, type, peerInfo });

                callback('successfully');
            } catch (error) {
                log.warn('Resume consumer', {
                    error: error,
                    peerInfo,
                });
                callback({ error: error.message });
            }
        });

        socket.on('getProducers', (data, callback) => {
            if (!roomExists(socket)) return callback?.({ error: 'Room not found' });

            const { room, peer } = getRoomAndPeer(socket);

            if (isPeerInLobby(peer)) return callback?.({ error: 'In lobby' });

            const { peer_name } = peer || 'undefined';

            log.debug('Get producers', peer_name);

            // send all the current producer to newly joined member (excluding own producers)
            const producerList = room.getProducerListForPeer(socket.id);
            const knownProducerIds = new Set(
                Array.isArray(data?.knownProducerIds)
                    ? data.knownProducerIds
                          .slice(0, producerList.length)
                          .filter((producerId) => typeof producerId === 'string')
                    : []
            );
            const missingProducers = knownProducerIds.size
                ? producerList.filter(({ producer_id }) => !knownProducerIds.has(producer_id))
                : producerList;

            callback ? callback(missingProducers) : socket.emit('newProducers', missingProducers);
        });

        socket.on('getPeerCounts', async ({}, callback) => {
            if (!roomExists(socket)) {
                return callback({ error: 'Room not found' });
            }

            const room = getRoom(socket);

            const peerCounts = room.getPeersCount();

            log.debug('Peer counts', { peerCounts: peerCounts });

            callback({ peerCounts: peerCounts });
        });

        socket.on('cmd', async (dataObject) => {
            if (!roomExists(socket)) return;

            const data = checkXSS(dataObject);

            log.debug('cmd', data);

            if (!Validator.isValidData(data)) return;

            const room = getRoom(socket);

            const peer = getPeer(socket);

            if (!room || !peer) return;

            switch (data.type) {
                case 'privacy':
                    peer.updatePeerInfo({ type: data.type, status: data.active });
                    break;
                case 'ejectAll':
                    const { peer_name, peer_uuid } = data;
                    const isPresenter = isPeerPresenter(socket.room_id, socket.id, peer_name, peer_uuid);
                    if (!isPresenter) return;
                    // Only the server API (endMeeting) may force a redirect, never a peer
                    delete data.redirect;
                    break;
                case 'peerAudio':
                    // Keep producer volume to update consumer on join room...
                    if (data.audioProducerId) {
                        peer.updatePeerInfo({ type: data.type, volume: data.volume * 100 });
                    }
                    break;
                default:
                    break;
                //...
            }

            data.broadcast ? room.broadCast(socket.id, 'cmd', data) : room.sendTo(data.peer_id, 'cmd', data);
        });

        socket.on('roomAction', async (dataObject) => {
            if (!roomExists(socket)) return;

            const data = checkXSS(dataObject);

            if (!Validator.isValidData(data)) {
                log.warn('Room action invalid data', { peer_id: socket.id, room_id: socket.room_id });
                return;
            }

            log.debug('Room action:', { ...data, password: data.password ? '***' : data.password });

            const isPresenter = isPeerPresenter(socket.room_id, socket.id, data.peer_name, data.peer_uuid);

            const room = getRoom(socket);

            switch (data.action) {
                case 'broadcasting':
                    if (!isPresenter) return;
                    room.setIsBroadcasting(data.room_broadcasting);
                    room.broadCast(socket.id, 'roomAction', {
                        action: data.action,
                        room_broadcasting: data.room_broadcasting,
                    });
                    break;
                case 'lock':
                    if (!isPresenter) return;
                    if (typeof data.password !== 'string' || !data.password) return;
                    if (!room.isLocked()) {
                        room.setLocked(true, data.password);
                        room.broadCast(socket.id, 'roomAction', data.action);
                    }
                    break;
                case 'checkPassword': {
                    // Pre-join check, so the sender is not a room member: throttle guesses per IP + room
                    const ip = getIpSocket(socket);
                    const roomData = {
                        room: null,
                        password: 'KO',
                    };
                    if (room.isLocked() && !RoomPassword.isBlocked(ip, room.id)) {
                        if (RoomPassword.passwordMatches(data.password, room.getPassword())) {
                            RoomPassword.recordSuccess(ip, room.id);
                            // The client must re-send 'join': the password only unlocks admission for this socket
                            socket.roomUnlock = { room_id: room.id, password: room.getPassword() };
                            roomData.password = 'OK';
                        } else {
                            RoomPassword.recordFailure(ip, room.id);
                        }
                    }
                    // The sender is not a room member yet, so reply directly on the socket
                    socket.emit('roomPassword', roomData);
                    break;
                }
                case 'unlock':
                    if (!isPresenter) return;
                    room.setLocked(false);
                    room.broadCast(socket.id, 'roomAction', data.action);
                    break;
                case 'globalLobbyOn':
                    if (!room.isGlobalLobbyEnabled()) return;
                    room.setLobbyEnabled(true);
                    break;
                case 'lobbyOn':
                    if (!isPresenter) return;
                    room.setLobbyEnabled(true);
                    room.broadCast(socket.id, 'roomAction', data.action);
                    break;
                case 'lobbyOff':
                    if (!isPresenter) return;
                    room.setLobbyEnabled(false);
                    room.broadCast(socket.id, 'roomAction', data.action);
                    break;
                case 'joinLockOn':
                    if (!isPresenter) return;
                    room.setJoinLocked(true);
                    room.broadCast(socket.id, 'roomAction', data.action);
                    break;
                case 'joinLockOff':
                    if (!isPresenter) return;
                    room.setJoinLocked(false);
                    room.broadCast(socket.id, 'roomAction', data.action);
                    break;
                case 'hostOnlyRecordingOn':
                    if (!isPresenter) return;
                    room.setHostOnlyRecording(true);
                    room.broadCast(socket.id, 'roomAction', data.action);
                    break;
                case 'hostOnlyRecordingOff':
                    if (!isPresenter) return;
                    room.setHostOnlyRecording(false);
                    room.broadCast(socket.id, 'roomAction', data.action);
                    break;
                case 'isBanned':
                    if (!isPresenter) return;
                    log.debug('The user has been banned from the room due to spamming messages', data);
                    room.addBannedPeer(data.peer_uuid);
                    break;
                default:
                    break;
            }
            log.debug('Room status', {
                broadcasting: room.isBroadcasting(),
                locked: room.isLocked(),
                lobby: room.isLobbyEnabled(),
                joinLocked: room.isJoinLocked(),
                hostOnlyRecording: room.isHostOnlyRecording(),
            });
        });

        socket.on('roomLobby', (dataObject) => {
            if (!roomExists(socket)) return;

            const data = checkXSS(dataObject);

            const room = getRoom(socket);

            const peer = room.getPeer(socket.id);
            if (!peer) return;
            const isPresenter = isPeerPresenter(
                socket.room_id,
                socket.id,
                peer.peer_info?.peer_name,
                peer.peer_info?.peer_uuid
            );
            if (!isPresenter) return;

            data.room = room.toJson();

            log.debug('Room lobby', {
                peer_id: data.peer_id,
                peer_name: data.peer_name,
                peers_id: data.peers_id,
                lobby: data.lobby_status,
                broadcast: data.broadcast,
            });

            const pears_id = data.peers_id ? data.peers_id : [data.peer_id];

            // Also send to all presenters to update lobby UI on there side
            const send_to_pears_id = pears_id.concat(room.getPresenterPeers().map((peer) => peer.id));

            for (const peer_id of send_to_pears_id) {
                room.sendTo(peer_id, 'roomLobby', data);
            }

            if (data.lobby_status === 'accept') {
                for (const peer_id of pears_id) {
                    const peer = room.getPeer(peer_id);
                    if (!peer) {
                        log.warn('Lobby accept skipped - peer not found', {
                            peer_id: peer_id,
                            room_id: room.id,
                        });
                        continue;
                    }
                    if (!peer.peer_lobby) continue;

                    peer.updatePeerInfo({ type: 'lobby', status: false });
                }
            }
        });

        // ####################################################
        // BREAKOUT ROOMS
        // ####################################################

        socket.on('getBreakoutRoomsInfo', async ({ mainRoom }, callback) => {
            if (!roomExists(socket)) return callback([]);

            const breakoutRooms = [];
            for (const [roomId, room] of roomList) {
                if (roomId.startsWith(mainRoom + '_breakout_')) {
                    const peerNames = [];
                    room.getPeers().forEach((peer) => {
                        if (peer.peer_name) peerNames.push(peer.peer_name);
                    });
                    breakoutRooms.push({
                        room: roomId,
                        peers: room.getPeersCount(),
                        peerNames: peerNames,
                    });
                }
            }
            callback(breakoutRooms);
        });

        socket.on('breakoutRoomBroadcast', async (dataObject) => {
            if (!roomExists(socket)) return;

            const data = checkXSS(dataObject);

            log.debug('Breakout room broadcast', data);

            const isPresenter = isPeerPresenter(socket.room_id, socket.id, data.peer_name, data.peer_uuid);

            if (!isPresenter) return;

            const { mainRoom, targetRoom, message } = data;
            if (!message || !mainRoom) return;

            const msgData = {
                peer_name: data.peer_name,
                message: message,
            };

            if (targetRoom) {
                // Send to a specific breakout room
                const room = roomList.get(targetRoom);
                if (room) room.sendToAll('breakoutRoomMessage', msgData);
            } else {
                // Send to all breakout rooms
                for (const [roomId, room] of roomList) {
                    if (roomId.startsWith(mainRoom + '_breakout_')) {
                        room.sendToAll('breakoutRoomMessage', msgData);
                    }
                }
            }
        });

        socket.on('breakoutRoomEnd', async (dataObject) => {
            if (!roomExists(socket)) return;

            const data = checkXSS(dataObject);

            log.debug('Breakout room end all', data);

            const isPresenter = isPeerPresenter(socket.room_id, socket.id, data.peer_name, data.peer_uuid);

            if (!isPresenter) return;

            const { mainRoom } = data;
            if (!mainRoom) return;

            // Force all peers in breakout rooms to return to main room
            for (const [roomId, room] of roomList) {
                if (roomId.startsWith(mainRoom + '_breakout_')) {
                    room.sendToAll('breakoutRoomEnd', { mainRoom });
                }
            }
        });

        socket.on('breakoutRoomCountdown', async (dataObject) => {
            if (!roomExists(socket)) return;

            const data = checkXSS(dataObject);

            log.debug('Breakout room countdown', data);

            const isPresenter = isPeerPresenter(socket.room_id, socket.id, data.peer_name, data.peer_uuid);

            if (!isPresenter) return;

            const { mainRoom, countdown } = data;
            if (!mainRoom || !countdown) return;

            const seconds = Math.min(Math.max(parseInt(countdown) || 0, 0), 300);

            for (const [roomId, room] of roomList) {
                if (roomId.startsWith(mainRoom + '_breakout_')) {
                    room.sendToAll('breakoutRoomCountdown', { mainRoom, countdown: seconds });
                }
            }
        });

        socket.on('breakoutRoomHelp', async (dataObject) => {
            if (!roomExists(socket)) return;

            const data = checkXSS(dataObject);

            log.debug('Breakout room help request', data);

            const { mainRoom, peer_name, breakoutRoom } = data;
            if (!mainRoom || !peer_name || !breakoutRoom) return;

            // Send help request to all peers in the main room (presenter will handle it)
            const room = roomList.get(mainRoom);
            if (room) {
                room.sendToAll('breakoutRoomHelp', {
                    peer_name: peer_name,
                    breakoutRoom: breakoutRoom,
                });
            }
        });

        socket.on('breakoutRoom', async (dataObject) => {
            if (!roomExists(socket)) return;

            const data = checkXSS(dataObject);

            log.debug('Breakout room', data);

            const isPresenter = isPeerPresenter(socket.room_id, socket.id, data.peer_name, data.peer_uuid);

            if (!isPresenter) return;

            const room = getRoom(socket);
            if (!room) return;

            // Send breakout room assignment to each assigned peer
            const { assignments, mainRoom } = data;
            if (assignments && Array.isArray(assignments)) {
                for (const assignment of assignments) {
                    const { peerId, breakoutRoom, duration, roomName } = assignment;
                    // Only breakout rooms of the presenter's own room, which guests may then create
                    if (
                        typeof breakoutRoom !== 'string' ||
                        !breakoutRoom.startsWith(socket.room_id + '_breakout_') ||
                        !Validator.isValidRoomName(breakoutRoom)
                    ) {
                        continue;
                    }
                    adminAuth.allowBreakout(breakoutRoom);
                    room.sendTo(peerId, 'breakoutRoom', {
                        action: 'assign',
                        breakoutRoom: breakoutRoom,
                        mainRoom: mainRoom,
                        duration: duration || 'unlimited',
                        roomName: roomName || breakoutRoom,
                    });
                }
            }
        });

        // ####################################################
        // BREAKOUT ROOMS END
        // ####################################################

        socket.on('peerAction', async (dataObject) => {
            if (!roomExists(socket)) return;

            const data = checkXSS(dataObject);

            log.debug('Peer action', data);

            if (!Validator.isValidData(data)) return;

            const presenterActions = [
                'mute',
                'unmute',
                'hide',
                'unhide',
                'stop',
                'start',
                'eject',
                'ban',
                'geoLocation',
            ];

            if (presenterActions.some((v) => data.action === v)) {
                const isPresenter = isPeerPresenter(
                    socket.room_id,
                    socket.id,
                    data.from_peer_name,
                    data.from_peer_uuid
                );
                if (!isPresenter) return;
            }

            const room = getRoom(socket);

            if (data.action === 'ban') room.addBannedPeer(data.to_peer_uuid);

            data.broadcast
                ? room.broadCast(data.peer_id, 'peerAction', data)
                : room.sendTo(data.peer_id, 'peerAction', data);
        });

        socket.on('setPresenterRole', async (dataObject) => {
            if (!roomExists(socket)) return;

            const data = checkXSS(dataObject);

            if (!Validator.isValidData(data)) return;

            // Only an existing presenter can grant or revoke the presenter role
            const isPresenter = isPeerPresenter(socket.room_id, socket.id, data.from_peer_name, data.from_peer_uuid);
            if (!isPresenter) return;

            const room = getRoom(socket);
            if (!room) return;

            const targetPeer = room.getPeer(data.peer_id);
            if (!targetPeer) return;

            const grant = data.action === 'grant';

            // A presenter authenticated from the host configuration cannot be demoted at runtime.
            const targetPresenter = presenters[socket.room_id]?.[data.peer_id];
            if (!grant && targetPresenter?.is_configured_presenter === true) {
                log.debug('setPresenterRole - cannot revoke a configured presenter', {
                    peer_name: targetPeer.peer_name,
                });
                return;
            }

            if (!(socket.room_id in presenters)) presenters[socket.room_id] = {};

            if (grant) {
                presenters[socket.room_id][data.peer_id] = {
                    peer_ip: targetPeer.peer_info?.peer_ip || '',
                    peer_name: targetPeer.peer_name,
                    peer_uuid: targetPeer.peer_uuid,
                    is_presenter: true,
                };
            } else if (presenters[socket.room_id]) {
                delete presenters[socket.room_id][data.peer_id];
            }

            targetPeer.updatePeerInfo({ type: 'presenter', status: grant });

            log.debug('setPresenterRole', {
                room_id: socket.room_id,
                from: data.from_peer_name,
                target: targetPeer.peer_name,
                grant: grant,
            });

            // Notify everyone (including the target and the sender) to refresh roles/UI
            room.sendToAll('setPresenterRole', {
                peer_id: data.peer_id,
                peer_name: targetPeer.peer_name,
                is_presenter: grant,
                from_peer_name: data.from_peer_name,
            });

            // The new role changes what the target sees in polls (who voted what)
            if (room.thereIsPolls()) sendPolls(room, data.peer_id);
        });

        socket.on('updatePeerInfo', (dataObject) => {
            if (!roomExists(socket)) return;

            const { room, peer } = getRoomAndPeer(socket);

            if (!peer) return;

            const data = checkXSS(dataObject);

            if (!Validator.isValidData(data)) return;

            // Security: presenter and lobby states are server-managed. A client could otherwise
            // leave the lobby on its own (media access) or advertise itself as presenter.
            if (data?.type === 'presenter' || data?.type === 'lobby') {
                log.warn('updatePeerInfo - blocked server-managed field', { type: data.type, peer_id: socket.id });
                return;
            }

            peer.updatePeerInfo(data);

            if (data.broadcast) {
                log.debug('updatePeerInfo broadcast data');
                room.broadCast(socket.id, 'updatePeerInfo', data);
            }
        });

        socket.on('updateRoomModerator', (dataObject) => {
            if (!roomExists(socket)) return;

            const data = checkXSS(dataObject);

            if (!Validator.isValidData(data)) return;

            const room = getRoom(socket);

            const isPresenter = isPeerPresenter(socket.room_id, socket.id, data.peer_name, data.peer_uuid);

            if (!isPresenter) return;

            const moderator = data.moderator;

            room.updateRoomModerator(moderator);

            switch (moderator.type) {
                case 'video_start_privacy':
                case 'audio_start_muted':
                case 'video_start_hidden':
                case 'audio_cant_unmute':
                case 'video_cant_unhide':
                case 'screen_cant_share':
                case 'screen_annotations_cant_draw':
                case 'chat_cant_privately':
                case 'chat_cant_publicly':
                case 'media_cant_sharing':
                case 'polls_cant_create':
                    room.broadCast(socket.id, 'updateRoomModerator', moderator);
                    break;
                default:
                    break;
            }
        });

        socket.on('updateRoomModeratorALL', (dataObject) => {
            if (!roomExists(socket)) return;

            const data = checkXSS(dataObject);

            if (!Validator.isValidData(data)) return;

            const room = getRoom(socket);

            const isPresenter = isPeerPresenter(socket.room_id, socket.id, data.peer_name, data.peer_uuid);

            if (!isPresenter) return;

            const moderator = data.moderator;

            room.updateRoomModeratorALL(moderator);

            room.broadCast(socket.id, 'updateRoomModeratorALL', moderator);
        });

        socket.on('followMe', (dataObject) => {
            if (!roomExists(socket)) return;

            const data = checkXSS(dataObject);

            if (!Validator.isValidData(data)) return;

            const room = getRoom(socket);

            const isPresenter = isPeerPresenter(socket.room_id, socket.id, data.peer_name, data.peer_uuid);

            if (!isPresenter) return;

            log.debug('Follow me', data);

            switch (data.action) {
                case 'toggle':
                    room.setFollowMe(data.status ? { enabled: true, peerId: null, action: null } : null);
                    break;
                case 'pin':
                case 'focus':
                    room.setFollowMe({ enabled: true, peerId: data.peerId, action: data.action });
                    break;
                case 'unpin':
                case 'unfocus':
                    room.setFollowMe({ enabled: true, peerId: null, action: null });
                    break;
                default:
                    break;
            }

            room.broadCast(socket.id, 'followMe', data);
        });

        socket.on('getRoomInfo', async (_, cb) => {
            if (!roomExists(socket)) {
                return cb({ error: 'Room not found' });
            }

            const { room, peer } = getRoomAndPeer(socket);

            const { peer_name } = peer || 'undefined';

            log.debug('Send Room Info to', peer_name);

            cb(room.toJson());
        });

        socket.on('fileInfo', (dataObject) => {
            if (!roomExists(socket)) return;
            if (!canShareSocket(socket)) return log.debug('fileInfo denied: sharing not allowed');

            const data = checkXSS(dataObject);

            if (!Validator.isValidData(data)) return;

            if (!isValidFileName(data.fileName)) {
                log.debug('File name not valid', data);
                return;
            }

            log.debug('Send File Info', data);

            const room = getRoom(socket);

            data.broadcast ? room.broadCast(socket.id, 'fileInfo', data) : room.sendTo(data.peer_id, 'fileInfo', data);
        });

        socket.on('file', (data) => {
            if (!roomExists(socket)) return;
            if (!canShareSocket(socket)) return log.debug('file denied: sharing not allowed');

            const room = getRoom(socket);

            data.broadcast ? room.broadCast(socket.id, 'file', data) : room.sendTo(data.peer_id, 'file', data);
        });

        socket.on('fileAbort', (dataObject) => {
            if (!roomExists(socket)) return;
            if (!canShareSocket(socket)) return log.debug('fileAbort denied: sharing not allowed');

            const data = checkXSS(dataObject);

            if (!Validator.isValidData(data)) return;

            const room = getRoom(socket);

            room.broadCast(socket.id, 'fileAbort', data);
        });

        socket.on('receiveFileAbort', (dataObject) => {
            if (!roomExists(socket)) return;

            const data = checkXSS(dataObject);

            if (!Validator.isValidData(data)) return;

            const room = getRoom(socket);

            room.broadCast(socket.id, 'receiveFileAbort', data);
        });

        socket.on('shareVideoAction', (dataObject) => {
            if (!roomExists(socket)) return;
            if (!canShareSocket(socket)) return log.debug('shareVideoAction denied: sharing not allowed');

            const data = checkXSS(dataObject);

            if (!Validator.isValidData(data)) return;

            if (data.action == 'open' && !isValidHttpURL(data.video_url)) {
                log.debug('Video src not valid', data);
                return;
            }

            log.debug('Share video: ', data);

            const room = getRoom(socket);

            // Enforce the moderator "everyone can't share media" rule server-side.
            // The presenter is exempt because they own/toggle the rule.
            if (room._moderator && room._moderator.media_cant_sharing) {
                const isPresenter = isPeerPresenter(socket.room_id, socket.id, data.peer_name, data.peer_uuid);
                if (!isPresenter) {
                    log.debug('shareVideoAction blocked by moderator rule (media_cant_sharing)', {
                        peer_name: data.peer_name,
                    });
                    return;
                }
            }

            room.updateShareMedia(data);

            data.peer_id == 'all'
                ? room.broadCast(socket.id, 'shareVideoAction', data)
                : room.sendTo(data.peer_id, 'shareVideoAction', data);
        });

        socket.on('wbCanvasToJson', (dataObject) => {
            if (!roomExists(socket)) return;
            if (!canShareSocket(socket)) return log.debug('wbCanvasToJson denied: sharing not allowed');

            // Security: cap whiteboard payload size. Fabric canvas JSON should comfortably
            // fit in well under 2 MB; anything larger is either accidental (huge embedded
            // images) or an attempt to abuse the broadcast channel as cheap amplification.
            const rawSize =
                typeof dataObject === 'string' ? dataObject.length : dataObject ? JSON.stringify(dataObject).length : 0;
            if (rawSize > 2_000_000) {
                log.debug('wbCanvasToJson blocked: payload too large', { size: rawSize });
                return;
            }

            const room = getRoom(socket);

            // Security: require the sender to be an actual joined peer of the room.
            // Without this a socket that only called `createRoom` (which sets socket.room_id
            // before the "already exists" check) could broadcast whiteboard payloads to all
            // real peers without ever joining the room / appearing in the attendee list.
            const peer = room.getPeer(socket.id);
            if (!peer) {
                log.debug('wbCanvasToJson blocked: sender is not a joined peer', {
                    room_id: socket.room_id,
                    socket_id: socket.id,
                });
                return;
            }

            // Security: when the whiteboard is locked, only the presenter may overwrite
            // the shared canvas. The lock state is server-authoritative and does not
            // depend on the client toggling its local `wbIsLock` flag.
            const isPresenter = isPeerPresenter(
                socket.room_id,
                socket.id,
                peer.peer_info?.peer_name,
                peer.peer_info?.peer_uuid
            );
            if (!isPresenter && room.getWhiteboardLock()) {
                log.debug('wbCanvasToJson blocked: whiteboard is locked and sender is not presenter', {
                    peer_name: peer.peer_info?.peer_name,
                });
                return;
            }

            const data = checkXSS(dataObject);

            // Security: strip fabric `image` objects whose `src` is not a safe http(s) URL
            // or `data:image/*` URI. This prevents SSRF probes (http://127.0.0.1, AWS IMDS,
            // 192.168/10/172.16/8 ranges…) and dangerous schemes (javascript:, file:, blob:)
            // from being rendered by every other peer's browser.
            const sanitized = Validator.sanitizeWbCanvasJson(data, ({ src }) => {
                log.debug('wbCanvasToJson dropped unsafe image src', { src });
            });

            // const objLength = bytesToSize(Object.keys(data).length);

            // log.debug('Send Whiteboard canvas JSON', { length: objLength });

            room.broadCast(socket.id, 'wbCanvasToJson', sanitized);
        });

        socket.on('whiteboardObject', (dataObject) => {
            if (!roomExists(socket)) return;
            if (!canShareSocket(socket)) return log.debug('whiteboardObject denied: sharing not allowed');

            const room = getRoom(socket);
            const peer = room.getPeer(socket.id);
            if (!peer || !dataObject || typeof dataObject !== 'object') return;

            let rawSize;
            try {
                rawSize = JSON.stringify(dataObject).length;
            } catch (_) {
                return;
            }
            if (rawSize > 2_000_000) return;

            const isPresenter = isPeerPresenter(
                socket.room_id,
                socket.id,
                peer.peer_info?.peer_name,
                peer.peer_info?.peer_uuid
            );
            if (!isPresenter && room.getWhiteboardLock()) return;

            const data = checkXSS(dataObject);
            if (!['upsert', 'remove'].includes(data.action)) return;
            if (typeof data.object_id !== 'string' || data.object_id.length > 200) return;

            if (data.action === 'upsert') {
                if (!data.object || typeof data.object !== 'object') return;
                const sanitized = Validator.sanitizeWbCanvasJson({ objects: [data.object] });
                if (sanitized.objects.length !== 1) return;
                data.object = sanitized.objects[0];
                data.object.wbId = data.object_id;
                data.object.wbAuthor = String(peer.peer_info?.peer_name || 'Participant').slice(0, 40);
                data.object.wbAuthorId = socket.id;
            } else {
                delete data.object;
            }

            room.broadCast(socket.id, 'whiteboardObject', data);
        });

        socket.on('whiteboardPointer', (dataObject) => {
            if (!roomExists(socket)) return;
            if (!canShareSocket(socket)) return log.debug('whiteboardPointer denied: sharing not allowed');

            const room = getRoom(socket);
            if (!room.getWhiteboardParticipantNames()) return;
            const peer = room.getPeer(socket.id);
            if (!peer || !dataObject || typeof dataObject !== 'object') return;

            const now = Date.now();
            if (dataObject.active && now - (socket.lastWhiteboardPointerAt || 0) < 25) return;
            socket.lastWhiteboardPointerAt = now;

            const x = Number(dataObject.x);
            const y = Number(dataObject.y);
            if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 100_000 || Math.abs(y) > 100_000) return;

            const isPresenter = isPeerPresenter(
                socket.room_id,
                socket.id,
                peer.peer_info?.peer_name,
                peer.peer_info?.peer_uuid
            );
            if (!isPresenter && room.getWhiteboardLock()) return;

            room.broadCast(socket.id, 'whiteboardPointer', {
                peer_id: socket.id,
                peer_name: String(peer.peer_info?.peer_name || 'Participant').slice(0, 40),
                x,
                y,
                active: Boolean(dataObject.active),
            });
        });

        socket.on('whiteboardAction', (dataObject) => {
            if (!roomExists(socket)) return;
            if (!canShareSocket(socket)) return log.debug('whiteboardAction denied: sharing not allowed');

            const room = getRoom(socket);

            // Security: require the sender to be an actual joined peer of the room
            // (see wbCanvasToJson above for rationale).
            const peer = room.getPeer(socket.id);
            if (!peer) {
                log.debug('whiteboardAction blocked: sender is not a joined peer', {
                    room_id: socket.room_id,
                    socket_id: socket.id,
                });
                return;
            }

            const data = checkXSS(dataObject);

            if (!Validator.isValidData(data)) return;

            // Security: whiteboardAction mutates global whiteboard state (clear / undo / redo /
            // bgcolor / lock / unlock) for every other peer. Only the presenter is allowed
            // to trigger these. Verify against server-known peer identity, not client-supplied
            // peer_name / peer_uuid (which are attacker-controlled in the request body).
            const isPresenter = isPeerPresenter(
                socket.room_id,
                socket.id,
                peer.peer_info?.peer_name,
                peer.peer_info?.peer_uuid
            );
            if (!isPresenter) {
                log.debug('whiteboardAction blocked: sender is not presenter', {
                    action: data.action,
                    peer_name: peer.peer_info?.peer_name,
                });
                return;
            }

            // Overwrite the broadcast peer_name with the server-known value so a presenter
            // can't be tricked into proxying an HTML payload supplied in the request body
            // (the client renders `data.peer_name` inside a SweetAlert toast).
            data.peer_name = peer.peer_info?.peer_name || data.peer_name;

            // Track lock state server-side so late-joining peers / future requests are
            // gated even if the presenter never re-toggles the button.
            if (data.action === 'lock') room.setWhiteboardLock(true);
            if (data.action === 'unlock') room.setWhiteboardLock(false);
            if (data.action === 'participantNames') {
                data.status = Boolean(data.status);
                room.setWhiteboardParticipantNames(data.status);
            }

            log.debug('Whiteboard', data);
            room.broadCast(socket.id, 'whiteboardAction', data);
        });

        // Video drawing overlay: relay temporary strokes and persist screen annotations.
        socket.on('videoDrawing', (dataObject) => {
            if (!roomExists(socket)) return;
            const data = checkXSS(dataObject);
            const room = getRoom(socket);
            const peer = room.getPeer(socket.id);
            if (!peer) return;

            if (!room.isScreenProducer(data.producerId)) return;

            const producerOwnerId = room.getProducerOwnerId(data.producerId);
            if (data.type === 'permissions') {
                if (socket.id !== producerOwnerId || typeof data.allowed !== 'boolean') return;
                if (data.allowed) room.videoDrawingPermissions.delete(data.producerId);
                else room.videoDrawingPermissions.set(data.producerId, false);
                const permissions = { type: 'permissions', producerId: data.producerId, allowed: data.allowed };
                socket.emit('videoDrawing', permissions);
                room.broadCast(socket.id, 'videoDrawing', permissions);
                return;
            }
            if (socket.id !== producerOwnerId && room.videoDrawingPermissions?.get(data.producerId) === false) return;
            if (
                room._moderator.screen_annotations_cant_draw &&
                !isPeerPresenter(socket.room_id, socket.id, peer.peer_name, peer.peer_uuid)
            ) {
                return;
            }

            const requestedDrawerId = data.drawerId;
            data.drawerId = socket.id;
            data.peer_name = peer.peer_info?.peer_name || peer.peer_name;

            if (data.type === 'laser') {
                if (
                    !Array.isArray(data.points) ||
                    data.points.length !== 1 ||
                    !data.points.every(
                        (point) =>
                            point &&
                            Number.isFinite(point.x) &&
                            Number.isFinite(point.y) &&
                            point.x >= 0 &&
                            point.x <= 1 &&
                            point.y >= 0 &&
                            point.y <= 1
                    )
                )
                    return;
                room.broadCast(socket.id, 'videoDrawing', {
                    type: 'laser',
                    producerId: data.producerId,
                    drawerId: socket.id,
                    peer_name: data.peer_name,
                    points: data.points,
                    end: Boolean(data.end),
                });
                return;
            }

            if (data.type === 'annotation') {
                const { action, annotationId, producerId } = data;
                const annotations = room.getVideoDrawingAnnotations(producerId);

                if (action === 'clear') {
                    const clearAll = socket.id === producerOwnerId;
                    for (const [id, annotation] of annotations) {
                        if (clearAll || annotation.drawerId === socket.id) annotations.delete(id);
                    }
                    room.broadCast(socket.id, 'videoDrawing', {
                        type: 'annotation',
                        action,
                        producerId,
                        drawerId: socket.id,
                        clearAll,
                    });
                    return;
                }

                const validAnnotationId =
                    typeof annotationId === 'string' && annotationId.length > 0 && annotationId.length <= 100;
                const validPoints =
                    Array.isArray(data.points) &&
                    data.points.length >= 2 &&
                    data.points.length <= 2048 &&
                    data.points.every(
                        (point) =>
                            point &&
                            Number.isFinite(point.x) &&
                            Number.isFinite(point.y) &&
                            point.x >= 0 &&
                            point.x <= 1 &&
                            point.y >= 0 &&
                            point.y <= 1
                    );
                const annotation = annotations.get(annotationId);

                if (action === 'move') {
                    if (
                        !validAnnotationId ||
                        !validPoints ||
                        !annotation ||
                        (socket.id !== annotation.drawerId && socket.id !== producerOwnerId)
                    ) {
                        return;
                    }
                    annotation.points = data.points;
                    room.broadCast(socket.id, 'videoDrawing', {
                        type: 'annotation',
                        action,
                        producerId,
                        annotationId,
                        points: data.points,
                    });
                    return;
                }

                if (action === 'delete') {
                    if (
                        !validAnnotationId ||
                        !annotation ||
                        (socket.id !== annotation.drawerId && socket.id !== producerOwnerId)
                    ) {
                        return;
                    }
                    annotations.delete(annotationId);
                    room.broadCast(socket.id, 'videoDrawing', {
                        type: 'annotation',
                        action,
                        producerId,
                        annotationId,
                    });
                    return;
                }

                const validTool = ['pencil', 'highlighter', 'circle', 'rectangle', 'diamond', 'arrow'].includes(
                    data.tool
                );
                const validColor = typeof data.color === 'string' && /^#[0-9a-f]{6}$/i.test(data.color);
                const validWidth = Number.isFinite(data.width) && data.width >= 0.001 && data.width <= 0.05;
                const restoring = action === 'restore';
                const validRequestedDrawerId =
                    typeof requestedDrawerId === 'string' &&
                    requestedDrawerId.length > 0 &&
                    requestedDrawerId.length <= 100;
                if (
                    (action !== 'create' && !restoring) ||
                    (restoring && (socket.id !== producerOwnerId || !validRequestedDrawerId)) ||
                    !validAnnotationId ||
                    !validTool ||
                    !validColor ||
                    !validWidth ||
                    !validPoints ||
                    annotations.has(annotationId) ||
                    annotations.size >= 500
                ) {
                    return;
                }

                const newAnnotation = {
                    type: 'annotation',
                    action: 'create',
                    producerId,
                    annotationId,
                    drawerId: restoring ? requestedDrawerId : socket.id,
                    peer_name: data.peer_name,
                    tool: data.tool,
                    color: data.color,
                    width: data.width,
                    points: data.points,
                };
                annotations.set(annotationId, newAnnotation);
                room.broadCast(socket.id, 'videoDrawing', newAnnotation);
                return;
            }

            if (data.type === 'text') {
                const { action, annotationId, producerId } = data;
                const annotations = room.getVideoTextAnnotations(producerId);
                const validAnnotationId =
                    typeof annotationId === 'string' && annotationId.length > 0 && annotationId.length <= 100;
                const validPosition =
                    Number.isFinite(data.x) &&
                    Number.isFinite(data.y) &&
                    data.x >= 0 &&
                    data.x <= 1 &&
                    data.y >= 0 &&
                    data.y <= 1;
                const getTextStyle = (fallback = {}) => {
                    const style = {
                        color: data.color ?? fallback.color ?? '#ffffff',
                        fontSize: data.fontSize ?? fallback.fontSize ?? 16,
                        bold: data.bold ?? fallback.bold ?? false,
                        italic: data.italic ?? fallback.italic ?? false,
                        boxWidth: data.boxWidth ?? fallback.boxWidth ?? 0.35,
                        underline: data.underline ?? fallback.underline ?? false,
                        strikethrough: data.strikethrough ?? fallback.strikethrough ?? false,
                        textAlign: data.textAlign ?? fallback.textAlign ?? 'left',
                        backgroundColor: data.backgroundColor ?? fallback.backgroundColor ?? 'transparent',
                        rotation: data.rotation ?? fallback.rotation ?? 0,
                    };
                    return typeof style.color === 'string' &&
                        /^#[0-9a-f]{6}$/i.test(style.color) &&
                        [12, 16, 20, 24, 32].includes(style.fontSize) &&
                        typeof style.bold === 'boolean' &&
                        typeof style.italic === 'boolean' &&
                        Number.isFinite(style.boxWidth) &&
                        style.boxWidth >= 0.15 &&
                        style.boxWidth <= 0.8 &&
                        typeof style.underline === 'boolean' &&
                        typeof style.strikethrough === 'boolean' &&
                        ['left', 'center', 'right'].includes(style.textAlign) &&
                        typeof style.backgroundColor === 'string' &&
                        (style.backgroundColor === 'transparent' || /^#[0-9a-f]{6}$/i.test(style.backgroundColor)) &&
                        [-45, -30, -15, 0, 15, 30, 45].includes(style.rotation)
                        ? style
                        : null;
                };

                if (action === 'create' || action === 'restore') {
                    const restoring = action === 'restore';
                    const textStyle = getTextStyle();
                    const validRequestedDrawerId =
                        typeof requestedDrawerId === 'string' &&
                        requestedDrawerId.length > 0 &&
                        requestedDrawerId.length <= 100;
                    if (
                        (restoring && (socket.id !== producerOwnerId || !validRequestedDrawerId)) ||
                        !validAnnotationId ||
                        typeof data.text !== 'string' ||
                        data.text.length === 0 ||
                        data.text.length > 1000 ||
                        !textStyle ||
                        !validPosition ||
                        annotations.has(annotationId) ||
                        annotations.size >= 200
                    ) {
                        return;
                    }
                    const newAnnotation = {
                        type: 'text',
                        action: 'create',
                        producerId,
                        annotationId,
                        drawerId: restoring ? requestedDrawerId : socket.id,
                        peer_name: data.peer_name,
                        text: data.text,
                        x: data.x,
                        y: data.y,
                        ...textStyle,
                    };
                    annotations.set(annotationId, newAnnotation);
                    room.broadCast(socket.id, 'videoDrawing', newAnnotation);
                    return;
                } else if (action === 'draft') {
                    // Live typing preview: relayed only, never stored
                    const textStyle = getTextStyle();
                    if (
                        !validAnnotationId ||
                        typeof data.text !== 'string' ||
                        data.text.length > 1000 ||
                        !textStyle ||
                        !validPosition
                    ) {
                        return;
                    }
                    room.broadCast(socket.id, 'videoDrawing', {
                        type: 'text',
                        action,
                        producerId,
                        annotationId,
                        drawerId: socket.id,
                        peer_name: data.peer_name,
                        text: data.text,
                        x: data.x,
                        y: data.y,
                        ...textStyle,
                    });
                    return;
                } else if (action === 'clear') {
                    if (socket.id !== producerOwnerId) return;
                    room.clearVideoTextAnnotations(producerId);
                } else {
                    if (!validAnnotationId) return;
                    const annotation = annotations.get(annotationId);
                    if (!annotation || (socket.id !== annotation.drawerId && socket.id !== producerOwnerId)) return;
                    if (action === 'update') {
                        const textStyle = getTextStyle(annotation);
                        if (
                            typeof data.text !== 'string' ||
                            data.text.length === 0 ||
                            data.text.length > 1000 ||
                            !textStyle
                        ) {
                            return;
                        }
                        Object.assign(annotation, { text: data.text, ...textStyle });
                        Object.assign(data, textStyle);
                    } else if (action === 'move') {
                        if (!validPosition) return;
                        annotation.x = data.x;
                        annotation.y = data.y;
                    } else if (action === 'delete') {
                        annotations.delete(annotationId);
                    } else {
                        return;
                    }
                }
                room.broadCast(socket.id, 'videoDrawing', data);
                return;
            }

            if (data.type !== undefined && data.type !== 'pen') return;
            if (!Array.isArray(data.paths) || data.paths.length === 0 || data.paths.length > 128) return;
            // log.debug('Video drawing', data);
            room.broadCast(socket.id, 'videoDrawing', data);
        });

        socket.on('setVideoOff', (dataObject) => {
            if (!roomExists(socket)) return;

            const data = checkXSS(dataObject);

            if (!Validator.isValidData(data)) return;

            log.debug('Video off data', data.peer_name);

            const { room, peer } = getRoomAndPeer(socket);

            // Persist peer_video=false so new participants joining later
            // can correctly see the videoOff tile when they join later
            if (peer) peer.updatePeerInfo({ type: 'video', status: false });

            room.broadCast(socket.id, 'setVideoOff', data);
        });

        socket.on('recordingAction', async (dataObject) => {
            if (!roomExists(socket)) return;

            const data = checkXSS(dataObject);

            if (!Validator.isValidData(data)) return;

            const room = getRoom(socket);

            // Resolve sender from server-side state — never trust client-supplied identity
            const peer = room.getPeer(socket.id);
            if (!peer) return;

            // If host-only recording is enabled, only the presenter may broadcast recording state
            if (room.isHostOnlyRecording()) {
                const isPresenter = isPeerPresenter(
                    socket.room_id,
                    socket.id,
                    peer.peer_info?.peer_name,
                    peer.peer_info?.peer_uuid
                );
                if (!isPresenter) return;
            }

            // Override client-supplied identity with server-side values to prevent spoofing
            data.peer_name = peer.peer_info?.peer_name;
            data.peer_id = socket.id;

            log.debug('Recording action', data);

            room.broadCast(socket.id, 'recordingAction', data);
        });

        socket.on('refreshParticipantsCount', () => {
            if (!roomExists(socket)) return;

            const room = getRoom(socket);

            const peerCounts = room.getPeersCount();

            const data = {
                room_id: socket.room_id,
                peer_counts: peerCounts,
            };
            log.debug('Refresh Participants count', data);
            room.broadCast(socket.id, 'refreshParticipantsCount', data);
        });

        socket.on('message', (dataObject) => {
            if (!roomExists(socket)) return;

            const data = checkXSS(dataObject);

            if (!Validator.isValidData(data)) return;

            const { room, peer } = getRoomAndPeer(socket);

            const { peer_name } = peer || 'undefined';

            const realPeer = data.peer_name === peer_name;

            if (!realPeer) {
                log.warn('Fake message detected', {
                    ip: getIpSocket(socket),
                    realFrom: peer_name,
                    fakeFrom: data.peer_name,
                    msg: data.peer_msg,
                });
                return;
            }

            log.debug('message', data);

            // Enforce moderator chat restrictions server-side
            const isPublicMessage = data.to_peer_id === 'all';
            if (room._moderator) {
                if (isPublicMessage && room._moderator.chat_cant_publicly) {
                    log.debug('Blocking public message: disabled by moderator', { peer_name });
                    return;
                }
                if (!isPublicMessage && room._moderator.chat_cant_privately) {
                    log.debug('Blocking private message: disabled by moderator', { peer_name });
                    return;
                }
            }

            data.to_peer_id == 'all'
                ? room.broadCast(socket.id, 'message', data)
                : room.sendTo(data.to_peer_id, 'message', data);
        });

        socket.on('chatTyping', (dataObject) => {
            if (!roomExists(socket)) return;

            if (config.ui?.buttons?.chat?.chatTyping === false) return;

            if (!dataObject || typeof dataObject.to_peer_id !== 'string' || typeof dataObject.isTyping !== 'boolean') {
                return;
            }

            const { to_peer_id, isTyping } = dataObject;

            // Throttle "typing" signals per socket, "stopped" signals are always relayed
            const now = Date.now();
            if (isTyping) {
                if (now - (socket._lastChatTyping || 0) < 1000) return;
                socket._lastChatTyping = now;
            }

            const { room, peer } = getRoomAndPeer(socket);
            if (!room || !peer) return;

            const isPublic = to_peer_id === 'all';

            if (room._moderator) {
                if (isPublic ? room._moderator.chat_cant_publicly : room._moderator.chat_cant_privately) return;
            }

            const data = {
                peer_id: socket.id,
                peer_name: peer.peer_name,
                peer_avatar: peer.peer_avatar || false,
                to_peer_id: isPublic ? 'all' : to_peer_id,
                isTyping,
            };

            isPublic ? room.broadCast(socket.id, 'chatTyping', data) : room.sendTo(to_peer_id, 'chatTyping', data);
        });

        socket.on('chatReaction', (dataObject) => {
            if (!roomExists(socket)) return;
            const data = checkXSS(dataObject);
            if (!Validator.isValidData(data)) return;
            const { room } = getRoomAndPeer(socket);
            room.broadCast(socket.id, 'chatReaction', data);
        });

        // https://platform.openai.com/docs/api-reference/audio/createTranscription
        // Whisper speech-to-text (OpenAI API or any OpenAI-compatible self-hosted server)
        // TLLM*meet meeting transcription: a presenter starts it for the whole room, every browser then
        // sends its microphone in sentences (meeting: true). See Transcripts.js and TllmTranscript.js.
        const meetingTranscriptionState = (room) => ({
            available: !!config?.integrations?.whisper?.enabled && transcripts.eligible(room.id),
            active: transcripts.isActive(room.id),
        });

        socket.on('meetingTranscription', (_, cb) => {
            if (typeof cb !== 'function') return;
            if (!roomExists(socket)) return cb({ available: false, active: false });
            return cb(meetingTranscriptionState(getRoom(socket)));
        });

        socket.on('setMeetingTranscription', (dataObject, cb) => {
            const reply = typeof cb === 'function' ? cb : () => {};
            if (!roomExists(socket)) return reply({ error: 'Room not found' });
            const { room, peer } = getRoomAndPeer(socket);
            if (!peer || !isSocketPresenter(socket, room)) return reply({ error: 'not allowed' });
            if (!meetingTranscriptionState(room).available) return reply({ error: 'unavailable' });
            const by = peer.peer_info?.peer_name ?? peer.peer_name;
            const active = dataObject?.active === true;
            if (active) transcripts.start(room.id, { name: roomRegistry.name(room.id), by });
            else transcripts.stop(room.id, { by });
            room.sendToAll('meetingTranscription', { ...meetingTranscriptionState(room), by });
            log.info('Meeting transcription', { room_id: room.id, active, by });
            return reply(meetingTranscriptionState(room));
        });

        socket.on('getWhisperTranscription', async ({ audio, mimeType, language, meeting, ageMs }, cb) => {
            if (!roomExists(socket)) {
                return cb({ error: 'Room not found' });
            }

            const whisper = config?.integrations?.whisper;
            if (!whisper?.enabled) {
                return cb({ error: 'Whisper transcription is disabled. Please try again later!' });
            }

            // Meeting transcription: who speaks comes from the server-side peer, when from the age of the sentence
            let session = null;
            let speaker = '';
            let saidAt = Date.now();
            if (meeting === true) {
                const { peer } = getRoomAndPeer(socket);
                session = peer ? transcripts.begin(socket.room_id) : null;
                if (!session) return cb({ text: '', inactive: true });
                speaker = peer.peer_info?.peer_name ?? peer.peer_name;
                const age = Number(ageMs);
                if (Number.isFinite(age)) saidAt -= Math.min(Math.max(age, 0), 120000);
            }

            try {
                const maxBytes = whisper.maxAudioBytes || 25 * 1024 * 1024;

                let buffer;
                try {
                    buffer = decodeAudioPayload(audio, maxBytes);
                } catch (err) {
                    if (err.message === 'Empty audio payload') return cb({ text: '' });
                    if (err.message === 'Audio segment too large') return cb({ error: err.message });
                    throw err;
                }

                const type = typeof mimeType === 'string' && mimeType.startsWith('audio/') ? mimeType : 'audio/webm';
                const ext = resolveAudioExtension(type);

                const FormData = require('form-data');
                const form = new FormData();
                form.append('file', buffer, { filename: `audio.${ext}`, contentType: type });
                form.append('model', whisper.model || 'whisper-1');
                form.append('response_format', 'verbose_json');

                const lang =
                    typeof language === 'string' && language ? language : whisper.language || (session ? 'fr' : '');
                if (lang) form.append('language', lang);

                const headers = { ...form.getHeaders() };
                if (whisper.apiKey) headers['Authorization'] = `Bearer ${whisper.apiKey}`;

                const base = (whisper.basePath || 'https://api.openai.com/v1/').replace(/\/?$/, '/');
                const url = `${base}audio/transcriptions`;

                const response = await axios.post(url, form, {
                    headers,
                    timeout: 30000,
                    maxBodyLength: Infinity,
                    maxContentLength: Infinity,
                });

                const raw = response.data && (response.data.text || response.data.transcript);
                const rawText = typeof raw === 'string' ? raw.trim() : '';

                // Filter out Whisper hallucinations that occur on silent/near-silent audio
                const segments = Array.isArray(response.data?.segments) ? response.data.segments : [];
                const text = filterTranscript(rawText, segments);

                log.debug('Whisper transcription', { language: lang || 'auto', bytes: buffer.length, text });

                if (session) {
                    transcripts.add(session, { name: speaker, text, at: saidAt });
                    session = null;
                    // Live captions for those who opened the panel
                    const room = getRoom(socket);
                    if (text && room) room.sendToAll('meetingTranscript', { peer_name: speaker, text });
                }

                cb({ text });
            } catch (error) {
                log.error('Whisper transcription error', error?.response?.data || error.message);
                cb({ error: `Whisper error: ${error?.response?.data?.error?.message || error.message}` });
            } finally {
                transcripts.abandon(session); // not recognised: the file no longer waits for it
            }
        });

        // TLLM*meet polls: presenters (the admin, and anyone the admin promoted) create, edit and
        // delete polls; everyone votes. Identity comes from the server, never from the payload.
        socket.on('createPoll', (dataObject) => {
            if (!roomExists(socket)) return;
            const room = getRoom(socket);
            if (!isSocketPresenter(socket, room)) return log.debug('[Poll] createPoll denied: not a presenter');

            const input = parsePollInput(checkXSS(dataObject));
            if (!input) return log.debug('[Poll] createPoll invalid data');

            room.createPoll(input.question, input.options, input.settings, () => sendPolls(room));
            sendPolls(room);
        });

        socket.on('vote', (dataObject) => {
            if (!roomExists(socket)) return;
            const data = checkXSS(dataObject);
            if (!Validator.isValidData(data)) return;
            // { options: [...] } (several answers, or [] to withdraw), or { option } (one answer)
            const choices = Array.isArray(data.options) ? data.options : data.option;
            if (Array.isArray(choices) ? choices.length > 10 : typeof choices !== 'string') return;

            const { room, peer } = getRoomAndPeer(socket);
            if (!peer) return;

            const ref = typeof data.pollId === 'string' ? data.pollId : data.pollIndex;
            const name = peer.peer_info?.peer_name || peer.peer_name;
            if (room.votePoll(ref, socket.id, name, choices)) sendPolls(room);
        });

        socket.on('updatePoll', () => {
            if (!roomExists(socket)) return;
            const room = getRoom(socket);
            if (room.thereIsPolls()) sendPolls(room, socket.id);
        });

        socket.on('editPoll', (dataObject) => {
            if (!roomExists(socket)) return;
            const room = getRoom(socket);
            if (!isSocketPresenter(socket, room)) return log.debug('[Poll] editPoll denied: not a presenter');

            const data = checkXSS(dataObject);
            const input = parsePollInput(data);
            const ref = typeof data?.pollId === 'string' ? data.pollId : data?.index;
            if (input && room.editPoll(ref, input.question, input.options)) sendPolls(room);
        });

        // TLLM*meet: a presenter allows (or no longer allows) one participant to share
        socket.on('setSharePermission', (dataObject) => {
            if (!roomExists(socket)) return;
            const room = getRoom(socket);
            if (!isSocketPresenter(socket, room)) return log.debug('setSharePermission denied: not a presenter');
            const data = checkXSS(dataObject);
            const target = typeof data?.peer_id === 'string' ? room.getPeer(data.peer_id) : null;
            if (!target) return;
            const allowed = data.allowed === true;
            if (allowed) room.sharers.add(data.peer_id);
            else room.sharers.delete(data.peer_id);
            room.sendToAll('sharePermission', {
                peer_id: data.peer_id,
                peer_name: target.peer_info?.peer_name ?? target.peer_name,
                allowed,
            });
        });

        socket.on('closePoll', (dataObject) => {
            if (!roomExists(socket)) return;
            const room = getRoom(socket);
            if (!isSocketPresenter(socket, room)) return log.debug('[Poll] closePoll denied: not a presenter');

            const data = checkXSS(dataObject);
            if (typeof data?.pollId === 'string' && room.closePoll(data.pollId)) sendPolls(room);
        });

        socket.on('deletePoll', (dataObject) => {
            if (!roomExists(socket)) return;
            const room = getRoom(socket);
            if (!isSocketPresenter(socket, room)) return log.debug('[Poll] deletePoll denied: not a presenter');

            const data = checkXSS(dataObject);
            const ref = typeof data?.pollId === 'string' ? data.pollId : data?.index;
            if (room.deletePoll(ref)) sendPolls(room);
        });

        // TLLM*meet: shared editor and whiteboard. Everyone in the room reads, only the people
        // allowed to share write (see Collab.js).
        socket.on('collabSync', (data) => {
            if (!roomExists(socket)) return;
            const room = getRoom(socket);
            if (!room.getPeer(socket.id)) return;
            const shared = collab.get(socket.room_id);
            const result = shared.handleSync(socket.id, data, canShareSocket(socket));
            for (const reply of result.replies) socket.emit('collabSync', reply);
            if (result.replies.length) {
                const cursors = shared.awarenessSnapshot();
                if (cursors) socket.emit('collabAwareness', cursors);
            }
            if (result.rejected) log.debug('collabSync rejected', { error: result.error?.message });
        });

        socket.on('collabAwareness', (data) => {
            if (!roomExists(socket)) return;
            const peer = getRoom(socket).getPeer(socket.id);
            if (!peer) return;
            collab.get(socket.room_id).handleAwareness(socket.id, data, peer.peer_info?.peer_name ?? peer.peer_name);
        });

        // Room collaborative editor (upstream events, no longer used by the TLLM*meet client)

        socket.on('editorChange', (dataObject) => {
            if (!roomExists(socket)) return;
            if (!canShareSocket(socket)) return log.debug('editorChange denied: sharing not allowed');

            //const data = checkXSS(dataObject);
            const data = dataObject;

            const room = getRoom(socket);

            room.broadCast(socket.id, 'editorChange', data);
        });

        socket.on('editorActions', (dataObject) => {
            if (!roomExists(socket)) return;
            if (!canShareSocket(socket)) return log.debug('editorActions denied: sharing not allowed');

            const data = checkXSS(dataObject);

            const room = getRoom(socket);

            log.debug('editorActions', data);

            room.broadCast(socket.id, 'editorActions', data);
        });

        socket.on('editorUpdate', (dataObject) => {
            if (!roomExists(socket)) return;
            if (!canShareSocket(socket)) return log.debug('editorUpdate denied: sharing not allowed');

            //const data = checkXSS(dataObject);
            const data = dataObject;

            const room = getRoom(socket);

            room.broadCast(socket.id, 'editorUpdate', data);
        });

        socket.on('disconnect', (reason) => {
            if (!roomExists(socket)) {
                // Clean up socket listeners even if room doesn't exist
                socket.removeAllListeners();
                return;
            }

            const { room, peer } = getRoomAndPeer(socket);

            const { peer_name, peer_uuid } = peer || {};

            const isPresenter = isPeerPresenter(socket.room_id, socket.id, peer_name, peer_uuid);

            log.debug('[Disconnect] - peer name', { peer_name, reason });

            room.removePeer(socket.id);
            collab.leave(socket.room_id, socket.id);

            // Sockets that never joined (e.g. rejected by a lock) are not announced to the room
            if (peer) room.broadCast(socket.id, 'removeMe', removeMeData(room, peer_name, isPresenter));

            // Notify main room when a peer leaves a breakout room
            if (peer && socket.room_id.includes('_breakout_')) {
                notifyMainRoomBreakoutCountChanged(socket.room_id);
            }

            // Clean up this peer's presenter entry immediately
            if (socket.room_id in presenters && socket.id in presenters[socket.room_id]) {
                delete presenters[socket.room_id][socket.id];
            }

            // TLLM*meet: no automatic presenter hand-over. Only the admin, or a guest the admin
            // promoted, is presenter; when they leave nobody inherits the role.

            if (room.getPeersCount() === 0) {
                roomList.delete(socket.room_id);
                collab.release(socket.room_id);
                roomRegistry.closed(socket.room_id);
                transcripts.close(socket.room_id);

                delete presenters[socket.room_id];

                log.debug('[Disconnect] - Last peer - current presenters grouped by roomId', presenters);
            }

            socket.room_id = null;

            // Clean up all socket event listeners to prevent memory leaks
            socket.removeAllListeners();
        });

        socket.on('exitRoom', (_, callback) => {
            if (!roomExists(socket)) {
                return callback({
                    error: 'Not currently in a room',
                });
            }

            const { room, peer } = getRoomAndPeer(socket);

            const { peer_name, peer_uuid } = peer || {};

            const isPresenter = isPeerPresenter(socket.room_id, socket.id, peer_name, peer_uuid);

            log.debug('Exit room', peer_name);

            room.removePeer(socket.id);
            collab.leave(socket.room_id, socket.id);

            room.broadCast(socket.id, 'removeMe', removeMeData(room, peer_name, isPresenter));

            // Clean up this peer's presenter entry immediately
            if (socket.room_id in presenters && socket.id in presenters[socket.room_id]) {
                delete presenters[socket.room_id][socket.id];
            }

            // TLLM*meet: no automatic presenter hand-over. Only the admin, or a guest the admin
            // promoted, is presenter; when they leave nobody inherits the role.

            if (room.getPeersCount() === 0) {
                roomList.delete(socket.room_id);
                collab.release(socket.room_id);
                roomRegistry.closed(socket.room_id);
                transcripts.close(socket.room_id);

                delete presenters[socket.room_id];

                log.debug('[REMOVE ME] - Last peer - current presenters grouped by roomId', presenters);
            }

            socket.room_id = null;

            callback('Successfully exited room');
        });

        // Helpers

        function getRoomAndPeer(socket) {
            const room = getRoom(socket);

            const peer = getPeer(socket);

            return { room, peer };
        }

        function getRoom(socket) {
            return roomList.get(socket.room_id) || null;
        }

        function getPeer(socket) {
            const room = getRoom(socket); // Reusing getRoom to retrieve the room

            return room.getPeer ? room.getPeer(socket.id) || null : null;
        }

        function roomExists(socket) {
            return roomList.has(socket.room_id);
        }

        // Security: true only if this socket proved the current room password via checkPassword
        function isSocketUnlocked(socket, room) {
            const unlock = socket.roomUnlock;
            return Boolean(
                unlock &&
                unlock.room_id === room.id &&
                RoomPassword.passwordMatches(unlock.password, room.getPassword())
            );
        }

        // Security: block lobby-waiting peers from WebRTC/media handlers.
        function isPeerInLobby(peer) {
            return Boolean(peer && peer.peer_lobby === true);
        }

        function getPeerInfo(peer) {
            if (!peer || !peer.peer_info) {
                return {
                    peer_name: peer?.peer_name || 'Unknown',
                    isDesktop: false,
                    os: 'Unknown',
                    browser: 'Unknown',
                };
            }

            const { peer_name, peer_info } = peer;
            const { is_desktop_device, os_name, os_version, browser_name, browser_version } = peer_info;

            return {
                peer_name: peer_name || 'Unknown',
                isDesktop: Boolean(is_desktop_device),
                os: os_name && os_version ? `${os_name} ${os_version}` : os_name || 'Unknown',
                browser:
                    browser_name && browser_version ? `${browser_name} ${browser_version}` : browser_name || 'Unknown',
            };
        }

        function isValidFileName(fileName) {
            const invalidChars = /[\\\/\?\*\|:"<>]/;
            return !invalidChars.test(fileName);
        }

        function isValidHttpURL(input) {
            try {
                const url = new URL(input);
                return url.protocol === 'http:' || url.protocol === 'https:';
            } catch (_) {
                return false;
            }
        }

        function removeMeData(room, peerName, isPresenter) {
            const roomId = room && socket.room_id;
            const peerCounts = room && room.getPeersCount();
            const data = {
                room_id: roomId,
                peer_id: socket.id,
                peer_name: peerName,
                peer_counts: peerCounts,
                isPresenter: isPresenter,
            };
            log.debug('Peer removed from the room', data);
            return data;
        }

        function notifyMainRoomBreakoutCountChanged(breakoutRoomId) {
            const mainRoomId = breakoutRoomId.split('_breakout_')[0];
            const mainRoom = roomList.get(mainRoomId);
            if (mainRoom) {
                mainRoom.sendToAll('breakoutRoomCountsChanged', { breakoutRoom: breakoutRoomId });
            }
        }
    });

    function clone(value) {
        if (value === undefined) return undefined;
        if (Number.isNaN(value)) return NaN;
        if (typeof structuredClone === 'function') return structuredClone(value);
        return JSON.parse(JSON.stringify(value));
    }

    // TLLM*meet: presenter check from the server-side peer, never from client-supplied names
    function isSocketPresenter(socket, room) {
        const peer = room?.getPeer(socket.id);
        if (!peer) return false;
        return isPeerPresenter(
            socket.room_id,
            socket.id,
            peer.peer_info?.peer_name ?? peer.peer_name,
            peer.peer_info?.peer_uuid ?? peer.peer_uuid
        );
    }

    // TLLM*meet: screen, whiteboard, editor, files and videos: presenters, and the people they allowed
    function canShareSocket(socket) {
        const room = roomList.get(socket.room_id);
        if (!room) return false;
        return isSocketPresenter(socket, room) || room.sharers.has(socket.id);
    }

    // Each participant gets its own view: totals for all, who voted what for presenters only
    function sendPolls(room, onlyPeerId = null) {
        for (const [peerId, peer] of room.peers) {
            if (onlyPeerId && peerId !== onlyPeerId) continue;
            const presenter = isPeerPresenter(
                room.id,
                peerId,
                peer.peer_info?.peer_name ?? peer.peer_name,
                peer.peer_info?.peer_uuid ?? peer.peer_uuid
            );
            room.sendTo(peerId, 'updatePolls', room.pollsView(peerId, presenter));
        }
    }

    // Question: 1-300 characters. Options: 2-10 distinct, non-empty, up to 200 characters each.
    // Settings: multiple, anonymous, hideResults (booleans), duration in seconds (0, or 30 s to 1 day).
    function parsePollInput(data) {
        if (!data || typeof data !== 'object') return null;
        const question = typeof data.question === 'string' ? data.question.trim() : '';
        if (!question || question.length > 300 || !Array.isArray(data.options)) return null;
        const options = data.options.map((option) => (typeof option === 'string' ? option.trim() : ''));
        if (options.length < 2 || options.length > 10) return null;
        if (options.some((option) => !option || option.length > 200)) return null;
        if (new Set(options).size !== options.length) return null;
        const duration = data.duration ?? 0;
        if (typeof duration !== 'number' || (duration !== 0 && !(duration >= 30 && duration <= 86400))) return null;
        const settings = {
            multiple: data.multiple === true,
            anonymous: data.anonymous === true,
            hideResults: data.hideResults === true,
            durationMs: Math.round(duration) * 1000,
        };
        return { question, options, settings };
    }

    function isPeerPresenter(room_id, peer_id, peer_name, peer_uuid) {
        try {
            // 1. Direct lookup by peer_id (server-assigned socket.id — not user-controlled)
            const storedPresenter = presenters[room_id]?.[peer_id];
            if (storedPresenter) {
                const isPresenter =
                    storedPresenter.peer_name === peer_name &&
                    storedPresenter.peer_uuid === peer_uuid &&
                    storedPresenter.is_presenter === true;

                log.debug('isPeerPresenter Check (stored)', {
                    room_id: room_id,
                    peer_id: peer_id,
                    peer_name: peer_name,
                    peer_uuid: peer_uuid,
                    isPresenter: isPresenter,
                });

                return isPresenter;
            }

            // 2. Not a presenter. Configured presenter names are only trusted during
            // join after authentication and are stored in the socket-bound map above.
            log.debug('isPeerPresenter Check (denied)', {
                room_id: room_id,
                peer_id: peer_id,
                peer_name: peer_name,
                peer_uuid: peer_uuid,
                isPresenter: false,
            });

            return false;
        } catch (err) {
            log.error('isPeerPresenter Check error', err);
            return false;
        }
    }

    function getIP(req) {
        return ipFromRequest(req, trustProxy);
    }

    function getIpSocket(socket) {
        return ipFromSocket(socket, trustProxy);
    }

    // A breakout room may be created by a guest's browser only after a presenter assigned it,
    // and only while its main room is running.
    // TLLM*meet: an admin runs every room; a moderator only the rooms they opened (or that their
    // date polls reserved), breakout rooms included
    function ownsRoom(session, roomId) {
        if (!session) return false;
        if (session.role === 'admin') return true;
        const mainRoomId = String(roomId).split('_breakout_')[0];
        return roomRegistry.get(mainRoomId)?.owner === session.username;
    }

    function isAuthorizedBreakout(roomId) {
        if (!roomId || !String(roomId).includes('_breakout_')) return false;
        const mainRoomId = String(roomId).split('_breakout_')[0];
        return roomList.has(mainRoomId) && adminAuth.isBreakoutAllowed(roomId);
    }
}

// ####################################################
// GRACEFUL SHUTDOWN HANDLERS
// ####################################################

let isShuttingDown = false;

async function gracefulShutdown(signal) {
    if (isShuttingDown) {
        log.warn(`${signal} received again, forcing exit...`);
        process.exit(1);
    }

    isShuttingDown = true;
    log.info(`${signal} received, starting graceful shutdown...`);
    datePolls.saveNow(); // TLLM*meet: date polls and rooms written before leaving
    roomRegistry.saveNow();

    try {
        // 1. Stop accepting new connections
        log.debug('Closing HTTP server...');
        server.close(() => {
            log.info('HTTP server closed');
        });

        // 2. Close all active rooms and notify peers
        log.debug(`Closing ${roomList.size} active rooms...`);
        for (const [roomId, room] of roomList.entries()) {
            try {
                // Notify all peers in the room
                room.sendToAll('serverShutdown', { message: 'Server is shutting down' });

                // Remove all peers from the room
                const peers = room.getPeers();
                for (const [peerId] of peers) {
                    room.removePeer(peerId);
                }

                roomList.delete(roomId);
                collab.drop(roomId);
                transcripts.close(roomId);
            } catch (err) {
                log.error(`Error closing room ${roomId}:`, err.message);
            }
        }

        // 3. Disconnect all Socket.IO clients
        log.debug('Disconnecting all Socket.IO clients...');
        const sockets = await io.fetchSockets();
        for (const socket of sockets) {
            socket.disconnect(true);
        }

        // 4. Close Socket.IO server
        log.debug('Closing Socket.IO server...');
        io.close();

        // 5. Close all mediasoup workers
        log.debug(`Closing ${workers.length} mediasoup workers...`);
        for (const worker of workers) {
            try {
                worker.close();
            } catch (err) {
                log.error('Error closing mediasoup worker:', err.message);
            }
        }

        // 6. Cleanup HTML injector
        log.debug('Cleaning up HTML injector...');
        htmlInjector.cleanup();

        log.info('Graceful shutdown completed successfully');
        process.exit(0);
    } catch (err) {
        log.error('Error during graceful shutdown:', err.message);
        process.exit(1);
    }
}

// Set a timeout for forced shutdown if graceful shutdown takes too long
function forceShutdown(signal) {
    setTimeout(() => {
        log.error(`Graceful shutdown timeout exceeded, forcing exit...`);
        process.exit(1);
    }, 30000); // 30 seconds timeout
}

process.on('SIGINT', () => {
    log.debug('PROCESS', 'SIGINT');
    forceShutdown('SIGINT');
    gracefulShutdown('SIGINT');
});

process.on('SIGTERM', () => {
    log.debug('PROCESS', 'SIGTERM');
    forceShutdown('SIGTERM');
    gracefulShutdown('SIGTERM');
});

// Handle uncaught exceptions and rejections
process.on('uncaughtException', (err) => {
    log.error('Uncaught Exception:', err);
    forceShutdown('uncaughtException');
    gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
    log.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Don't exit on unhandled rejection, just log it
});
