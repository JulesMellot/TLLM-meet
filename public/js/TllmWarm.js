'use strict';

// TLLM*meet: open the camera and the microphone once before the meeting.
//
// Before, the camera was opened three times on the way in (the permission request, the preview, the
// meeting) and the microphone three times too (permission, level meter, meeting): each opening of a
// camera takes 0.5 to 2 s on a phone, and on iOS a new request can end the previous track.
// Now the tracks already open are kept here and handed to the next step when it wants the same device:
// the permission request gives them to the preview and the meter, the preview gives its camera to the
// meeting. What nobody took is stopped once the meeting has started its media (clear()).
//
// A track is only reused when it fits: same device, then resized (camera) or set to the requested
// echo cancellation / noise suppression / gain (microphone). A microphone the browser cannot adjust
// is stopped and opened again normally, so the meeting never gets a wrongly tuned voice.

(function (root) {
    const kept = new Map(); // kind -> live MediaStreamTrack

    const live = (track) => !!track && track.readyState === 'live';
    const deviceOf = (track) => track.getSettings?.().deviceId;

    // The device asked for by constraints like { deviceId: { exact } } or { ideal } or a plain id
    function wantedDevice(constraints) {
        const id = constraints && typeof constraints === 'object' ? constraints.deviceId : undefined;
        if (!id) return null;
        if (typeof id === 'string') return id;
        return id.exact || id.ideal || null;
    }

    function stop(track) {
        try {
            track.stop();
        } catch (e) {
            /* already ended */
        }
    }

    function put(track) {
        if (!live(track)) return;
        const previous = kept.get(track.kind);
        if (previous && previous !== track) stop(previous);
        kept.set(track.kind, track);
    }

    // The kept track of this kind if it is the device wanted (any device when none is named), or null
    function peek(kind, deviceId = null) {
        const track = kept.get(kind);
        if (!live(track)) {
            kept.delete(kind);
            return null;
        }
        if (deviceId && deviceOf(track) !== deviceId) return null;
        return track;
    }

    const AUDIO_PROCESSING = ['echoCancellation', 'autoGainControl', 'noiseSuppression'];

    // Hands the kept track over (it is no longer kept here), adjusted to the constraints; null when
    // there is none for that device or it cannot be adjusted (then it is stopped)
    async function take(kind, constraints = {}) {
        const track = peek(kind, wantedDevice(constraints));
        if (!track) {
            // Another device is wanted: the kept one will not be used
            const other = kept.get(kind);
            if (other) stop(other);
            kept.delete(kind);
            return null;
        }
        kept.delete(kind);
        const wanted = { ...(typeof constraints === 'object' ? constraints : {}) };
        delete wanted.deviceId;
        delete wanted.facingMode;
        try {
            if (Object.keys(wanted).length) await track.applyConstraints(wanted);
        } catch (error) {
            console.warn(`[TLLM] kept ${kind} track could not be adjusted`, error?.name || error);
            if (kind === 'audio') {
                stop(track);
                return null;
            }
        }
        if (kind === 'audio') {
            const settings = track.getSettings?.() || {};
            const wrong = AUDIO_PROCESSING.filter(
                (key) => key in wanted && key in settings && settings[key] !== wanted[key]
            );
            if (wrong.length) {
                console.info('[TLLM] kept microphone not reused, browser kept', wrong.join(', '));
                stop(track);
                return null;
            }
        }
        return live(track) ? track : null;
    }

    function clear() {
        for (const track of kept.values()) stop(track);
        kept.clear();
    }

    const api = { put, peek, take, clear, wantedDevice };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.TllmWarm = api;
})(typeof window !== 'undefined' ? window : globalThis);
