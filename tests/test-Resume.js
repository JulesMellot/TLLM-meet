'use strict';

require('should');

const http = require('http');
const { Server } = require('socket.io');
const { io: connect } = require('socket.io-client');

const { Resume, takeOverLiveSessions } = require('../app/src/Resume');

describe('test-Resume', () => {
    describe('a place kept during a network cut', () => {
        // A clock and timers by hand
        const makeResume = (graceMs = 45000) => {
            const timers = [];
            let now = 1000;
            const resume = new Resume({
                graceMs,
                now: () => now,
                setTimer: (fn, ms) => {
                    const timer = { fn, at: now + ms, cleared: false };
                    timers.push(timer);
                    return timer;
                },
                clearTimer: (timer) => timer && (timer.cleared = true),
            });
            const advance = (ms) => {
                now += ms;
                for (const timer of timers) {
                    if (!timer.cleared && !timer.done && timer.at <= now) {
                        timer.done = true;
                        timer.fn();
                    }
                }
            };
            return { resume, advance };
        };

        it('gives the place back to someone who returns in time', () => {
            const { resume, advance } = makeResume();
            let left = 0;
            resume.suspend('socket-1', { room_id: 'salle' }, () => left++).should.be.true();
            resume.has('socket-1').should.be.true();

            advance(12000);
            const back = resume.take('socket-1');
            back.state.should.eql({ room_id: 'salle' });
            back.awayMs.should.equal(12000);

            advance(60000);
            left.should.equal(0);
            resume.has('socket-1').should.be.false();
        });

        it('lets go of someone who does not return', () => {
            const { resume, advance } = makeResume(45000);
            const gone = [];
            resume.suspend('socket-1', { room_id: 'salle' }, (state, why) => gone.push([state.room_id, why]));

            advance(44000);
            gone.should.eql([]);
            advance(2000);
            gone.should.eql([['salle', 'timeout']]);
            (resume.take('socket-1') === null).should.be.true();
        });

        it('lets go at once when the page was closed or the person joined again', () => {
            const { resume, advance } = makeResume();
            const gone = [];
            resume.suspend('a', {}, (_, why) => gone.push(why));
            resume.suspend('b', {}, (_, why) => gone.push(why));

            resume.expire('a', 'page').should.be.true();
            resume.expire('b', 'rejoined').should.be.true();
            resume.expire('b', 'rejoined').should.be.false();
            advance(100000);
            gone.should.eql(['page', 'rejoined']);
        });

        it('waits for nobody when the server stops, or when the grace period is 0', () => {
            const { resume } = makeResume();
            const gone = [];
            resume.suspend('a', {}, (_, why) => gone.push(why));
            resume.expireAll();
            gone.should.eql(['shutdown']);

            const off = makeResume(0).resume;
            off.enabled.should.be.false();
            off.suspend('a', {}, () => {}).should.be.false();
        });
    });

    describe('with Socket.IO', function () {
        this.timeout(10000);
        let server, io, url;
        const events = [];

        beforeEach((done) => {
            events.length = 0;
            server = http.createServer();
            io = new Server(server, {
                transports: ['websocket'],
                connectionStateRecovery: { maxDisconnectionDuration: 60000, skipMiddlewares: true },
            });
            takeOverLiveSessions(io);
            io.on('connection', (socket) => {
                events.push(['connection', socket.id, socket.recovered]);
                socket.on('disconnect', (reason) => events.push(['disconnect', socket.id, reason]));
            });
            server.listen(0, () => {
                url = `http://localhost:${server.address().port}`;
                done();
            });
        });

        afterEach((done) => {
            io.close(() => done());
        });

        const once = (emitter, event) => new Promise((resolve) => emitter.once(event, resolve));
        const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

        it('gives back the same id and the missed events after a cut', async () => {
            const client = connect(url, { transports: ['websocket'], reconnectionDelay: 50 });
            const got = [];
            client.on('news', (text) => got.push(text));
            await once(client, 'connect');
            const id = client.id;

            io.to(id).emit('news', 'before');
            await pause(50);

            const cut = once(client, 'disconnect');
            client.io.engine.close(); // the network drops
            await cut;
            io.to(id).emit('news', 'during the cut');
            await once(client, 'connect');
            await pause(50);

            client.recovered.should.be.true();
            client.id.should.equal(id);
            got.should.eql(['before', 'during the cut']);
            client.disconnect();
        });

        it('takes over a connection the server still believes alive (Wi-Fi to 4G)', async () => {
            const first = connect(url, { transports: ['websocket'], reconnection: false });
            await once(first, 'connect');
            const id = first.id;
            io.to(id).emit('news', 'before');
            await pause(50);

            // The same browser comes back on a new connection, with its private session id, while
            // the server has not noticed yet that the first one is dead
            const second = connect(url, {
                transports: ['websocket'],
                forceNew: true,
                reconnection: false,
                auth: { pid: first._pid, offset: first._lastOffset },
            });
            const got = [];
            second.on('news', (text) => got.push(text));
            io.to(id).emit('news', 'sent into the dead connection');
            await once(second, 'connect');
            await pause(50);

            second.id.should.equal(id);
            got.should.eql(['sent into the dead connection']);
            events.should.eql([
                ['connection', id, false],
                ['disconnect', id, 'forced close'],
                ['connection', id, true],
            ]);
            first.disconnect();
            second.disconnect();
        });

        it('does not give a session to someone who does not know its private id', async () => {
            const first = connect(url, { transports: ['websocket'], reconnection: false });
            await once(first, 'connect');
            io.to(first.id).emit('news', 'before');
            await pause(50);

            const stranger = connect(url, {
                transports: ['websocket'],
                forceNew: true,
                reconnection: false,
                auth: { pid: first.id, offset: first._lastOffset },
            });
            await once(stranger, 'connect');

            stranger.id.should.not.equal(first.id);
            first.connected.should.be.true();
            first.disconnect();
            stranger.disconnect();
        });
    });
});
