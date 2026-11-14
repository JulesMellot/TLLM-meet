'use strict';

const should = require('should');

const TllmWarm = require('../public/js/TllmWarm');

// A camera or microphone track; `adjusts` false: the browser ignores audio processing changes
function makeTrack(kind, deviceId, { adjusts = true } = {}) {
    const settings = { deviceId, echoCancellation: true, autoGainControl: true, noiseSuppression: true };
    return {
        kind,
        readyState: 'live',
        applied: [],
        stop() {
            this.readyState = 'ended';
        },
        getSettings: () => ({ ...settings }),
        async applyConstraints(constraints) {
            this.applied.push(constraints);
            if (!adjusts) return;
            for (const key of ['echoCancellation', 'autoGainControl', 'noiseSuppression'])
                if (key in constraints) settings[key] = constraints[key];
        },
    };
}

describe('test-TllmWarm', () => {
    afterEach(() => TllmWarm.clear());

    it('hands the open camera to the next step, resized, and only once', async () => {
        const camera = makeTrack('video', 'cam-1');
        TllmWarm.put(camera);
        const wanted = { width: { ideal: 1280 }, height: { ideal: 720 }, deviceId: { exact: 'cam-1' } };

        const track = await TllmWarm.take('video', wanted);
        track.should.equal(camera);
        camera.applied.should.eql([{ width: { ideal: 1280 }, height: { ideal: 720 } }]);
        (await TllmWarm.take('video', wanted)) === null || should.fail();
    });

    it('stops the open camera when another one is wanted', async () => {
        const camera = makeTrack('video', 'cam-1');
        TllmWarm.put(camera);
        (await TllmWarm.take('video', { deviceId: { exact: 'cam-2' } })) === null || should.fail();
        camera.readyState.should.equal('ended');
    });

    it('lets the meter look at the microphone without taking it', () => {
        const mic = makeTrack('audio', 'mic-1');
        TllmWarm.put(mic);
        TllmWarm.peek('audio', 'mic-1').should.equal(mic);
        TllmWarm.peek('audio').should.equal(mic);
        (TllmWarm.peek('audio', 'mic-2') === null).should.be.true();
        mic.readyState.should.equal('live');
    });

    it('reuses the microphone once it has the echo cancellation and noise suppression asked for', async () => {
        const mic = makeTrack('audio', 'mic-1');
        TllmWarm.put(mic);
        const wanted = {
            echoCancellation: true,
            autoGainControl: true,
            noiseSuppression: false,
            deviceId: { exact: 'mic-1' },
        };
        (await TllmWarm.take('audio', wanted)).should.equal(mic);
        mic.getSettings().noiseSuppression.should.be.false();
    });

    it('opens the microphone again when the browser cannot adjust it', async () => {
        const mic = makeTrack('audio', 'mic-1', { adjusts: false });
        TllmWarm.put(mic);
        const wanted = { echoCancellation: true, noiseSuppression: false };
        ((await TllmWarm.take('audio', wanted)) === null).should.be.true();
        mic.readyState.should.equal('ended');
    });

    it('stops what nobody took, and ignores ended tracks', () => {
        const camera = makeTrack('video', 'cam-1');
        const mic = makeTrack('audio', 'mic-1');
        TllmWarm.put(camera);
        TllmWarm.put(mic);
        TllmWarm.clear();
        camera.readyState.should.equal('ended');
        mic.readyState.should.equal('ended');

        const ended = makeTrack('video', 'cam-1');
        ended.stop();
        TllmWarm.put(ended);
        (TllmWarm.peek('video') === null).should.be.true();
    });

    it('reads the device asked for, whatever the form', () => {
        TllmWarm.wantedDevice({ deviceId: { exact: 'a' } }).should.equal('a');
        TllmWarm.wantedDevice({ deviceId: { ideal: 'b' } }).should.equal('b');
        TllmWarm.wantedDevice({ deviceId: 'c' }).should.equal('c');
        (TllmWarm.wantedDevice(true) === null).should.be.true();
        (TllmWarm.wantedDevice({ width: 1 }) === null).should.be.true();
    });
});
