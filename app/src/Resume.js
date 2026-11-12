'use strict';

// TLLM*meet: a network cut must not throw someone out of the meeting.
//
// The signalling (WebSocket) and the media (WebRTC) travel separately: the WebSocket of a phone
// often drops for a second or two (Wi-Fi to 4G, a lift, a sleepy radio) while sound and image go
// on. Before, the server removed the person at once and their browser reloaded the whole page:
// ten to fifteen seconds without the meeting, each time.
//
// Now the person keeps their place for a while (GRACE). Socket.IO's connection state recovery
// gives the returning browser the same socket id, its rooms and the events it missed, so nothing
// has to be rebuilt: same transports, same producers, same tiles for everybody else.
//
// - Resume: who is away, since when, and what to do if they do not come back.
// - takeOverLiveSessions: the browser noticed the cut before the server did (the old connection
//   looks alive until its ping times out). The returning browser proves who it is with its private
//   session id; the stale connection is closed on the spot, so that its session can be restored.

class Resume {
    constructor({ graceMs = 45000, setTimer = setTimeout, clearTimer = clearTimeout, now = () => Date.now() } = {}) {
        this.graceMs = Math.max(0, Number(graceMs) || 0);
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.now = now;
        this.away = new Map(); // socket id -> { state, since, timer, onExpire }
    }

    get enabled() {
        return this.graceMs > 0;
    }

    has(id) {
        return this.away.has(id);
    }

    // The connection of `id` dropped: `onExpire(state, why)` runs if it is not back within the grace period
    suspend(id, state, onExpire) {
        if (!this.enabled || !id) return false;
        this.forget(id);
        const entry = { state, since: this.now(), onExpire, timer: null };
        entry.timer = this.setTimer(() => this.expire(id, 'timeout'), this.graceMs);
        entry.timer?.unref?.();
        this.away.set(id, entry);
        return true;
    }

    // It came back in time: its state, and for how long it was away
    take(id) {
        const entry = this.away.get(id);
        if (!entry) return null;
        this.forget(id);
        return { state: entry.state, awayMs: Math.max(0, this.now() - entry.since) };
    }

    // It will not come back. why: 'timeout' (grace period over), 'page' (the page was closed),
    // 'rejoined' (the same person joined again from a fresh page), 'shutdown'
    expire(id, why = 'timeout') {
        const entry = this.away.get(id);
        if (!entry) return false;
        this.forget(id);
        entry.onExpire?.(entry.state, why);
        return true;
    }

    forget(id) {
        const entry = this.away.get(id);
        if (!entry) return;
        this.clearTimer(entry.timer);
        this.away.delete(id);
    }

    // Server stop: nobody is waited for any more
    expireAll() {
        for (const id of [...this.away.keys()]) this.expire(id, 'shutdown');
    }
}

// When a browser asks for its session back while its old connection still looks alive, close that
// old connection first: Socket.IO only keeps the session of a connection that is closed.
function takeOverLiveSessions(io, { onTakeOver } = {}) {
    const nsp = io.of('/');
    const adapter = nsp.adapter;
    if (typeof adapter?.restoreSession !== 'function' || adapter.tllmTakeOver) return false;
    const restoreSession = adapter.restoreSession.bind(adapter);
    adapter.tllmTakeOver = true;
    adapter.restoreSession = (pid, offset) => {
        try {
            for (const socket of nsp.sockets.values()) {
                if (socket.pid !== pid) continue;
                onTakeOver?.(socket);
                // Synchronous: the 'disconnect' handlers run and the session is stored before the restore below
                socket.conn.onClose('forced close');
                break;
            }
        } catch {
            /* the restore below then says there is no session: the browser joins again from scratch */
        }
        return restoreSession(pid, offset);
    };
    return true;
}

module.exports = { Resume, takeOverLiveSessions };
