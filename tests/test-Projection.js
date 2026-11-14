'use strict';

require('should');

const { arrange, fitGrid, pollToShow, pollBars } = require('../public/js/TllmProjection');

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

    it('puts a poll before anything presented, with the people beside', () => {
        const poll = { id: 'p1' };
        const { main, people } = arrange({ tiles: [screen('me', 1), cam('ana')], content: 'board', poll, me: 'me' });
        main.should.eql({ kind: 'poll', poll });
        people.map((t) => t.peerId).should.eql(['ana']);
    });

    it('shows the latest open poll, then the results for a minute after the close', () => {
        const a = { id: 'a', closed: true };
        const b = { id: 'b', closed: false };
        const c = { id: 'c', closed: true };
        pollToShow([a, b, c], new Map(), 0).should.equal(b);
        (pollToShow([], new Map(), 0) === null).should.be.true();
        // c closed while projecting, at 1000
        const closedAt = new Map([
            ['a', 0],
            ['c', 1000],
        ]);
        pollToShow([a, c], closedAt, 30000).should.equal(c);
        (pollToShow([a, c], closedAt, 61001) === null).should.be.true();
        // Already closed when the projection opened: not shown again
        (pollToShow([a], new Map([['a', 0]]), 5000) === null).should.be.true();
    });

    it('keeps the results hidden on the projector until the close when the poll hides them', () => {
        // A presenter's view carries the counts even then
        const poll = { options: ['Oui', 'Non'], counts: [3, 1], hideResults: true, closed: false };
        pollBars(poll).should.eql({
            hidden: true,
            rows: [
                { option: 'Oui', count: null, pct: 0 },
                { option: 'Non', count: null, pct: 0 },
            ],
        });
        pollBars({ ...poll, closed: true })
            .rows.map((r) => r.pct)
            .should.eql([75, 25]);
        pollBars({ ...poll, hideResults: false, counts: [0, 0] })
            .rows.map((r) => r.pct)
            .should.eql([0, 0]);
    });

    it('finds the largest tiles for the grid', () => {
        fitGrid(1, 1600, 900, 0).should.eql({ cols: 1, w: 1600, h: 900 });
        fitGrid(4, 1600, 900, 0).cols.should.equal(2);
        fitGrid(3, 1600, 900, 0).cols.should.equal(2);
        fitGrid(6, 1920, 1080, 12).cols.should.equal(3);
    });
});
