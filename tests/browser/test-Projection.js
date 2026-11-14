'use strict';

/**
 * TLLM*meet - browser test: presentation mode. The organiser opens the projector window from the
 * "Plus" menu: it shows the people at a distance (not the organiser), then the whiteboard and the
 * notes big with those people beside, and closes from the top strip of the meeting.
 * From a phone in the room (the QR code of the projector), someone votes, reacts and asks a question.
 * Run: npm run test:browser (needs "npx playwright install chromium" once).
 */

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 3800 + Math.floor(Math.random() * 500);
const BASE = `https://localhost:${PORT}`;
const ARTIFACTS = process.env.BROWSER_ARTIFACTS || '';
const ADMIN = { username: 'jules', password: 'S3cret-Pass', displayname: 'Jules' };

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('Presentation mode: a window for the projector (browser)', function () {
    this.timeout(120000);

    let server;
    let logs = '';
    let browser;
    let organiser;
    let guest;
    let page;
    let projector;
    let phone;
    let other;
    let roomId;
    let failed = false;
    const pageErrors = [];

    const newContext = () =>
        browser.newContext({
            ignoreHTTPSErrors: true,
            locale: 'fr-FR',
            timezoneId: 'Europe/Paris',
            viewport: { width: 1280, height: 800 },
            permissions: ['camera', 'microphone'],
        });
    const state = () =>
        projector.evaluate(() => ({
            layout: ['is-wait', 'is-grid', 'is-stage'].find((c) => document.body.classList.contains(c)),
            label: document.getElementById('mainLabel').textContent,
            people: [...document.querySelectorAll('.tile')].map((t) => t.querySelector('b').textContent),
        }));
    const until = async (check, what) => {
        for (let i = 0; i < 60; i++) {
            if (await check()) return;
            await wait(250);
        }
        assert.fail(`timed out: ${what} (${JSON.stringify(await state())})`);
    };

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
                DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tllm-browser-data-')),
            },
        });
        server.stdout.on('data', (d) => (logs += d));
        server.stderr.on('data', (d) => (logs += d));

        browser = await chromium.launch({
            args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
        });
        organiser = await newContext();
        guest = await newContext();
        if (ARTIFACTS) await organiser.tracing.start({ screenshots: true, snapshots: true });
        page = await organiser.newPage();
        page.on('pageerror', (err) => pageErrors.push(err));

        for (let i = 0; i < 80; i++) {
            try {
                if ((await organiser.request.get(`${BASE}/admin/session`)).ok()) return;
            } catch {}
            await wait(250);
        }
        throw new Error('server did not start:\n' + logs);
    });

    after(async () => {
        if (ARTIFACTS && organiser && failed) {
            await organiser.tracing.stop({ path: path.join(ARTIFACTS, 'trace-projection.zip') });
        }
        if (browser) await browser.close();
        if (server) server.kill('SIGTERM');
        await wait(300);
    });

    afterEach(async function () {
        if (this.currentTest.state !== 'failed') return;
        failed = true;
        console.log('--- server logs ---\n' + logs.split('\n').slice(-60).join('\n'));
        if (ARTIFACTS) {
            fs.mkdirSync(ARTIFACTS, { recursive: true });
            const name = this.currentTest.title.replace(/[^a-z0-9]+/gi, '-').slice(0, 80);
            for (const [who, p] of [
                ['meeting', page],
                ['projector', projector],
            ])
                if (p && !p.isClosed())
                    await p.screenshot({ path: path.join(ARTIFACTS, `${name}-${who}.png`) }).catch(() => {});
        }
    });

    it('opens the projector window from the menu: the people at a distance, not the organiser', async () => {
        await page.goto(`${BASE}/login`);
        await page.fill('#username', ADMIN.username);
        await page.fill('#password', ADMIN.password);
        await page.click('#loginButton');
        await page.waitForURL(`${BASE}/`);
        const res = await organiser.request.fetch(`${BASE}/admin/rooms`, { method: 'POST', data: { name: 'Projet' } });
        const room = (await res.json()).room;
        roomId = room.id || room;

        await page.goto(`${BASE}/join/?room=${roomId}&name=Jules&audio=0&video=1&notify=0`);
        await page.waitForFunction(() => window.tllmRoom?.started, null, { timeout: 30000 });
        other = await guest.newPage();
        await other.goto(`${BASE}/join/?room=${roomId}&name=Camille&audio=0&video=1&notify=0`);
        await other.waitForFunction(() => window.tllmRoom?.started, null, { timeout: 30000 });

        await page.click('#tllmMore');
        const opened = page.waitForEvent('popup');
        await page.getByRole('menuitem', { name: /Mode présentation/ }).click();
        projector = await opened;
        await until(async () => (await state()).people.join() === 'Camille', 'Camille in the grid');
        assert.equal((await state()).layout, 'is-grid');
        // Camille's picture really plays there, and is wanted whole from the server
        await projector.waitForFunction(() => document.querySelector('.tile video').videoWidth > 0);
        await page.locator('#tllmProjecting').waitFor();
    });

    it('shows the whiteboard, then the notes, big, with Camille beside', async () => {
        await page.evaluate(() => window.tllmBoard.toggle(true));
        await until(async () => (await state()).label === 'Tableau blanc', 'the whiteboard');
        assert.deepEqual((await state()).people, ['Camille']);
        await projector.waitForFunction(() => document.getElementById('mainVideo').videoWidth > 0);

        await page.evaluate(() => rc.toggleEditor());
        await page.evaluate(() => {
            const quill = window.tllmEditor.quill;
            quill.enable(true);
            quill.setText('Ordre du jour\n');
        });
        await until(async () => (await state()).label === 'Notes partagées', 'the notes');
        assert.match(await projector.locator('#notes').innerText(), /Ordre du jour/);

        await page.evaluate(() => rc.toggleEditor());
        await until(async () => (await state()).layout === 'is-grid', 'back to the grid');
    });

    it('lets a phone of the room in with the QR code link only', async () => {
        await projector.locator('#footPhone img.qr').waitFor();
        assert.match(await projector.locator('#footPhone img.qr').getAttribute('src'), /^data:image\/png/);
        const { key } = await page.evaluate(() => new Promise((r) => rc.socket.emit('audienceKey', null, r)));

        const phoneContext = await browser.newContext({
            ignoreHTTPSErrors: true,
            locale: 'fr-FR',
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
        });
        phone = await phoneContext.newPage();
        phone.on('pageerror', (err) => pageErrors.push(err));

        await phone.goto(`${BASE}/salle/${roomId}#wrong-key`);
        await phone.fill('#enterName', 'Léa');
        await phone.click('#enterButton');
        await phone.locator('#enterError', { hasText: 'QR code' }).waitFor();

        await phone.goto(`${BASE}/salle/${roomId}#${key}`);
        await phone.reload(); // a fragment change alone does not load the page again
        await phone.fill('#enterName', 'Léa');
        await phone.click('#enterButton');
        await phone.locator('#inside').waitFor();
        await phone.locator('#polls', { hasText: 'Aucun sondage' }).waitFor();
        await page.waitForFunction(() => window.tllmRoom.audienceCount === 1);
        await projector.locator('#footCount', { hasText: '1 connecté' }).waitFor();
    });

    it('shows a poll on the projector, and the phone votes in it', async () => {
        await page.evaluate(() =>
            rc.socket.emit('createPoll', { question: 'On décale la réunion ?', options: ['Oui', 'Non'] })
        );
        await until(async () => !(await projector.locator('#poll').isHidden()), 'the poll on the projector');
        assert.equal(await projector.locator('#pollQuestion').innerText(), 'On décale la réunion ?');
        assert.deepEqual((await state()).people, ['Camille']);
        await projector.locator('.poll-qr img.qr').waitFor();

        await phone.getByRole('button', { name: /Oui/ }).click();
        await projector.locator('#pollTotal', { hasText: '1 vote' }).waitFor();
        assert.equal(await projector.locator('#pollRows .row .val').first().innerText(), '100 %');
        const voters = await page.evaluate(() => window.tllmRoom.polls[0].voters.map((v) => v.name));
        assert.deepEqual(voters, ['Léa (salle)']);

        // Tapped again: the vote is withdrawn
        await phone.getByRole('button', { name: /Oui/ }).click();
        await projector.locator('#pollTotal', { hasText: '0 vote' }).waitFor();
        await phone.getByRole('button', { name: /Non/ }).click();
        await projector.locator('#pollTotal', { hasText: '1 vote' }).waitFor();

        const pollId = await page.evaluate(() => window.tllmRoom.polls[0].id);
        await page.evaluate((id) => rc.socket.emit('closePoll', { pollId: id }), pollId);
        await projector.locator('#pollState', { hasText: 'Sondage terminé' }).waitFor();
        await phone.locator('.tllm-salle-poll.is-closed').waitFor();
    });

    it('sends reactions to the projector and questions to the meeting', async () => {
        await phone.getByRole('button', { name: 'Réagir 👏' }).click();
        await projector.locator('#reactions .float', { hasText: 'Léa (salle)' }).waitFor();

        await phone.fill('#askText', 'Et le budget 2027 ?');
        await phone.click('#askButton');
        await phone.locator('#toast', { hasText: 'Question envoyée' }).waitFor();
        await page.waitForFunction(() =>
            window.tllmRoom.chat.some((m) => m.question && m.fromName === 'Léa' && m.html.includes('budget 2027'))
        );
        // Too soon for another one
        await phone.fill('#askText', 'Encore une');
        await phone.click('#askButton');
        await phone.locator('#askError', { hasText: 'Attendez' }).waitFor();
    });

    it('stops from the top strip of the meeting', async () => {
        await page.click('#tllmProjecting');
        await until(async () => projector.isClosed(), 'the window closed');
        assert.equal(await page.locator('#tllmProjecting').count(), 0);
        assert.deepEqual(pageErrors.map(String), []);
    });

    it('tells the phones when the meeting ends', async () => {
        for (const p of [page, other]) await p.evaluate(() => rc.socket.emit('exitRoom', null, () => {}));
        await phone.locator('#ended').waitFor();
    });
});
