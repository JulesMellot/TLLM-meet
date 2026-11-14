'use strict';

// TLLM*meet: receive no more than what is looked at.
//
// Each camera is sent in three sizes (a quarter, half and the whole picture, see sendBitrate in
// RoomClient.js). This file tells the server, for each picture received, which size its tile needs
// on this screen: a small tile in a grid gets the small one, someone pinned gets the whole one.
// A picture nobody can see (tile hidden or out of the screen, page in the background) is not
// sent at all: the sound goes on, the picture comes back as soon as it is visible again.
// A voice turned down to zero on this screen (speaker volume or that person's volume) is not
// sent either, and comes back as soon as the volume is raised.
// On a phone on 4G with eight people this divides what is downloaded by five to ten.

(function (root) {
    const OFF = -1;

    // Height of the tile on screen (pixels really drawn) -> size to receive: 0 quarter, 1 half, 2 whole.
    // A 720p camera gives 180, 360 and 720 lines: each is stretched by a third at most.
    function layerFor(height) {
        if (!(height > 0)) return OFF;
        if (height <= 240) return 0;
        if (height <= 480) return 1;
        return 2;
    }

    // What changed since what the server was last told: [{ id, layer }]
    function changes(needs, told) {
        const list = [];
        for (const [id, layer] of needs) if (told.get(id) !== layer) list.push({ id, layer });
        return list;
    }

    function drawnHeight(el, view) {
        if (!el || !el.isConnected) return 0;
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return 0;
        if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= view.innerHeight || rect.left >= view.innerWidth)
            return 0;
        const style = view.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') return 0;
        // A very dense screen (phone) does not need every pixel of a face
        return rect.height * Math.min(view.devicePixelRatio || 1, 1.5);
    }

    function start(rc, { view = root, everyMs = 1500 } = {}) {
        const doc = view.document;
        const told = new Map(); // consumer id -> layer the server knows
        let busy = false;

        // Everything is wanted whole while it is recorded, shown in a picture-in-picture window
        // or on a projector (presentation mode, TllmProjection.js)
        const wantsAll = () =>
            Boolean(
                rc.isRecording?.() ||
                rc.hasActiveRecorder?.() ||
                doc.pictureInPictureElement ||
                view.documentPictureInPicture?.window ||
                view.tllmProjection?.isOpen?.()
            );

        // Sound off on this screen: the speaker volume at zero, or this voice at zero
        function silenced(id) {
            if (rc.masterOutputVolume === 0) return true;
            const volume = doc.getElementById(id)?.dataset?.peerVolume;
            return volume !== undefined && Number(volume) === 0;
        }

        function needs() {
            const map = new Map();
            const all = wantsAll();
            for (const [id, consumer] of rc.consumers) {
                if (consumer.closed || !rc.resumedConsumers.has(id)) continue;
                if (consumer.kind === 'audio') {
                    // A voice turned down to nothing here is not sent; it comes back with the volume
                    if (!all && silenced(id)) map.set(id, OFF);
                    else if (told.has(id)) map.set(id, 2);
                    continue;
                }
                if (consumer.kind !== 'video') continue;
                if (all) map.set(id, 2);
                else map.set(id, doc.hidden ? OFF : layerFor(drawnHeight(doc.getElementById(id), view)));
            }
            return map;
        }

        async function sync() {
            if (busy || !rc.socket?.connected || !rc._isConnected) return;
            const wanted = needs();
            for (const id of [...told.keys()]) if (!wanted.has(id)) told.delete(id);
            const list = changes(wanted, told);
            if (!list.length) return;
            busy = true;
            try {
                await rc.socket.request('consumerNeeds', list, 5000);
                for (const { id, layer } of list) told.set(id, layer);
            } catch (error) {
                console.warn('consumerNeeds not applied, tried again', error);
            } finally {
                busy = false;
            }
        }

        const timer = view.setInterval(sync, everyMs);
        doc.addEventListener('visibilitychange', sync);
        return { sync, told, stop: () => view.clearInterval(timer) };
    }

    const api = { OFF, layerFor, changes, start };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.TllmNetwork = api;
})(typeof window !== 'undefined' ? window : globalThis);
