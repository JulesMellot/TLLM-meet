'use strict';

/**
 * TLLM*meet - browser test: the organiser renames and deletes rooms from the home page.
 * Starts the real server, drives Chromium with Playwright, and checks what the organiser sees.
 * Run: npm run test:browser (needs "npx playwright install chromium" once).
 */

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { io } = require('socket.io-client');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 3800 + Math.floor(Math.random() * 500);
const BASE = `https://localhost:${PORT}`;
const ARTIFACTS = process.env.BROWSER_ARTIFACTS || '';
const ADMIN = { username: 'jules', password: 'S3cret-Pass', displayname: 'Jules' };

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('Home page: rename and delete rooms (browser)', function () {
    this.timeout(90000);

    let server;
    let logs = '';
    let browser;
    let context;
    let page;
    const sockets = [];
    let failed = false;

    // Calls the API with the browser's session cookie
    const api = async (method, url, data) => {
        const res = await context.request.fetch(`${BASE}${url}`, { method, data });
        let json = null;
        try {
            json = await res.json();
        } catch {}
        return { status: res.status(), json };
    };
    const newRoom = async (name) => (await api('POST', '/admin/rooms', { name })).json.room;
    const row = (name) =>
        page.locator('#rooms li.tllm-room', { has: page.locator('.tllm-room-name-row', { hasText: name }) });
    const openMenu = async (name) => {
        await row(name).locator('summary', { hasText: '⋯' }).click();
        return row(name).locator('.tllm-menu-list');
    };
    const toast = () => page.locator('#toast');

    // An organiser in the meeting, like a browser tab would be
    async function startMeeting(roomId) {
        const cookies = await context.cookies(BASE);
        const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
        const socket = io(BASE, {
            transports: ['websocket'],
            rejectUnauthorized: false,
            forceNew: true,
            reconnection: false,
            extraHeaders: { cookie },
        });
        sockets.push(socket);
        await new Promise((resolve, reject) => {
            socket.on('connect', resolve);
            socket.on('connect_error', reject);
        });
        const token = (await api('GET', `/createRoomToken?room=${encodeURIComponent(roomId)}`)).json.token;
        const emit = (event, data) => new Promise((resolve) => socket.emit(event, data, resolve));
        await emit('createRoom', { room_id: roomId, token });
        const joined = await emit('join', {
            room_id: roomId,
            peer_info: {
                peer_name: 'Jules',
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
            },
        });
        assert.ok(!joined?.error, JSON.stringify(joined));
        return socket;
    }

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
                HOST_USERS: `${ADMIN.username}:${ADMIN.password}:${ADMIN.displayname}`,
                TRUST_PROXY: 'false',
                CREATE_ROOM_RATE_LIMIT_MAX: '200',
                DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tllm-browser-data-')),
            },
        });
        server.stdout.on('data', (d) => (logs += d));
        server.stderr.on('data', (d) => (logs += d));

        browser = await chromium.launch();
        context = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'fr-FR', timezoneId: 'Europe/Paris' });
        // In CI, a trace of the whole run is kept for the failed tests (see BROWSER_ARTIFACTS)
        if (ARTIFACTS) await context.tracing.start({ screenshots: true, snapshots: true });
        page = await context.newPage();
        const pageErrors = [];
        page.on('pageerror', (err) => pageErrors.push(err));
        page.pageErrors = pageErrors;

        for (let i = 0; i < 80; i++) {
            try {
                if ((await context.request.get(`${BASE}/admin/session`)).ok()) return;
            } catch {}
            await wait(250);
        }
        throw new Error('server did not start:\n' + logs);
    });

    after(async () => {
        sockets.forEach((s) => s.close());
        if (ARTIFACTS && context && failed) {
            await context.tracing.stop({ path: path.join(ARTIFACTS, 'trace.zip') });
        }
        if (browser) await browser.close();
        if (server) server.kill('SIGTERM');
        await wait(300);
    });

    afterEach(async function () {
        if (this.currentTest.state !== 'failed') return;
        failed = true;
        console.log('--- server logs ---\n' + logs.split('\n').slice(-60).join('\n'));
        if (ARTIFACTS && page && !page.isClosed()) {
            fs.mkdirSync(ARTIFACTS, { recursive: true });
            const name = this.currentTest.title.replace(/[^a-z0-9]+/gi, '-').slice(0, 80);
            await page.screenshot({ path: path.join(ARTIFACTS, `${name}.png`), fullPage: true }).catch(() => {});
        }
    });

    it('logs the organiser in from the login page and shows the home', async () => {
        await page.goto(`${BASE}/login`);
        await page.fill('#username', ADMIN.username);
        await page.fill('#password', ADMIN.password);
        await page.click('#loginButton');
        await page.waitForURL(`${BASE}/`);
        await page.locator('#adminView').waitFor({ state: 'visible' });
    });

    it('renames a room inline: Enter saves, the link stays the same, and it survives a reload', async () => {
        const id = await newRoom('Brouillon');
        await page.reload();
        const menu = await openMenu('Brouillon');
        await menu.getByRole('button', { name: 'Renommer' }).click();

        const field = page.locator('input[aria-label="Nouveau nom de la salle"]');
        await field.fill('Point du lundi');
        await field.press('Enter');
        await toast().filter({ hasText: 'Salle renommée' }).waitFor();
        await row('Point du lundi').waitFor();

        await page.reload();
        await row('Point du lundi').waitFor();
        assert.equal(await row('Brouillon').count(), 0);
        assert.equal((await api('GET', `/api/room/${id}`)).json.name, 'Point du lundi');
    });

    it('gives up a rename with Escape', async () => {
        await newRoom('Garder');
        await page.reload();
        const menu = await openMenu('Garder');
        await menu.getByRole('button', { name: 'Renommer' }).click();
        const field = page.locator('input[aria-label="Nouveau nom de la salle"]');
        await field.fill('Autre nom');
        await field.press('Escape');
        await row('Garder').waitFor();
        assert.equal(await field.count(), 0);
    });

    it('deletes a room after confirmation, and keeps it when the organiser cancels', async () => {
        const id = await newRoom('Jetable');
        await page.reload();

        page.once('dialog', (d) => d.dismiss());
        await (await openMenu('Jetable')).getByRole('button', { name: 'Supprimer la salle' }).click();
        await wait(300);
        assert.equal(await row('Jetable').count(), 1, 'cancelled: the room stays');

        let message = '';
        page.once('dialog', (d) => {
            message = d.message();
            d.accept();
        });
        await (await openMenu('Jetable')).getByRole('button', { name: 'Supprimer la salle' }).click();
        await toast().filter({ hasText: 'Salle supprimée' }).waitFor();
        assert.match(message, /Supprimer la salle « Jetable »/);
        await row('Jetable').waitFor({ state: 'detached' });

        await page.reload();
        await page.locator('#rooms li.tllm-room').first().waitFor();
        assert.equal(await row('Jetable').count(), 0);
        assert.equal(
            (await api('GET', '/api/admin/overview')).json.rooms.some((r) => r.id === id),
            false
        );
    });

    it('offers no delete for a meeting under way, and shows the refusal if it started meanwhile', async () => {
        const id = await newRoom('Visio du jour');
        await page.reload();
        // The menu is open while the meeting starts elsewhere: the server refuses, the page says why
        const menu = await openMenu('Visio du jour');
        const socket = await startMeeting(id);
        page.once('dialog', (d) => d.accept());
        await menu.getByRole('button', { name: 'Supprimer la salle' }).click();
        await toast().filter({ hasText: 'La visio est en cours' }).waitFor();
        assert.equal(await row('Visio du jour').count(), 1);

        await page.reload();
        await page.locator('.tllm-room.is-live', { hasText: 'Visio du jour' }).waitFor();
        const live = await openMenu('Visio du jour');
        await live.getByRole('button', { name: 'Renommer' }).waitFor();
        assert.equal(await live.getByRole('button', { name: 'Supprimer la salle' }).count(), 0);
        socket.close();
    });

    it('offers no delete for a room a date poll booked', async () => {
        const day = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
        const poll = await api('POST', '/api/rdv', {
            title: 'Revue trimestrielle',
            duration: 60,
            slots: [
                { date: day, time: '10:00' },
                { date: day, time: '14:00' },
            ],
        });
        assert.equal(poll.status, 200, JSON.stringify(poll.json));
        assert.equal((await api('POST', `/api/rdv/${poll.json.id}/fix`, { slot: 0 })).status, 200);

        await page.reload();
        await page.locator('.tllm-room.is-coming', { hasText: 'Revue trimestrielle' }).waitFor();
        const menu = await openMenu('Revue trimestrielle');
        await menu.getByRole('button', { name: 'Renommer' }).waitFor();
        assert.equal(await menu.getByRole('button', { name: 'Supprimer la salle' }).count(), 0);
    });

    it('ran without JavaScript errors in the page', () => {
        assert.deepEqual(page.pageErrors.map(String), []);
    });
});
