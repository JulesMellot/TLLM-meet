'use strict';

require('should');

const { OFF, layerFor, changes, start } = require('../public/js/TllmNetwork');

describe('test-TllmNetwork', () => {
    it('asks for the size the tile needs, nothing for a tile nobody sees', () => {
        layerFor(0).should.equal(OFF);
        layerFor(undefined).should.equal(OFF);
        layerFor(120).should.equal(0);
        layerFor(240).should.equal(0);
        layerFor(300).should.equal(1);
        layerFor(480).should.equal(1);
        layerFor(700).should.equal(2);
    });

    it('tells the server only what changed', () => {
        const told = new Map([
            ['a', 0],
            ['b', 2],
        ]);
        const needs = new Map([
            ['a', 0],
            ['b', OFF],
            ['c', 1],
        ]);
        changes(needs, told).should.eql([
            { id: 'b', layer: OFF },
            { id: 'c', layer: 1 },
        ]);
    });

    // A page with tiles of given heights
    const makePage = (heights) => {
        const sent = [];
        const listeners = {};
        const doc = {
            hidden: false,
            pictureInPictureElement: null,
            addEventListener: (name, fn) => (listeners[name] = fn),
            getElementById: (id) =>
                id in heights
                    ? {
                          isConnected: true,
                          getBoundingClientRect: () => ({
                              width: heights[id] ? 300 : 0,
                              height: heights[id],
                              top: 0,
                              left: 0,
                              bottom: heights[id],
                              right: 300,
                          }),
                      }
                    : null,
        };
        const view = {
            document: doc,
            innerWidth: 1280,
            innerHeight: 800,
            devicePixelRatio: 1,
            getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
            setInterval: () => 1,
            clearInterval: () => {},
        };
        const consumer = (kind) => ({ kind, closed: false });
        const rc = {
            _isConnected: true,
            recording: false,
            isRecording() {
                return this.recording;
            },
            consumers: new Map([
                ['small', consumer('video')],
                ['large', consumer('video')],
                ['hidden', consumer('video')],
                ['voice', consumer('audio')],
                ['starting', consumer('video')],
            ]),
            resumedConsumers: new Set(['small', 'large', 'hidden', 'voice']),
            socket: {
                connected: true,
                request: async (event, list) => {
                    sent.push([event, list]);
                    return { applied: list.length };
                },
            },
        };
        return { rc, view, doc, sent };
    };

    it('follows the tiles: small, large, hidden, then the page in the background', async () => {
        const heights = { small: 180, large: 600, hidden: 0, starting: 300 };
        const { rc, view, doc, sent } = makePage(heights);
        const network = start(rc, { view });

        await network.sync();
        sent.should.eql([
            [
                'consumerNeeds',
                [
                    { id: 'small', layer: 0 },
                    { id: 'large', layer: 2 },
                    { id: 'hidden', layer: OFF },
                ],
            ],
        ]);

        // Nothing changed: nothing is sent
        await network.sync();
        sent.length.should.equal(1);

        // The hidden tile is shown, the page then goes to the background
        heights.hidden = 300;
        await network.sync();
        sent[1][1].should.eql([{ id: 'hidden', layer: 1 }]);

        doc.hidden = true;
        await network.sync();
        sent[2][1].should.eql([
            { id: 'small', layer: OFF },
            { id: 'large', layer: OFF },
            { id: 'hidden', layer: OFF },
        ]);
    });

    it('keeps every picture whole while the meeting is recorded', async () => {
        const { rc, view, doc, sent } = makePage({ small: 180, large: 600, hidden: 0 });
        rc.recording = true;
        doc.hidden = true;
        await start(rc, { view }).sync();
        sent[0][1].map((need) => need.layer).should.eql([2, 2, 2]);
    });

    it('asks again when the server did not answer', async () => {
        const { rc, view, sent } = makePage({ small: 180, large: 600, hidden: 0 });
        let fail = true;
        rc.socket.request = async (event, list) => {
            if (fail) throw new Error('timeout');
            sent.push(list);
        };
        const network = start(rc, { view });
        const warn = console.warn;
        console.warn = () => {};
        await network.sync();
        console.warn = warn;
        sent.length.should.equal(0);
        fail = false;
        await network.sync();
        sent[0].length.should.equal(3);
    });
});
