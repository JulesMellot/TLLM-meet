'use strict';

/**
 * TLLM*meet - integration test: only the admin can create a meeting.
 * Starts the real server with an admin account and replays the bypass attempts over HTTP and Socket.IO.
 */

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const ROOT = path.join(__dirname, '..');
const PORT = 3200 + Math.floor(Math.random() * 500);
const BASE = `https://localhost:${PORT}`;
const ADMIN = { username: 'jules', password: 'S3cret-Pass', displayname: 'Jules' };
const ADMIN2 = { username: 'alice', password: 'Alice-Pass-9', displayname: 'Alice' };

function request(method, urlPath, { body, cookie, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = https.request(
            `${BASE}${urlPath}`,
            {
                method,
                rejectUnauthorized: false,
                headers: {
                    ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
                    ...(cookie ? { Cookie: cookie } : {}),
                    ...headers,
                },
            },
            (res) => {
                let raw = '';
                res.on('data', (chunk) => (raw += chunk));
                res.on('end', () => {
                    let json = null;
                    try {
                        json = JSON.parse(raw);
                    } catch {}
                    resolve({ status: res.statusCode, headers: res.headers, body: raw, json });
                });
            }
        );
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

async function login(user) {
    const res = await request('POST', '/login', { body: { username: user.username, password: user.password } });
    assert.equal(res.status, 200, res.body);
    return res.headers['set-cookie'][0].split(';')[0];
}

function connect(cookie) {
    return new Promise((resolve, reject) => {
        const socket = io(BASE, {
            transports: ['websocket'],
            rejectUnauthorized: false,
            forceNew: true,
            reconnection: false,
            extraHeaders: cookie ? { cookie } : {},
        });
        socket.on('connect', () => resolve(socket));
        socket.on('connect_error', reject);
    });
}

function emit(socket, event, data) {
    return new Promise((resolve) => socket.emit(event, data, (res) => resolve(res)));
}

function peerInfo(name, extra = {}) {
    return {
        peer_name: name,
        peer_id: crypto.randomUUID(),
        peer_uuid: crypto.randomUUID(),
        peer_audio: false,
        peer_video: false,
        peer_screen: false,
        peer_hand: false,
        peer_presenter: false,
        os_name: 'Linux',
        os_version: '1',
        browser_name: 'Test',
        browser_version: '1',
        ...extra,
    };
}

async function joinRoom(socket, roomId, info, createToken = null) {
    const created = await emit(socket, 'createRoom', { room_id: roomId, token: createToken });
    const room = await emit(socket, 'join', { room_id: roomId, peer_info: info });
    return { created, room };
}

function presenterOf(room, name) {
    const peers = new Map(JSON.parse(room.peers));
    const peer = [...peers.values()].find((p) => p.peer_name === name);
    return peer ? peer.peer_presenter : undefined;
}

async function createToken(roomId, cookie) {
    const res = await request('GET', `/createRoomToken?room=${encodeURIComponent(roomId)}`, { cookie });
    return res;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('Only the admin can create a meeting (integration)', function () {
    this.timeout(60000);

    let server;
    let logs = '';
    const sockets = [];

    before(async () => {
        const configJs = path.join(ROOT, 'app/src/config.js');
        if (!fs.existsSync(configJs)) fs.copyFileSync(path.join(ROOT, 'app/src/config.template.js'), configJs);
        server = spawn(process.execPath, ['app/src/Server.js'], {
            cwd: ROOT,
            env: {
                ...process.env,
                SERVER_LISTEN_PORT: String(PORT),
                SFU_NUM_WORKERS: '1',
                JWT_SECRET: crypto.randomBytes(32).toString('hex'),
                HOST_USERS: [ADMIN, ADMIN2].map((u) => `${u.username}:${u.password}:${u.displayname}`).join('|'),
                HOST_MAX_LOGIN_ATTEMPTS: '5',
                TRUST_PROXY: 'false',
                CREATE_ROOM_RATE_LIMIT_MAX: '200',
            },
        });
        server.stdout.on('data', (d) => (logs += d));
        server.stderr.on('data', (d) => (logs += d));
        for (let i = 0; i < 80; i++) {
            try {
                const res = await request('GET', '/admin/session');
                if (res.status === 200) return;
            } catch {}
            await wait(250);
        }
        throw new Error('server did not start:\n' + logs);
    });

    after(async () => {
        sockets.forEach((s) => s.close());
        if (server) server.kill('SIGTERM');
        await wait(300);
    });

    it('refuses a creation token to anonymous visitors, whatever name they type', async () => {
        for (const q of ['', '&name=Jules', '&name=jules', '&name=admin']) {
            const res = await request('GET', `/createRoomToken?room=pirate${q}`);
            assert.equal(res.status, 403, q);
            assert.equal(res.json.token, null);
        }
    });

    it('rejects wrong credentials and the display name as a login', async () => {
        for (const body of [
            { username: 'jules', password: 'wrong' },
            { username: 'Jules', password: ADMIN.password },
            { username: 'jules', password: '' },
            { username: ['jules'], password: [ADMIN.password] },
        ]) {
            const res = await request('POST', '/login', { body });
            assert.ok([400, 401].includes(res.status), JSON.stringify(body));
            assert.equal(res.headers['set-cookie'], undefined);
        }
    });

    it('logs the admin in with a hardened cookie and no token in the body', async () => {
        const res = await request('POST', '/login', { body: { username: ADMIN.username, password: ADMIN.password } });
        assert.equal(res.status, 200);
        const cookie = res.headers['set-cookie'][0];
        assert.match(cookie, /^tllm_admin=/);
        assert.match(cookie, /HttpOnly/);
        assert.match(cookie, /Secure/);
        assert.match(cookie, /SameSite=Lax/);
        assert.deepEqual(Object.keys(res.json).sort(), ['name', 'ok']);
        assert.ok(!res.body.includes(ADMIN.password));
    });

    it('still refuses anonymous visitors while the admin is logged in (no global flag, no IP trust)', async () => {
        const cookie = await login(ADMIN);
        assert.equal((await createToken('admin-room', cookie)).status, 200);
        // same IP as the admin, admin session active
        assert.equal((await createToken('pirate2')).status, 403);
        assert.equal((await createToken('pirate3&name=Jules')).status, 403);
        await request('GET', '/'); // used to reset/flip the old global flag
        assert.equal((await createToken('admin-room', cookie)).status, 200);
        assert.equal((await request('POST', '/admin/rooms', { body: { name: 'x' } })).status, 401);
    });

    it('rejects forged or tampered session cookies', async () => {
        const cookie = await login(ADMIN);
        const token = cookie.split('=')[1];
        const [h, p] = token.split('.');
        const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
        const forged = [
            'tllm_admin=garbage',
            `tllm_admin=${h}.${Buffer.from(JSON.stringify({ ...payload, sub: 'alice' })).toString('base64url')}.${token.split('.')[2]}`,
            `tllm_admin=${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${p}.`,
        ];
        for (const c of forged) {
            assert.equal((await createToken('forged-room', c)).status, 403, c);
            assert.equal((await request('GET', '/admin/session', { cookie: c })).json.admin, false);
        }
    });

    it('sends guests of a meeting that has not started to the waiting page, never the room page', async () => {
        const cookie = await login(ADMIN);
        const anon = await request('GET', '/join/pas-encore');
        assert.equal(anon.status, 302);
        assert.equal(anon.headers.location, '/whoAreYou/pas-encore');
        const direct = await request('GET', '/join/?room=pas-encore&name=Jules&audio=1');
        assert.equal(direct.status, 302);
        assert.equal(direct.headers.location, '/whoAreYou/pas-encore?room=pas-encore&name=Jules&audio=1');
        const admin = await request('GET', '/join/pas-encore', { cookie });
        assert.equal(admin.status, 200);
        assert.equal((await request('POST', '/isRoomActive', { body: { roomId: 'pas-encore' } })).json.message, false);
        assert.equal((await request('POST', '/isRoomActive', { body: { roomId: '../x' } })).status, 400);
    });

    it('creates meeting names with a random suffix, for the admin only', async () => {
        const cookie = await login(ADMIN);
        const res = await request('POST', '/admin/rooms', { body: { name: 'Point lundi' }, cookie });
        assert.equal(res.status, 200);
        assert.match(res.json.room, /^point-lundi-[a-z2-9]{6}$/);
    });

    describe('Socket.IO', () => {
        const ROOM = 'visio-' + crypto.randomBytes(3).toString('hex');
        let adminCookie;
        let adminSocket;
        let adminInfo;
        let bobSocket;
        let bobInfo;

        it('refuses createRoom without a token, or with a token for another room', async () => {
            const guest = await connect();
            sockets.push(guest);
            assert.deepEqual(await emit(guest, 'createRoom', { room_id: ROOM }), {
                error: 'Room creation not authorized',
            });
            adminCookie = await login(ADMIN);
            const other = (await createToken('another-room', adminCookie)).json.token;
            assert.deepEqual(await emit(guest, 'createRoom', { room_id: ROOM, token: other }), {
                error: 'Room creation not authorized',
            });
            assert.equal((await request('POST', '/isRoomActive', { body: { roomId: ROOM } })).json.message, false);
            const join = await emit(guest, 'join', { room_id: ROOM, peer_info: peerInfo('Mallory') });
            assert.deepEqual(join, { error: 'Room does not exist' });
        });

        it('lets the admin create the meeting and makes the admin presenter', async () => {
            adminSocket = await connect(adminCookie);
            sockets.push(adminSocket);
            const token = (await createToken(ROOM, adminCookie)).json.token;
            adminInfo = peerInfo('Jules');
            const { created, room } = await joinRoom(adminSocket, ROOM, adminInfo, token);
            assert.equal(created.room_id, ROOM);
            assert.equal(presenterOf(room, 'Jules'), true);
            assert.equal((await request('POST', '/isRoomActive', { body: { roomId: ROOM } })).json.message, true);
        });

        it('never makes a guest presenter, even with client-side flags or a fake token', async () => {
            const guest = await connect();
            sockets.push(guest);
            bobSocket = guest;
            bobInfo = peerInfo('Bob', { peer_presenter: true, peer_token: 'eyJhbGciOiJIUzI1NiJ9.fake.fake' });
            const { room } = await joinRoom(guest, ROOM, bobInfo);
            assert.equal(presenterOf(room, 'Bob'), false);
            // guest tries to flag itself as presenter
            guest.emit('updatePeerInfo', { peer_name: 'Bob', type: 'presenter', status: true, broadcast: true });
            await wait(200);
            const probe = await connect();
            sockets.push(probe);
            const { room: seen } = await joinRoom(probe, ROOM, peerInfo('Probe1'));
            assert.equal(presenterOf(seen, 'Bob'), false);
            probe.close();
        });

        it('authorizes breakout rooms only when the presenter assigns them', async () => {
            const breakout = `${ROOM}_breakout_1`;
            assert.equal((await createToken(breakout)).status, 403);
            adminSocket.emit('breakoutRoom', {
                peer_name: adminInfo.peer_name,
                peer_uuid: adminInfo.peer_uuid,
                mainRoom: ROOM,
                assignments: [
                    { peerId: 'nobody', breakoutRoom: breakout },
                    { peerId: 'nobody', breakoutRoom: 'other-room_breakout_1' },
                ],
            });
            await wait(200);
            assert.equal((await createToken(breakout)).status, 200);
            assert.equal((await createToken('other-room_breakout_1')).status, 403);
            // a guest cannot authorize breakout rooms
            const guest = await connect();
            sockets.push(guest);
            await joinRoom(guest, ROOM, peerInfo('Eve'));
            guest.emit('breakoutRoom', {
                peer_name: 'Eve',
                peer_uuid: 'x',
                mainRoom: ROOM,
                assignments: [{ peerId: 'nobody', breakoutRoom: `${ROOM}_breakout_9` }],
            });
            await wait(200);
            assert.equal((await createToken(`${ROOM}_breakout_9`)).status, 403);
            guest.close();
        });

        it('does not hand the presenter role to a guest when the admin leaves', async () => {
            adminSocket.close();
            await wait(500);
            const probe = await connect();
            sockets.push(probe);
            const { room } = await joinRoom(probe, ROOM, peerInfo('Probe2'));
            assert.equal(presenterOf(room, 'Bob'), false);
            assert.equal(presenterOf(room, 'Probe2'), false);
        });

        it('lets the admin promote a guest, and a promoted guest cannot demote the admin', async () => {
            adminSocket = await connect(adminCookie);
            sockets.push(adminSocket);
            adminInfo = peerInfo('Jules');
            const { room } = await joinRoom(adminSocket, ROOM, adminInfo);
            assert.equal(presenterOf(room, 'Jules'), true);
            const peers = new Map(JSON.parse(room.peers));
            const bobId = [...peers.entries()].find(([, p]) => p.peer_name === 'Bob')[0];
            adminSocket.emit('setPresenterRole', {
                peer_id: bobId,
                action: 'grant',
                from_peer_name: adminInfo.peer_name,
                from_peer_uuid: adminInfo.peer_uuid,
            });
            await wait(200);
            // the promoted guest tries to demote the admin
            bobSocket.emit('setPresenterRole', {
                peer_id: adminSocket.id,
                action: 'revoke',
                from_peer_name: bobInfo.peer_name,
                from_peer_uuid: bobInfo.peer_uuid,
            });
            await wait(200);
            const probe = await connect();
            sockets.push(probe);
            const { room: seen } = await joinRoom(probe, ROOM, peerInfo('Probe3'));
            assert.equal(presenterOf(seen, 'Bob'), true);
            assert.equal(presenterOf(seen, 'Jules'), true);
        });
    });

    describe('Polls', () => {
        const ROOM = 'sondage-' + crypto.randomBytes(3).toString('hex');
        let admin;
        let bob;
        let bob2;
        const latest = new Map(); // socket -> last updatePolls payload

        const track = (socket) => socket.on('updatePolls', (polls) => latest.set(socket, polls));
        const pollsOf = (socket) => latest.get(socket);

        before(async () => {
            const cookie = await login(ADMIN);
            admin = await connect(cookie);
            sockets.push(admin);
            track(admin);
            await joinRoom(admin, ROOM, peerInfo('Jules'), (await createToken(ROOM, cookie)).json.token);
            bob = await connect();
            bob2 = await connect();
            sockets.push(bob, bob2);
            track(bob);
            track(bob2);
            await joinRoom(bob, ROOM, peerInfo('Bob'));
            await joinRoom(bob2, ROOM, peerInfo('Carol'));
        });

        it('ignores a poll created by a guest', async () => {
            bob.emit('createPoll', { question: 'Guest poll?', options: ['a', 'b'] });
            await wait(300);
            assert.equal(pollsOf(admin), undefined);
            assert.equal(pollsOf(bob), undefined);
        });

        it('rejects invalid polls from the admin (empty, single or duplicate options)', async () => {
            admin.emit('createPoll', { question: '   ', options: ['a', 'b'] });
            admin.emit('createPoll', { question: 'Q?', options: ['only one'] });
            admin.emit('createPoll', { question: 'Q?', options: ['same', 'same'] });
            admin.emit('createPoll', { question: 'Q?', options: 'not an array' });
            await wait(300);
            assert.equal(pollsOf(admin), undefined);
        });

        it('lets the admin create a poll that everyone receives, with totals', async () => {
            admin.emit('createPoll', { question: 'On mange où ?', options: ['Pizza', 'Sushi'] });
            await wait(300);
            for (const socket of [admin, bob, bob2]) {
                const [poll] = pollsOf(socket);
                assert.equal(poll.question, 'On mange où ?');
                assert.deepEqual(poll.options, ['Pizza', 'Sushi']);
                assert.deepEqual(poll.counts, [0, 0]);
                assert.equal(typeof poll.id, 'string');
            }
        });

        it('counts each participant once and keeps voters private from guests', async () => {
            const { id } = pollsOf(bob)[0];
            bob.emit('vote', { pollId: id, option: 'Sushi' });
            bob2.emit('vote', { pollId: id, option: 'Pizza' });
            bob.emit('vote', { pollId: id, option: 'Pizza' }); // changes his vote
            bob.emit('vote', { pollId: id, option: 'Not an option' }); // ignored
            await wait(300);
            const seenByBob = pollsOf(bob)[0];
            assert.deepEqual(seenByBob.counts, [2, 0]);
            assert.equal(seenByBob.total, 2);
            assert.equal(seenByBob.myVote, 'Pizza');
            assert.deepEqual(seenByBob.voters, {}, 'guests do not see who voted what');
            const seenByAdmin = pollsOf(admin)[0];
            assert.deepEqual(seenByAdmin.voters, { Bob: 'Pizza', Carol: 'Pizza' });
            assert.equal(seenByAdmin.myVote, null);
        });

        it('ignores edit and delete attempts by guests, even with forged names', async () => {
            const { id } = pollsOf(bob)[0];
            bob.emit('editPoll', { pollId: id, question: 'Hacked', options: ['x', 'y'], peer_name: 'Jules' });
            bob.emit('deletePoll', { pollId: id, index: 0, peer_name: 'Jules' });
            await wait(300);
            assert.equal(pollsOf(admin)[0].question, 'On mange où ?');
            assert.equal(pollsOf(admin).length, 1);
        });

        it('keeps the votes when the admin edits a poll (they used to vanish)', async () => {
            const { id } = pollsOf(admin)[0];
            admin.emit('editPoll', { pollId: id, question: 'On mange où ce midi ?', options: ['Pizza', 'Crêpes'] });
            await wait(300);
            const poll = pollsOf(bob)[0];
            assert.equal(poll.question, 'On mange où ce midi ?');
            assert.deepEqual(poll.counts, [2, 0]);
            assert.equal(poll.myVote, 'Pizza');
        });

        it('lets only a presenter close a poll, and refuses votes once it is closed', async () => {
            const { id } = pollsOf(admin)[0];
            bob.emit('closePoll', { pollId: id });
            await wait(300);
            assert.equal(pollsOf(admin)[0].closed, false);
            admin.emit('closePoll', { pollId: id });
            await wait(300);
            assert.equal(pollsOf(bob)[0].closed, true);
            bob2.emit('vote', { pollId: id, option: 'Crêpes' });
            await wait(300);
            assert.deepEqual(pollsOf(admin)[0].counts, [2, 0]);
        });

        it('lets the admin delete a poll by id', async () => {
            admin.emit('createPoll', { question: 'Second ?', options: ['Oui', 'Non'] });
            await wait(300);
            const first = pollsOf(admin)[0].id;
            admin.emit('deletePoll', { pollId: first });
            await wait(300);
            assert.deepEqual(
                pollsOf(bob).map((p) => p.question),
                ['Second ?']
            );
        });
    });

    describe('Sharing permission', () => {
        const ROOM = 'partage-' + crypto.randomBytes(3).toString('hex');
        let admin;
        let bob;
        let carol;
        const received = [];

        before(async () => {
            const cookie = await login(ADMIN);
            admin = await connect(cookie);
            bob = await connect();
            carol = await connect();
            sockets.push(admin, bob, carol);
            await joinRoom(admin, ROOM, peerInfo('Jules'), (await createToken(ROOM, cookie)).json.token);
            await joinRoom(bob, ROOM, peerInfo('Bob'));
            await joinRoom(carol, ROOM, peerInfo('Carol'));
            carol.on('editorChange', (data) => received.push(data));
        });

        it('drops whiteboard / editor / file / video events from a guest who was not allowed', async () => {
            bob.emit('editorChange', { text: 'from bob' });
            await wait(300);
            assert.equal(received.length, 0);
        });

        it('lets the admin, but not a guest, grant the permission to one person', async () => {
            const permissions = [];
            carol.on('sharePermission', (data) => permissions.push(data));
            carol.emit('setSharePermission', { peer_id: bob.id, allowed: true });
            await wait(300);
            assert.equal(permissions.length, 0, 'a guest cannot grant');
            admin.emit('setSharePermission', { peer_id: bob.id, allowed: true });
            await wait(300);
            assert.deepEqual(permissions, [{ peer_id: bob.id, peer_name: 'Bob', allowed: true }]);
            bob.emit('editorChange', { text: 'allowed now' });
            await wait(300);
            assert.equal(received.length, 1);
            const info = await emit(carol, 'getRoomInfo', {});
            assert.deepEqual(info.sharers, [bob.id]);
        });

        it('applies to that person only, and can be withdrawn', async () => {
            carol.emit('editorChange', { text: 'carol is not allowed' });
            await wait(300);
            assert.equal(received.length, 1);
            admin.emit('setSharePermission', { peer_id: bob.id, allowed: false });
            await wait(300);
            bob.emit('editorChange', { text: 'withdrawn' });
            await wait(300);
            assert.equal(received.length, 1);
        });

        it('always lets the admin share', async () => {
            admin.emit('editorChange', { text: 'admin' });
            await wait(300);
            assert.equal(received.length, 2);
        });
    });

    describe('Shared editor and whiteboard (collabSync)', () => {
        const Y = require('yjs');
        const syncProtocol = require('y-protocols/sync');
        const awarenessProtocol = require('y-protocols/awareness');
        const encoding = require('lib0/encoding');
        const decoding = require('lib0/decoding');
        const ROOM = 'notes-' + crypto.randomBytes(3).toString('hex');
        let admin;
        let bob;
        let carol;
        const toCarol = [];

        const updateMessage = (text) => {
            const doc = new Y.Doc();
            doc.getText('editor').insert(0, text);
            const encoder = encoding.createEncoder();
            syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(doc));
            return encoding.toUint8Array(encoder);
        };
        // Apply what the server sent to a fresh document and read the editor text
        const textFrom = (messages) => {
            const doc = new Y.Doc();
            for (const m of messages) {
                const decoder = decoding.createDecoder(new Uint8Array(m));
                syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), doc, null);
            }
            return doc.getText('editor').toString();
        };
        const step1 = () => {
            const encoder = encoding.createEncoder();
            syncProtocol.writeSyncStep1(encoder, new Y.Doc());
            return encoding.toUint8Array(encoder);
        };

        before(async () => {
            const cookie = await login(ADMIN);
            admin = await connect(cookie);
            bob = await connect();
            carol = await connect();
            sockets.push(admin, bob, carol);
            await joinRoom(admin, ROOM, peerInfo('Jules'), (await createToken(ROOM, cookie)).json.token);
            await joinRoom(bob, ROOM, peerInfo('Bob'));
            await joinRoom(carol, ROOM, peerInfo('Carol'));
            carol.on('collabSync', (data) => toCarol.push(data));
        });

        it('drops writes from a guest who may not share', async () => {
            bob.emit('collabSync', updateMessage('from bob'));
            await wait(300);
            assert.equal(toCarol.length, 0);
        });

        it('relays the admin writes to everyone and keeps them for late joiners', async () => {
            admin.emit('collabSync', updateMessage('Ordre du jour'));
            await wait(300);
            assert.equal(textFrom(toCarol), 'Ordre du jour');

            const dave = await connect();
            sockets.push(dave);
            await joinRoom(dave, ROOM, peerInfo('Dave'));
            const replies = [];
            dave.on('collabSync', (data) => replies.push(data));
            dave.emit('collabSync', step1());
            await wait(300);
            assert.equal(replies.length, 2, 'what dave misses, then what the server misses');
            assert.equal(textFrom(replies), 'Ordre du jour');
        });

        it('shows the name the server knows next to a cursor', async () => {
            const doc = new Y.Doc();
            const awareness = new awarenessProtocol.Awareness(doc);
            awareness.setLocalState({ user: { name: 'Jules', color: 'red;background:url(x)' }, cursor: null });
            const seen = [];
            carol.on('collabAwareness', (data) => seen.push(data));
            bob.emit('collabAwareness', awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID]));
            await wait(300);
            awareness.destroy();
            assert.equal(seen.length, 1);
            const other = new awarenessProtocol.Awareness(new Y.Doc());
            awarenessProtocol.applyAwarenessUpdate(other, new Uint8Array(seen[0]), null);
            const state = other.getStates().get(doc.clientID);
            other.destroy();
            assert.deepEqual(state.user, { name: 'Bob', color: '#8a94a6' });
        });
    });

    it('revokes the session on logout (replaying the old cookie fails)', async () => {
        const cookie = await login(ADMIN2);
        assert.equal((await createToken('logout-room', cookie)).status, 200);
        const out = await request('GET', '/logout', { cookie });
        assert.equal(out.status, 302);
        assert.match(out.headers['set-cookie'][0], /Max-Age=0/);
        assert.equal((await createToken('logout-room', cookie)).status, 403);
        assert.equal((await request('GET', '/admin/session', { cookie })).json.admin, false);
    });

    it('rate-limits password guessing', async () => {
        const statuses = [];
        for (let i = 0; i < 7; i++) {
            statuses.push(
                (await request('POST', '/login', { body: { username: 'alice', password: 'guess' + i } })).status
            );
        }
        assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401]);
        assert.equal(statuses[6], 429);
    });

    it('never writes admin passwords to the logs', async () => {
        assert.ok(logs.length > 0);
        assert.ok(!logs.includes(ADMIN.password), 'admin password found in logs');
        assert.ok(!logs.includes(ADMIN2.password), 'admin password found in logs');
    });
});
