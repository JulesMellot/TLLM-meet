'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatePolls, zonedToUtc, icsFold } = require('../app/src/DatePolls');

const NOW = Date.UTC(2026, 9, 14, 10, 0); // Wednesday 14 October 2026, 12:00 in Paris
const silent = { error() {}, warn() {} };
let roomCounter = 0;
const makeRoomId = (name) => `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-r${++roomCounter}`;
const store = (extra = {}) => new DatePolls({ now: () => NOW, makeRoomId, log: silent, ...extra });

const input = (extra = {}) => ({
    title: 'Point mensuel',
    description: 'Ordre du jour',
    duration: 60,
    slots: [
        { date: '2026-10-20', time: '10:00' },
        { date: '2026-10-22', time: '18:00' },
        { date: '2026-10-27', time: '14:00' },
    ],
    ...extra,
});

describe('test-DatePolls (caler une réunion)', () => {
    it('reads the times in Paris, summer and winter time', () => {
        assert.equal(
            new Date(zonedToUtc('2026-10-20', '10:00', 'Europe/Paris')).toISOString(),
            '2026-10-20T08:00:00.000Z'
        );
        // Winter time starts on Sunday 25 October 2026
        assert.equal(
            new Date(zonedToUtc('2026-10-27', '14:00', 'Europe/Paris')).toISOString(),
            '2026-10-27T13:00:00.000Z'
        );
        assert.ok(Number.isNaN(zonedToUtc('2026-02-31', '10:00', 'Europe/Paris')));
        assert.ok(Number.isNaN(zonedToUtc('2026-10-20', '25:00', 'Europe/Paris')));
    });

    it('creates a poll for the admin only, with clean slots', () => {
        const s = store();
        assert.throws(() => s.create(null, 'X', input()), /unauthorized/);
        const poll = s.create('jules', 'Jules', input({ slots: [...input().slots].reverse() }));
        assert.match(poll.id, /^[a-z0-9]{10}$/);
        assert.deepEqual(
            poll.slots,
            [...poll.slots].sort((a, b) => a - b),
            'slots are sorted'
        );
        assert.equal(poll.status, 'open');
        assert.equal(poll.allowMaybe, true);
    });

    it('refuses bad polls', () => {
        const s = store();
        const bad = [
            { title: '' },
            { title: 'x'.repeat(121) },
            { duration: 50 },
            { slots: [{ date: '2026-10-20', time: '10:00' }] },
            {
                slots: [
                    { date: '2026-10-20', time: '10:00' },
                    { date: '2026-10-20', time: '10:00' },
                ],
            },
            {
                slots: [
                    { date: '2026-10-01', time: '10:00' },
                    { date: '2026-10-20', time: '10:00' },
                ],
            },
            {
                slots: [
                    { date: 'demain', time: '10:00' },
                    { date: '2026-10-20', time: '10:00' },
                ],
            },
            { expected: 0 },
            { expected: 'beaucoup' },
            { deadline: '2026-10-28' },
        ];
        for (const extra of bad)
            assert.throws(() => s.create('jules', 'Jules', input(extra)), undefined, JSON.stringify(extra));
    });

    it('takes answers from guests, who can change them with their token only', () => {
        const s = store();
        const poll = s.create('jules', 'Jules', input());
        const { participantId, token } = s.answer(poll.id, { name: '  Marie  D. ', answers: ['yes', 'no', 'maybe'] });
        assert.equal(poll.participants[0].name, 'Marie D.');
        assert.equal(poll.participants[0].tokenHash.length, 64, 'only a hash of the token is kept');
        assert.throws(
            () => s.updateAnswer(poll.id, participantId, 'wrong', { name: 'Marie', answers: ['no', 'no', 'no'] }),
            /modifier/
        );
        s.updateAnswer(poll.id, participantId, token, { name: 'Marie', answers: ['no', 'yes', 'yes'] });
        assert.deepEqual(poll.participants[0].answers, ['no', 'yes', 'yes']);
        assert.throws(() => s.answer(poll.id, { name: 'Bob', answers: ['yes', 'no'] }), /Réponses/);
        assert.throws(() => s.answer(poll.id, { name: 'Bob', answers: ['yes', 'no', 'peut-être'] }), /Réponses/);
        assert.throws(() => s.answer(poll.id, { name: '', answers: ['yes', 'no', 'no'] }), /nom/);
    });

    it('refuses "Si besoin" when the poll does not allow it', () => {
        const s = store();
        const poll = s.create('jules', 'Jules', input({ allowMaybe: false }));
        assert.throws(() => s.answer(poll.id, { name: 'Bob', answers: ['maybe', 'no', 'no'] }), /Réponses/);
    });

    it('sets the date on its own when the expected people have answered', () => {
        const s = store();
        const poll = s.create('jules', 'Jules', input({ expected: 3 }));
        s.answer(poll.id, { name: 'A', answers: ['yes', 'yes', 'no'] });
        s.answer(poll.id, { name: 'B', answers: ['no', 'yes', 'maybe'] });
        assert.equal(poll.status, 'open');
        s.answer(poll.id, { name: 'C', answers: ['yes', 'maybe', 'yes'] });
        assert.equal(poll.status, 'fixed');
        assert.equal(poll.fixed.slot, 1, 'most "Oui", then most "Si besoin"');
        assert.equal(poll.fixed.auto, true);
        assert.equal(poll.fixed.end - poll.fixed.start, 60 * 60000);
        assert.match(poll.fixed.room, /^point-mensuel-r\d+$/);
        assert.throws(() => s.answer(poll.id, { name: 'D', answers: ['yes', 'yes', 'yes'] }), /terminé/);
    });

    it('breaks ties with the earliest slot, and never picks a slot nobody can attend', () => {
        const s = store();
        const poll = s.create('jules', 'Jules', input());
        assert.equal(s.best(poll), -1);
        s.answer(poll.id, { name: 'A', answers: ['no', 'yes', 'yes'] });
        assert.equal(s.best(poll), 1);
    });

    it('uses the answers received when the deadline passes, or closes the poll', () => {
        let now = NOW;
        const s = new DatePolls({ now: () => now, makeRoomId, log: silent });
        const withAnswers = s.create('jules', 'Jules', input({ deadline: '2026-10-18' }));
        const empty = s.create('jules', 'Jules', input({ deadline: '2026-10-18' }));
        s.answer(withAnswers.id, { name: 'A', answers: ['no', 'no', 'yes'] });
        s.checkDeadlines();
        assert.equal(withAnswers.status, 'open');
        now = Date.UTC(2026, 9, 19);
        s.checkDeadlines();
        assert.equal(withAnswers.status, 'fixed');
        assert.equal(withAnswers.fixed.slot, 2);
        assert.equal(empty.status, 'closed');
    });

    it('lets only the owner set the date, close or delete, and keeps the room when the date changes', () => {
        const s = store();
        const poll = s.create('jules', 'Jules', input());
        assert.throws(() => s.fix(poll.id, 'other', 0), /unauthorized/);
        s.fix(poll.id, 'jules', 0);
        const room = poll.fixed.room;
        s.fix(poll.id, 'jules', 2);
        assert.equal(poll.fixed.room, room);
        assert.equal(poll.sequence, 2);
        assert.throws(() => s.remove(poll.id, 'other'), /unauthorized/);
        assert.ok(s.remove(poll.id, 'jules'));
        assert.equal(s.get(poll.id), null);
    });

    it('tells the server when a date is set, so the room carries the poll title', () => {
        const fixed = [];
        const s = store({ onFix: (poll) => fixed.push([poll.fixed.room, poll.title]) });
        const poll = s.create('jules', 'Jules', input({ expected: 1 }));
        s.answer(poll.id, { name: 'A', answers: ['no', 'yes', 'no'] });
        assert.deepEqual(fixed, [[poll.fixed.room, 'Point mensuel']]);
    });

    it('never shows answer tokens in the public view', () => {
        const s = store();
        const poll = s.create('jules', 'Jules', input());
        s.answer(poll.id, { name: 'A', answers: ['yes', 'no', 'no'] });
        const view = JSON.stringify(s.view(poll));
        assert.ok(!view.includes('tokenHash'));
        assert.ok(!view.includes('"owner"'));
    });

    it('serves an empty calendar until the date is set, then the meeting with its link', () => {
        const s = store();
        const poll = s.create('jules', 'Jules', input({ title: 'Point, mensuel; "AG"' }));
        let feed = s.feed(poll, 'https://meet.tllm.fr');
        assert.ok(feed.startsWith('BEGIN:VCALENDAR\r\n'));
        assert.ok(feed.endsWith('END:VCALENDAR\r\n'));
        assert.ok(!feed.includes('BEGIN:VEVENT'));
        assert.ok(feed.includes('X-WR-CALNAME:Point\\, mensuel\\; "AG"'));
        s.fix(poll.id, 'jules', 2);
        feed = s.feed(poll, 'https://meet.tllm.fr');
        assert.ok(feed.includes('BEGIN:VEVENT'));
        assert.ok(feed.includes('DTSTART:20261027T130000Z'));
        assert.ok(feed.includes('DTEND:20261027T140000Z'));
        assert.ok(feed.includes(`UID:rdv-${poll.id}@meet.tllm.fr`));
        assert.ok(feed.replace(/\r\n /g, '').includes(`URL:https://meet.tllm.fr/join/${poll.fixed.room}`));
        assert.ok(feed.split('\r\n').every((line) => Buffer.byteLength(line) <= 75));
    });

    it('folds long calendar lines without cutting a character', () => {
        const line = 'DESCRIPTION:' + 'é'.repeat(100);
        const folded = icsFold(line);
        assert.ok(folded.split('\r\n').every((l) => Buffer.byteLength(l) <= 75));
        assert.equal(folded.replace(/\r\n /g, ''), line);
    });

    it('keeps the polls in a file and reads them back', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tllm-rdv-'));
        const file = path.join(dir, 'sub', 'rendez-vous.json');
        const s = store({ file });
        const poll = s.create('jules', 'Jules', input());
        s.answer(poll.id, { name: 'A', answers: ['yes', 'no', 'no'] });
        s.saveNow();
        const again = store({ file });
        assert.equal(again.get(poll.id).participants[0].name, 'A');
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
