'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Transcripts, timecode, isRoomId } = require('../app/src/Transcripts');

const START = Date.UTC(2026, 9, 18, 12, 2, 0); // 14:02 in Paris

describe('test-Transcripts (transcription des réunions)', () => {
    let dir;
    let now;
    let t;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tllm-transcripts-'));
        now = START;
        t = new Transcripts({ dir, now: () => now, log: { error() {} } });
    });

    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('formats timecodes as hh:mm:ss', () => {
        assert.equal(timecode(0), '00:00:00');
        assert.equal(timecode(754000), '00:12:34');
        assert.equal(timecode(3 * 3600000 + 5000), '03:00:05');
        assert.equal(timecode(-10), '00:00:00');
    });

    it('accepts only plain room ids (no breakout rooms, no paths)', () => {
        assert.ok(isRoomId('point-hebdo-k7m2xq'));
        assert.ok(!isRoomId('point_breakout_1'));
        assert.ok(!isRoomId('../etc'));
        assert.ok(!isRoomId('a--b'));
        assert.ok(!isRoomId(''));
    });

    it('keeps sentences only while the transcription is on', () => {
        assert.equal(t.begin('salle-k7m2xq'), null);
        t.start('salle-k7m2xq', { name: 'Point hebdo', by: 'Jules' });
        assert.ok(t.isActive('salle-k7m2xq'));
        const s = t.begin('salle-k7m2xq');
        assert.ok(t.add(s, { name: 'Marie', text: 'Bonjour à tous.', at: START + 4000 }));
        t.stop('salle-k7m2xq');
        now += 5000;
        assert.ok(t.add(t.begin('salle-k7m2xq'), { name: 'Jules', text: 'Dite juste avant.', at: START + 6000 }));
        now += 60000;
        assert.equal(t.begin('salle-k7m2xq'), null);
        const [session] = t.list('salle-k7m2xq');
        assert.equal(session.lines, 2);
        assert.deepEqual(session.speakers, ['Marie', 'Jules']);
    });

    it('is not ready while a sentence is still being recognised', () => {
        t.start('salle-k7m2xq');
        const s = t.begin('salle-k7m2xq');
        now += 60000;
        t.close('salle-k7m2xq');
        assert.equal(t.list('salle-k7m2xq')[0].status, 'finishing');
        t.add(s, { name: 'Marie', text: 'Dernière phrase.', at: START + 59000 });
        assert.equal(t.list('salle-k7m2xq')[0].status, 'ready');
        assert.equal(t.list('salle-k7m2xq')[0].lines, 1);
    });

    it('reads a file again only when it changed, and latest reads only the newest', () => {
        t.start('salle-k7m2xq');
        t.add(t.begin('salle-k7m2xq'), { name: 'Marie', text: 'Une.', at: START + 1000 });
        t.close('salle-k7m2xq');
        now += 3600000;
        t.start('salle-k7m2xq');
        t.add(t.begin('salle-k7m2xq'), { name: 'Jules', text: 'Deux.', at: now + 1000 });

        let reads = 0;
        const read = t.read.bind(t);
        t.read = (...args) => (reads++, read(...args));
        assert.equal(t.list('salle-k7m2xq').length, 2);
        assert.equal(reads, 2);
        assert.equal(t.list('salle-k7m2xq').length, 2);
        assert.equal(reads, 2); // nothing changed: nothing read

        t.add(t.begin('salle-k7m2xq'), { name: 'Jules', text: 'Trois.', at: now + 2000 });
        const latest = t.latest('salle-k7m2xq');
        assert.equal(reads, 3); // only the newest file, which changed
        assert.equal(latest.id, String(now));
        assert.equal(latest.lines, 2);
        assert.equal(latest.status, 'active');
    });

    it('writes again when the folder was removed while running', () => {
        t.start('salle-k7m2xq');
        fs.rmSync(dir, { recursive: true, force: true });
        t.close('salle-k7m2xq');
        assert.ok(fs.readdirSync(dir).length === 1);
    });

    it('a failed recognition does not keep the file waiting', () => {
        t.start('salle-k7m2xq');
        const s = t.begin('salle-k7m2xq');
        t.close('salle-k7m2xq');
        t.abandon(s);
        assert.equal(t.list('salle-k7m2xq')[0].status, 'ready');
    });

    it('writes one text file with timecode and speaker, in the order things were said', () => {
        t.start('salle-k7m2xq', { name: 'Point hebdo' });
        const a = t.begin('salle-k7m2xq');
        const b = t.begin('salle-k7m2xq');
        // Recognised out of order: Jules spoke first
        t.add(b, { name: 'Marie', text: '  Oui,   ça me va. ', at: START + 75000 });
        t.add(a, { name: 'Jules', text: 'On commence ?', at: START + 12000 });
        now = START + 10 * 60000;
        t.stop('salle-k7m2xq');
        now = START + 12 * 60000;
        t.start('salle-k7m2xq');
        t.add(t.begin('salle-k7m2xq'), { name: 'Jules', text: 'On reprend.', at: START + 12 * 60000 + 3000 });
        now = START + 45 * 60000;
        t.close('salle-k7m2xq');

        const [session] = t.list('salle-k7m2xq');
        const text = t.toText(t.read('salle-k7m2xq', session.id));
        const lines = text.split('\n');
        assert.equal(lines[0], 'Point hebdo');
        assert.match(lines[1], /^Transcription du dimanche 18 octobre 2026, de 14:02 à 14:47$/);
        assert.equal(lines[2], 'Participants : Jules, Marie');
        const body = lines.filter((l) => l.startsWith('['));
        assert.deepEqual(body, [
            '[00:00:12] Jules : On commence ?',
            '[00:01:15] Marie : Oui, ça me va.',
            '[00:10:00] — Transcription en pause à 14:12 —',
            '[00:12:00] — Transcription reprise à 14:14 —',
            '[00:12:03] Jules : On reprend.',
        ]);
    });

    it('starts a new file for the next meeting in the same room', () => {
        t.start('salle-k7m2xq');
        t.close('salle-k7m2xq');
        now += 3600000;
        t.start('salle-k7m2xq');
        assert.equal(t.list('salle-k7m2xq').length, 2);
        assert.equal(t.list('salle-k7m2xq')[0].status, 'active');
        assert.equal(t.list('salle-k7m2xq')[1].status, 'ready');
    });

    it('does not mix up two rooms whose names share a prefix', () => {
        t.start('point');
        t.start('point-hebdo');
        assert.equal(t.list('point').length, 1);
        assert.equal(t.list('point-hebdo').length, 1);
    });

    it('refuses to read or delete outside its folder', () => {
        assert.equal(t.read('../x', '1760000000000'), null);
        assert.equal(t.read('salle-k7m2xq', '../../etc/passwd'), null);
        assert.equal(t.remove('salle-k7m2xq', '../x'), false);
    });

    it('deletes a finished transcription, not one being written', () => {
        t.start('salle-k7m2xq');
        const id = t.list('salle-k7m2xq')[0].id;
        assert.equal(t.remove('salle-k7m2xq', id), false);
        t.close('salle-k7m2xq');
        t.live.clear(); // past the delay for late sentences
        assert.equal(t.remove('salle-k7m2xq', id), true);
        assert.equal(t.list('salle-k7m2xq').length, 0);
    });

    it('forgets files older than the retention period', () => {
        const r = new Transcripts({ dir, now: () => now, retentionDays: 30, log: { error() {} } });
        r.start('vieille-salle');
        r.close('vieille-salle');
        now += 31 * 86400000;
        r.start('salle-recente');
        assert.equal(r.purge(), 1);
        assert.equal(r.list('vieille-salle').length, 0);
        assert.equal(r.list('salle-recente').length, 1);
    });

    it('survives a line cut by a crash', () => {
        t.start('salle-k7m2xq');
        t.add(t.begin('salle-k7m2xq'), { name: 'Marie', text: 'Avant la panne.', at: START + 1000 });
        const id = t.list('salle-k7m2xq')[0].id;
        fs.appendFileSync(path.join(dir, `salle-k7m2xq--${id}.jsonl`), '{"t":12,"who":"Ma');
        assert.equal(t.read('salle-k7m2xq', id).lines.length, 1);
    });
});
