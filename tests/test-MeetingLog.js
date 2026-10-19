'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MeetingLog } = require('../app/src/MeetingLog');

const T0 = Date.UTC(2026, 9, 19, 12, 0, 0); // 14:00 in Paris

describe('test-MeetingLog (journal des réunions)', () => {
    let dir;
    let now;
    let j;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tllm-journal-'));
        now = T0;
        j = new MeetingLog({ dir, now: () => now, log: { error() {} } });
    });

    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('keeps the events of a meeting, with their level and the person concerned', () => {
        j.start('point-k7m2xq', T0);
        j.add('point-k7m2xq', 'info', 'arrivée (Firefox 131, Windows, ordinateur)', { who: 'Marie' });
        now += 61000;
        j.add('point-k7m2xq', 'warn', 'réseau coupé', { who: 'Marie' });
        j.add('point-k7m2xq', 'error', 'Transport not found', { tech: true, detail: 'id 42' });
        j.add('point-k7m2xq', 'bizarre', 'niveau inconnu');
        assert.deepEqual(j.counts('point-k7m2xq'), { lines: 4, warnings: 1, errors: 1, dropped: 0 });
        const entries = j.read('point-k7m2xq', T0);
        assert.equal(entries.length, 4);
        assert.deepEqual(entries[1], { t: T0 + 61000, level: 'warn', text: 'réseau coupé', who: 'Marie' });
        assert.equal(entries[2].tech, true);
        assert.equal(entries[3].level, 'info');

        const text = j.toText(entries, { name: 'Point hebdo' });
        assert.match(text, /^Journal de la visio « Point hebdo »/);
        assert.match(text, /14:01:01 {2}ALERTE Marie : réseau coupé/);
        assert.match(text, /ERREUR \[technique\] Transport not found \(id 42\)/);
    });

    it('writes nothing for a room without a meeting, and hands the counts over at the end', () => {
        assert.equal(j.add('point-k7m2xq', 'info', 'rien'), false);
        j.start('point-k7m2xq', T0);
        j.add('point-k7m2xq', 'error', 'aïe');
        assert.deepEqual(j.end('point-k7m2xq'), { lines: 1, warnings: 0, errors: 1, dropped: 0 });
        assert.equal(j.counts('point-k7m2xq'), null);
        assert.equal(j.add('point-k7m2xq', 'info', 'trop tard'), false);
        assert.equal(j.read('point-k7m2xq', T0).length, 1);
    });

    it('tells every meeting under way about a server problem', () => {
        j.start('point-k7m2xq', T0);
        j.start('atelier-a2b3c4_breakout_1', T0 + 1);
        j.addAll('error', 'le moteur audio et vidéo s’est arrêté');
        assert.equal(j.counts('point-k7m2xq').errors, 1);
        assert.equal(j.counts('atelier-a2b3c4_breakout_1').errors, 1);
    });

    it('stops writing after 3000 lines and says how many were left out', () => {
        j.start('point-k7m2xq', T0);
        for (let i = 0; i < 3005; i++) j.add('point-k7m2xq', 'warn', `boucle ${i}`);
        const counts = j.end('point-k7m2xq');
        assert.equal(counts.lines, 3000);
        assert.equal(counts.dropped, 5);
        assert.equal(counts.warnings, 3005);
        const entries = j.read('point-k7m2xq', T0);
        assert.equal(entries.length, 3001);
        assert.equal(entries[3000].text, '5 événements de plus non gardés');
    });

    it('refuses to read outside its folder, and forgets old logs', () => {
        assert.equal(j.read('../etc', T0), null);
        assert.equal(j.read('point-k7m2xq', 'abc'), null);
        assert.deepEqual(j.read('point-k7m2xq', T0), []); // nothing yet
        j.start('vieille-a2b3c4', T0 - 40 * 86400000);
        j.add('vieille-a2b3c4', 'info', 'ancienne');
        j.start('point-k7m2xq', T0);
        j.add('point-k7m2xq', 'info', 'récente');
        assert.equal(j.purge(), 1);
        assert.equal(j.read('point-k7m2xq', T0).length, 1);
    });
});
