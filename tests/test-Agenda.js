'use strict';

require('should');

const { Agenda, cleanItems, pointLabel } = require('../app/src/Agenda');
const { clock, timer } = require('../public/js/TllmAgenda');

describe('test-Agenda', () => {
    let now;
    let agenda;
    const items = [
        { title: 'Tour de table', minutes: 5 },
        { title: 'Budget', minutes: 15 },
        { title: 'Questions', minutes: 0 },
    ];

    beforeEach(() => {
        now = 1000000;
        agenda = new Agenda({ now: () => now });
    });

    it('cleans the points: titles trimmed, empty ones dropped, minutes bounded', () => {
        cleanItems([
            { title: '  Budget\n 2027 ', minutes: '15' },
            { title: '   ', minutes: 5 },
            { title: 'Long', minutes: 9999 },
            { title: 'Négatif', minutes: -3 },
            { title: 'Rien', minutes: 'abc' },
        ]).should.eql([
            { title: 'Budget 2027', minutes: 15 },
            { title: 'Long', minutes: 600 },
            { title: 'Négatif', minutes: 0 },
            { title: 'Rien', minutes: 0 },
        ]);
        (cleanItems('nope') === null).should.be.true();
        cleanItems(Array.from({ length: 50 }, (_, i) => ({ title: `P${i}` }))).length.should.equal(30);
    });

    it('starts, moves on, and counts the time spent on each point', () => {
        agenda.set('r', items).should.be.true();
        agenda.view('r').current.should.equal(-1);
        agenda.go('r', 0).to.should.eql({ index: 0, title: 'Tour de table', minutes: 5 });
        now += 4 * 60000;
        agenda.view('r').elapsedMs.should.equal(4 * 60000);
        const step = agenda.go('r', 1);
        step.from.title.should.equal('Tour de table');
        now += 60000;
        (agenda.go('r', 1) === null).should.be.true(); // already there
        (agenda.go('r', 7) === null).should.be.true();
        agenda.go('r', 0); // back to the first point: its time adds up
        now += 30000;
        agenda.finish('r').title.should.equal('Tour de table');
        const view = agenda.view('r');
        view.spent.should.eql([4.5 * 60000, 60000, 0]);
        view.current.should.equal(-1);
        view.finished.should.be.true();
        (agenda.finish('r') === null).should.be.true();
    });

    it('keeps the point under way when the list changes around it', () => {
        agenda.set('r', items);
        agenda.go('r', 1);
        now += 60000;
        agenda.set('r', [{ title: 'Accueil', minutes: 2 }, items[0], { title: 'Budget', minutes: 20 }]);
        agenda.current('r').should.eql({ index: 2, title: 'Budget', minutes: 20 });
        agenda.view('r').elapsedMs.should.equal(60000); // its timer goes on
        agenda.set('r', [{ title: 'Autre', minutes: 1 }]);
        (agenda.current('r') === null).should.be.true();
    });

    it('forgets the agenda with the meeting', () => {
        agenda.set('r', items);
        agenda.close('r');
        agenda.view('r').items.should.eql([]);
    });

    it('labels a point', () => {
        pointLabel(1, 3, 'Budget').should.equal('Point 2/3 : Budget');
    });

    it('shows the time left, then the time over, or the time spent without a limit', () => {
        clock(754000).should.equal('12:34');
        clock(3723000).should.equal('1:02:03');
        timer(5, 60000).should.eql({ text: '04:00', over: false, left: 240000 });
        timer(5, 6 * 60000 + 5000).should.eql({ text: '+01:05', over: true, left: -65000 });
        timer(0, 125000).should.eql({ text: '02:05', over: false, left: null });
    });
});
