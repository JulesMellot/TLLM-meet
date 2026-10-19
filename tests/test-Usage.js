'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Usage } = require('../app/src/Usage');

const T0 = Date.UTC(2026, 9, 19, 12, 0, 0);

describe('test-Usage (coût des visios)', () => {
    let dir;
    let now;
    let u;
    const names = { 'point-k7m2xq': { name: 'Point hebdo', owner: 'jules' }, 'atelier-a2b3c4': { name: 'Atelier' } };

    const make = (opts = {}) =>
        new Usage({
            file: path.join(dir, 'usage.jsonl'),
            now: () => now,
            log: { error() {}, debug() {} },
            hostCpus: 4,
            describe: (id) => names[id] || {},
            ...opts,
        });

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tllm-usage-'));
        now = T0;
        u = make();
    });

    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('adds up the traffic of a meeting from its transports, also those that come and go', () => {
        u.open('point-k7m2xq');
        u.account({ at: now, rooms: [{ id: 'point-k7m2xq', peers: 1, transports: [{ id: 'a', in: 100, out: 50 }] }] });
        now += 5000;
        u.account({
            at: now,
            rooms: [
                {
                    id: 'point-k7m2xq',
                    peers: 2,
                    transports: [
                        { id: 'a', in: 300, out: 150 },
                        { id: 'b', in: 1000, out: 0 },
                    ],
                },
            ],
        });
        now += 5000;
        // "a" closed: its counters are gone, nothing is subtracted
        u.account({ at: now, rooms: [{ id: 'point-k7m2xq', peers: 1, transports: [{ id: 'b', in: 1500, out: 20 }] }] });
        const [m] = u.list();
        assert.equal(m.bytesIn, 1500 + 300 - 100 + 100);
        assert.equal(m.bytesOut, 170);
        assert.equal(m.peakPeers, 2);
        assert.equal(m.peerMs, 2 * 5000 + 1 * 5000);
        assert.equal(m.live, true);
        assert.equal(m.name, 'Point hebdo');
    });

    it('shares a worker’s CPU between its rooms by traffic, and Node’s by number of people', () => {
        const rooms = (a, b) => [
            { id: 'point-k7m2xq', peers: 3, worker: 1, transports: [{ id: 'a', in: a, out: 0 }] },
            { id: 'atelier-a2b3c4', peers: 1, worker: 1, transports: [{ id: 'b', in: b, out: 0 }] },
        ];
        u.account({ at: now, rooms: rooms(0, 0), workers: [{ pid: 1, cpuMs: 1000 }], nodeCpuMs: 500 });
        now += 5000;
        const used = u.account({ at: now, rooms: rooms(300, 100), workers: [{ pid: 1, cpuMs: 1400 }], nodeCpuMs: 540 });
        assert.equal(used.appCpuMs, 440);
        const byRoom = Object.fromEntries(u.list().map((m) => [m.room, m.cpuMs]));
        assert.equal(byRoom['point-k7m2xq'], 300 + 30); // 3/4 of the worker, 3/4 of Node
        assert.equal(byRoom['atelier-a2b3c4'], 100 + 10);
    });

    it('a worker’s CPU goes by number of people when nothing flowed', () => {
        const rooms = [
            { id: 'point-k7m2xq', peers: 1, worker: 7, transports: [] },
            { id: 'atelier-a2b3c4', peers: 3, worker: 8, transports: [] },
        ];
        u.account({
            at: now,
            rooms,
            workers: [
                { pid: 7, cpuMs: 0 },
                { pid: 8, cpuMs: 0 },
            ],
        });
        now += 5000;
        u.account({
            at: now,
            rooms,
            workers: [
                { pid: 7, cpuMs: 80 },
                { pid: 8, cpuMs: 40 },
            ],
        });
        const byRoom = Object.fromEntries(u.list().map((m) => [m.room, m.cpuMs]));
        assert.deepEqual(byRoom, { 'point-k7m2xq': 80, 'atelier-a2b3c4': 40 }); // each room its own worker
    });

    it('keeps a finished meeting in the file, with its CPU (average, peak) and transcription', () => {
        u.open('point-k7m2xq');
        u.account({ at: now, rooms: [], workers: [{ pid: 1, cpuMs: 0 }] });
        now += 30000;
        const room = { id: 'point-k7m2xq', peers: 2, worker: 1, transports: [] };
        u.account({ at: now, rooms: [room], workers: [{ pid: 1, cpuMs: 1200 }] });
        now += 30000;
        u.account({ at: now, rooms: [room], workers: [{ pid: 1, cpuMs: 6000 }] });
        u.asr('point-k7m2xq', { ms: 1200, audioMs: 4000 });
        u.asr('point-k7m2xq', { ms: NaN, audioMs: NaN }); // another speech-to-text server
        const record = u.close('point-k7m2xq');
        assert.equal(record.durationMs, 60000);
        assert.equal(record.asrRequests, 2);
        assert.equal(record.asrMs, 1200);
        assert.equal(record.asrAudioMs, 4000);
        assert.equal(record.cpuShare, 6000 / (60000 * 4));
        assert.equal(record.cpuPeak, 4800 / (30000 * 4));
        assert.equal(u.close('point-k7m2xq'), null);

        // Read back after a restart
        const again = make();
        const [m] = again.list();
        assert.equal(m.room, 'point-k7m2xq');
        assert.equal(m.name, 'Point hebdo');
        assert.equal(m.owner, 'jules');
        assert.equal(m.live, false);
        assert.equal(m.cpuPeak, record.cpuPeak);
        assert.equal(m.transports, undefined);
    });

    it('gives a meeting the memory the app uses above its memory with no meeting, by people', () => {
        const MB = 1048576;
        const rooms = [
            { id: 'point-k7m2xq', peers: 3, transports: [] },
            { id: 'atelier-a2b3c4', peers: 1, transports: [] },
        ];
        u.account({ at: now, rooms: [], appMemory: 200 * MB }); // nobody: the baseline
        now += 5000;
        u.account({ at: now, rooms, appMemory: 240 * MB });
        now += 5000;
        u.account({ at: now, rooms, appMemory: 280 * MB });
        const byRoom = Object.fromEntries(u.list().map((m) => [m.room, m]));
        assert.equal(byRoom['point-k7m2xq'].memPeak, 60 * MB);
        assert.equal(byRoom['point-k7m2xq'].memAvg, 45 * MB);
        assert.equal(byRoom['atelier-a2b3c4'].memPeak, 20 * MB);
        assert.equal(byRoom['atelier-a2b3c4'].memByteMs, undefined);
    });

    it('lists the meetings under way, then those of the period, and filters by organiser', () => {
        u.open('atelier-a2b3c4');
        u.close('atelier-a2b3c4');
        now += 10 * 86400000;
        u.open('point-k7m2xq');
        u.close('point-k7m2xq');
        u.open('atelier-a2b3c4');
        assert.deepEqual(
            u.list().map((m) => [m.room, m.live]),
            [
                ['atelier-a2b3c4', true],
                ['point-k7m2xq', false],
                ['atelier-a2b3c4', false],
            ]
        );
        assert.equal(u.list({ since: now - 7 * 86400000 }).length, 2);
        assert.deepEqual(
            u.list({ owner: 'jules' }).map((m) => m.room),
            ['point-k7m2xq']
        );
    });

    it('counts the people of a meeting shorter than one sample', () => {
        u.joined('point-k7m2xq', 1);
        u.joined('point-k7m2xq', 2);
        now += 2000;
        assert.equal(u.close('point-k7m2xq').peakPeers, 2);
    });

    it('survives a line cut by a crash', () => {
        fs.writeFileSync(path.join(dir, 'usage.jsonl'), '{"room":"a","startedAt":1}\n{"room":"b","sta');
        assert.equal(make().list().length, 1);
    });

    it('measures the app and the whole server from the real objects', async () => {
        const transport = { id: 't1', getStats: async () => [{ bytesReceived: 4000, bytesSent: 2000 }] };
        const peer = { producers: new Map([[1, {}]]), consumers: new Map(), transports: new Map([['t1', transport]]) };
        const room = { id: 'point-k7m2xq', worker: { pid: process.pid }, peers: new Map([['s1', peer]]) };
        const worker = { pid: process.pid, getResourceUsage: async () => ({ ru_utime: 10, ru_stime: 5 }) };
        const roomList = new Map([[room.id, room]]);
        await u.collect(roomList, [worker]);
        now += 5000;
        const live = await u.collect(roomList, [worker]);
        assert.equal(live.app.rooms, 1);
        assert.equal(live.app.peers, 1);
        assert.equal(live.app.transports, 1);
        assert.equal(live.app.producers, 1);
        assert.equal(live.app.bitrateIn, 0); // the bytes were counted at the first sample
        assert.ok(live.app.memory.node > 0);
        assert.ok(live.server.memory.total > 0);
        assert.equal(u.snapshot().history.length, 1);
        assert.equal(u.list()[0].bytesIn, 4000);
    });
});
