'use strict';

require('should');

const { arrange, fitGrid } = require('../public/js/TllmProjection');

describe('test-Projection', () => {
    const cam = (peerId, extra = {}) => ({ key: `${peerId}-cam`, peerId, screen: false, ...extra });
    const screen = (peerId, since) => ({ key: `${peerId}-screen`, peerId, screen: true, since });

    it('leaves out one’s own camera: the room already sees the person', () => {
        const { main, people } = arrange({ tiles: [cam('me'), cam('ana'), cam('bob')], me: 'me' });
        (main === null).should.be.true();
        people.map((t) => t.peerId).should.eql(['ana', 'bob']);
    });

    it('shows the latest screen shared big, one’s own included', () => {
        const tiles = [cam('ana'), screen('bob', 10), screen('me', 20)];
        const { main, people } = arrange({ tiles, me: 'me' });
        main.kind.should.equal('screen');
        main.tile.peerId.should.equal('me');
        people.map((t) => t.peerId).should.eql(['ana']);
    });

    it('puts the whiteboard or the notes before a screen', () => {
        const { main } = arrange({ tiles: [screen('bob', 1)], content: 'board', me: 'me' });
        main.should.eql({ kind: 'board' });
    });

    it('keeps the last ones who spoke beside what is presented, in the order of the meeting', () => {
        const tiles = [screen('me', 1), cam('a'), cam('b'), cam('c'), cam('d'), cam('e')];
        const spoke = new Map([
            ['e', 50],
            ['b', 40],
        ]);
        const { people } = arrange({ tiles, me: 'me', spoke, sideMax: 3 });
        people.map((t) => t.peerId).should.eql(['a', 'b', 'e']);
    });

    it('finds the largest tiles for the grid', () => {
        fitGrid(1, 1600, 900, 0).should.eql({ cols: 1, w: 1600, h: 900 });
        fitGrid(4, 1600, 900, 0).cols.should.equal(2);
        fitGrid(3, 1600, 900, 0).cols.should.equal(2);
        fitGrid(6, 1920, 1080, 12).cols.should.equal(3);
    });
});
