'use strict';

/**
 * TLLM*meet - integration test: meeting transcription.
 * Starts the real server against a fake speech-to-text server (it "recognises" the bytes it receives
 * as text), then plays a meeting: the presenter starts the transcription, two people speak, the
 * room closes and the organiser downloads one file with timecode and speaker.
 */

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const ROOT = path.join(__dirname, '..');
const PORT = 3700 + Math.floor(Math.random() * 500);
const BASE = `https://localhost:${PORT}`;
const ADMIN = { username: 'jules', password: 'S3cret-Pass', displayname: 'Jules' };
const ASR_KEY = 'asr-test-key';

function request(method, urlPath, { body, cookie } = {}) {
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
                },
            },
            (res) => {
                let raw = '';
                res.setEncoding('utf8');
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

const emit = (socket, event, data = {}) => new Promise((resolve) => socket.emit(event, data, (res) => resolve(res)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const said = (text) => Buffer.from(text, 'utf8').toString('base64');

function peerInfo(name) {
    return {
        peer_name: name,
        peer_id: crypto.randomUUID(),
        peer_uuid: crypto.randomUUID(),
        peer_audio: true,
        peer_video: false,
        peer_screen: false,
        peer_hand: false,
        peer_presenter: false,
        os_name: 'Linux',
        os_version: '1',
        browser_name: 'Test',
        browser_version: '1',
    };
}

describe('Meeting transcription (integration)', function () {
    this.timeout(60000);

    let server;
    let asr;
    let asrCalls = [];
    const warmups = []; // the speech-to-text server is woken up when a meeting starts its transcription
    let logs = '';
    const sockets = [];

    before(async () => {
        // Fake OpenAI-compatible speech-to-text: the "audio" is the text itself
        asr = http.createServer((req, res) => {
            let raw = '';
            req.setEncoding('utf8');
            req.on('data', (c) => (raw += c));
            req.on('end', () => {
                if (req.url === '/v1/warmup') {
                    warmups.push(req.headers.authorization);
                    return res.end('{"state":"loading"}');
                }
                asrCalls.push({ auth: req.headers.authorization, raw });
                const match = /filename="audio\.webm"\r\nContent-Type: audio\/webm\r\n\r\n([\s\S]*?)\r\n--/.exec(raw);
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ text: match ? match[1] : '', segments: [] }));
            });
        });
        await new Promise((r) => asr.listen(0, '127.0.0.1', r));

        const configJs = path.join(ROOT, 'app/src/config.js');
        if (!fs.existsSync(configJs)) fs.copyFileSync(path.join(ROOT, 'app/src/config.template.js'), configJs);
        server = spawn(process.execPath, ['app/src/Server.js'], {
            cwd: ROOT,
            env: {
                ...process.env,
                SERVER_LISTEN_PORT: String(PORT),
                SFU_NUM_WORKERS: '1',
                JWT_SECRET: crypto.randomBytes(32).toString('hex'),
                HOST_USERS: `${ADMIN.username}:${ADMIN.password}:${ADMIN.displayname}`,
                TRUST_PROXY: 'false',
                DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tllm-test-data-')),
                WHISPER_ENABLED: 'true',
                WHISPER_BASE_PATH: `http://127.0.0.1:${asr.address().port}/v1/`,
                WHISPER_API_KEY: ASR_KEY,
                WHISPER_MODEL: 'parakeet',
                WHISPER_LANGUAGE: '',
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
        if (asr) asr.close();
        await wait(300);
    });

    it('records who said what, and gives the organiser one file after the meeting', async () => {
        const login = await request('POST', '/login', {
            body: { username: ADMIN.username, password: ADMIN.password },
        });
        assert.equal(login.status, 200, login.body);
        const cookie = login.headers['set-cookie'][0].split(';')[0];

        const created = await request('POST', '/admin/rooms', { body: { name: 'Point hebdo' }, cookie });
        const roomId = created.json.room;
        const token = (await request('GET', `/createRoomToken?room=${encodeURIComponent(roomId)}`, { cookie })).json
            .token;

        const admin = await connect(cookie);
        sockets.push(admin);
        assert.ok(!(await emit(admin, 'createRoom', { room_id: roomId, token })).error);
        await emit(admin, 'join', { room_id: roomId, peer_info: peerInfo('Jules') });

        const guest = await connect();
        sockets.push(guest);
        await emit(guest, 'createRoom', { room_id: roomId });
        await emit(guest, 'join', { room_id: roomId, peer_info: peerInfo('Marie') });

        assert.deepEqual(await emit(guest, 'meetingTranscription'), { available: true, active: false });

        // Nothing is kept before the presenter starts, and a guest cannot start it
        const early = await emit(guest, 'getWhisperTranscription', { audio: said('Trop tôt'), meeting: true });
        assert.equal(early.inactive, true);
        assert.equal(asrCalls.length, 0);
        assert.equal((await emit(guest, 'setMeetingTranscription', { active: true })).error, 'not allowed');

        const announced = new Promise((resolve) => guest.once('meetingTranscription', resolve));
        assert.equal((await emit(admin, 'setMeetingTranscription', { active: true })).active, true);
        assert.equal((await announced).active, true);
        await wait(200);
        assert.deepEqual(warmups, [`Bearer ${ASR_KEY}`]);

        const caption = new Promise((resolve) => admin.once('meetingTranscript', resolve));
        const one = await emit(admin, 'getWhisperTranscription', {
            audio: said('On commence ?'),
            mimeType: 'audio/webm',
            meeting: true,
            ageMs: 3000,
        });
        assert.equal(one.text, 'On commence ?');
        await emit(guest, 'getWhisperTranscription', {
            audio: said('Oui, bonjour à tous.'),
            mimeType: 'audio/webm',
            meeting: true,
            ageMs: 1000,
        });
        assert.deepEqual(await caption, { peer_name: 'Jules', text: 'On commence ?' });
        assert.equal(asrCalls[0].auth, `Bearer ${ASR_KEY}`);
        assert.match(asrCalls[0].raw, /name="language"\r\n\r\nfr\r\n/); // French by default

        // Organiser only, and not before the end
        assert.equal((await request('GET', `/api/transcriptions/${roomId}`)).status, 401);
        const during = await request('GET', `/api/transcriptions/${roomId}`, { cookie });
        assert.equal(during.json.sessions[0].status, 'active');
        const id = during.json.sessions[0].id;
        assert.equal((await request('GET', `/transcriptions/${roomId}/${id}.txt`, { cookie })).status, 409);

        // Everybody leaves: the room closes and the file is final
        await emit(guest, 'exitRoom');
        await emit(admin, 'exitRoom');
        await wait(200);
        const after = await request('GET', `/api/transcriptions/${roomId}`, { cookie });
        assert.equal(after.json.sessions[0].status, 'ready');
        assert.deepEqual(after.json.sessions[0].speakers.sort(), ['Jules', 'Marie']);

        const file = await request('GET', `/transcriptions/${roomId}/${id}.txt`, { cookie });
        assert.equal(file.status, 200);
        assert.match(file.headers['content-type'], /^text\/plain/);
        assert.match(file.headers['content-disposition'], /attachment; filename="transcription-.*\.txt"/);
        const lines = file.body.split('\n');
        assert.equal(lines[0], 'Point hebdo');
        assert.equal(lines[2], 'Participants : Jules, Marie');
        const body = lines.filter((l) => l.startsWith('['));
        assert.equal(body.length, 2);
        assert.match(body[0], /^\[00:00:0\d\] Jules : On commence \?$/);
        assert.match(body[1], /^\[00:00:0\d\] Marie : Oui, bonjour à tous\.$/);
        assert.ok(!file.body.includes('Trop tôt'));

        // On the home page, the room offers the download
        const overview = await request('GET', '/api/admin/overview', { cookie });
        const room = overview.json.rooms.find((r) => r.id === roomId);
        assert.deepEqual(room.transcript, { id, status: 'ready' });
    });
});
