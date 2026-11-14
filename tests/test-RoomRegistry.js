'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RoomRegistry, nameFromId } = require('../app/src/RoomRegistry');

describe('test-RoomRegistry (salles de l’organisateur)', () => {
    it('turns a room id into a readable name when the typed name is unknown', () => {
        assert.equal(nameFromId('point-mensuel-k7m2xq'), 'Point mensuel');
        assert.equal(nameFromId('essai'), 'Essai');
        assert.equal(nameFromId(''), 'Visio');
    });

    it('keeps the typed name, the owner and when the room was used', () => {
        let now = 1000;
        const r = new RoomRegistry({ now: () => now });
        r.remember('point-k7m2xq', { name: "Point d'équipe", owner: 'jules' });
        assert.equal(r.name('point-k7m2xq'), "Point d'équipe");
        now = 2000;
        r.opened('point-k7m2xq');
        assert.equal(r.since('point-k7m2xq'), 2000);
        now = 3000;
        r.closed('point-k7m2xq');
        assert.equal(r.since('point-k7m2xq'), null);
        assert.equal(r.get('point-k7m2xq').lastClosedAt, 3000);
    });

    it('keeps the agenda prepared for a room, cleaned, and saves it with the room', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tllm-rooms-'));
        const file = path.join(dir, 'salles.json');
        const r = new RoomRegistry({ file });
        assert.equal(r.setAgenda('inconnue', [{ title: 'A' }]), null);
        r.remember('point-k7m2xq', { name: 'Point', owner: 'jules' });
        assert.deepEqual(r.setAgenda('point-k7m2xq', [{ title: ' Budget ', minutes: '15' }, { title: '' }]), [
            { title: 'Budget', minutes: 15 },
        ]);
        assert.equal(r.setAgenda('point-k7m2xq', 'nope'), null);
        r.saveNow();
        const again = new RoomRegistry({ file });
        assert.deepEqual(again.agenda('point-k7m2xq'), [{ title: 'Budget', minutes: 15 }]);
        again.setAgenda('point-k7m2xq', []);
        assert.deepEqual(again.agenda('point-k7m2xq'), []);
        assert.equal('agenda' in again.get('point-k7m2xq'), false);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('lists the most recently used rooms of an owner first', () => {
        let now = 0;
        const r = new RoomRegistry({ now: () => ++now });
        r.remember('a', { name: 'A', owner: 'jules' });
        r.remember('b', { name: 'B', owner: 'jules' });
        r.remember('c', { name: 'C', owner: 'alice' });
        r.opened('a');
        assert.deepEqual(
            r.recent('jules').map((x) => x.id),
            ['a', 'b']
        );
        for (let i = 0; i < 20; i++) r.remember(`d${i}`, { owner: 'jules' });
        assert.equal(r.recent('jules').length, 12);
        assert.equal(r.recent('jules', 0).length, 22); // 0: all of them, for the home
        assert.equal(r.recent(null, 0).length, 23);
    });

    it('renames a room without changing its link, and forgets a deleted one', () => {
        const r = new RoomRegistry();
        r.remember('point-k7m2xq', { name: 'Point', owner: 'jules' });
        assert.equal(r.rename('point-k7m2xq', '  Point du lundi  ').name, 'Point du lundi');
        assert.equal(r.rename('point-k7m2xq', '   '), null);
        assert.equal(r.rename('inconnue', 'X'), null);
        assert.equal(r.name('point-k7m2xq'), 'Point du lundi');
        assert.equal(r.forget('point-k7m2xq'), true);
        assert.equal(r.get('point-k7m2xq'), null);
        assert.equal(r.forget('point-k7m2xq'), false);
        assert.deepEqual(r.recent('jules'), []);
    });

    it('keeps the rooms in a file', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tllm-rooms-'));
        const file = path.join(dir, 'salles.json');
        const r = new RoomRegistry({ file });
        r.remember('x-k7m2xq', { name: 'Bureau', owner: 'jules' });
        r.saveNow();
        assert.equal(new RoomRegistry({ file }).name('x-k7m2xq'), 'Bureau');
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
