'use strict';

// TLLM*meet: shared state of the editor and the whiteboard, kept by the server for each room.
//
// Each room has one Yjs document. Clients sync it with the y-protocols sync messages over
// Socket.IO: late joiners get the content from the server, and concurrent edits merge.
// Only presenters and the people they allowed may write: the server drops the other updates.
// Awareness (cursors, names) goes through the server too, which sets the displayed name itself.
// When a room empties, its document is kept for a while so a quick rejoin finds it again.

const Y = require('yjs');
const syncProtocol = require('y-protocols/sync');
const awarenessProtocol = require('y-protocols/awareness');
const encoding = require('lib0/encoding');
const decoding = require('lib0/decoding');

const DEFAULTS = {
    keepMs: 6 * 60 * 60 * 1000, // keep an empty room's content 6 hours
    maxMessageBytes: 2 * 1024 * 1024, // one update (a pasted image is the biggest case)
    maxDocBytes: 12 * 1024 * 1024, // whole document
    maxAwarenessBytes: 4096,
};

const COLOR = /^#[0-9a-f]{6}$/i;

function toUint8(data) {
    if (data instanceof Uint8Array) return data; // Buffer is a Uint8Array
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return null;
}

class CollabRoom {
    constructor(id, opts, broadcast) {
        this.id = id;
        this.opts = opts;
        this.broadcast = broadcast; // (exceptSocketId, event, payload)
        this.doc = new Y.Doc({ gc: true });
        this.awareness = new awarenessProtocol.Awareness(this.doc);
        this.awareness.setLocalState(null); // the server has no cursor
        this.clients = new Map(); // socket id -> Set of awareness client ids
        this.owners = new Map(); // awareness client id -> socket id
        this.bytesSinceCheck = 0;
        this.docBytes = 0;

        this.doc.on('update', (update, origin) => {
            const encoder = encoding.createEncoder();
            syncProtocol.writeUpdate(encoder, update);
            this.broadcast(typeof origin === 'string' ? origin : null, 'collabSync', encoding.toUint8Array(encoder));
        });

        this.awareness.on('update', ({ added, updated, removed }, origin) => {
            const changed = added.concat(updated, removed);
            if (!changed.length) return;
            const update = awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed);
            this.broadcast(typeof origin === 'string' ? origin : null, 'collabAwareness', update);
        });
    }

    // Messages from a client. Returns the replies to send back to that client.
    handleSync(socketId, data, canWrite) {
        const buf = toUint8(data);
        if (!buf || !buf.length || buf.length > this.opts.maxMessageBytes) return { replies: [], rejected: true };

        const replies = [];
        try {
            const decoder = decoding.createDecoder(buf);
            const type = decoding.readVarUint(decoder);
            if (type === syncProtocol.messageYjsSyncStep1) {
                // The client says what it has: send what it misses, then ask for what we miss
                const reply = encoding.createEncoder();
                syncProtocol.readSyncStep1(decoder, reply, this.doc);
                replies.push(encoding.toUint8Array(reply));
                const ask = encoding.createEncoder();
                syncProtocol.writeSyncStep1(ask, this.doc);
                replies.push(encoding.toUint8Array(ask));
                return { replies, rejected: false };
            }
            if (type !== syncProtocol.messageYjsSyncStep2 && type !== syncProtocol.messageYjsUpdate) {
                return { replies, rejected: true };
            }
            if (!canWrite || !this.hasRoomFor(buf.length)) return { replies, rejected: true };
            const update = decoding.readVarUint8Array(decoder);
            Y.applyUpdate(this.doc, update, socketId);
            return { replies, rejected: false };
        } catch (err) {
            return { replies, rejected: true, error: err };
        }
    }

    // Keep the document under the size limit. Measuring is costly, so it is done only
    // once enough bytes came in since the last measure.
    hasRoomFor(bytes) {
        this.bytesSinceCheck += bytes;
        if (this.docBytes + this.bytesSinceCheck <= this.opts.maxDocBytes) return true;
        this.docBytes = Y.encodeStateAsUpdate(this.doc).length;
        this.bytesSinceCheck = bytes;
        return this.docBytes + bytes <= this.opts.maxDocBytes;
    }

    // Awareness from a client: a socket may only speak for its own client ids, and the name
    // shown next to its cursor is the one the server knows.
    handleAwareness(socketId, data, peerName) {
        const buf = toUint8(data);
        if (!buf || !buf.length || buf.length > this.opts.maxAwarenessBytes) return false;
        let entries;
        try {
            const decoder = decoding.createDecoder(buf);
            const count = decoding.readVarUint(decoder);
            if (count > 4) return false;
            entries = [];
            for (let i = 0; i < count; i++) {
                const clientId = decoding.readVarUint(decoder);
                const clock = decoding.readVarUint(decoder);
                const state = JSON.parse(decoding.readVarString(decoder));
                entries.push({ clientId, clock, state });
            }
        } catch {
            return false;
        }

        const encoder = encoding.createEncoder();
        const kept = entries.filter(({ clientId }) => {
            const owner = this.owners.get(clientId);
            return !owner || owner === socketId;
        });
        if (!kept.length) return false;
        encoding.writeVarUint(encoder, kept.length);
        for (const { clientId, clock, state } of kept) {
            if (state !== null) {
                const color = state?.user?.color;
                state.user = {
                    name: String(peerName || 'Participant').slice(0, 60),
                    color: COLOR.test(color) ? color : '#8a94a6',
                };
                this.owners.set(clientId, socketId);
                if (!this.clients.has(socketId)) this.clients.set(socketId, new Set());
                this.clients.get(socketId).add(clientId);
            }
            encoding.writeVarUint(encoder, clientId);
            encoding.writeVarUint(encoder, clock);
            encoding.writeVarString(encoder, JSON.stringify(state));
        }
        awarenessProtocol.applyAwarenessUpdate(this.awareness, encoding.toUint8Array(encoder), socketId);
        return true;
    }

    // Everything a joining client needs to see the others' cursors
    awarenessSnapshot() {
        const ids = Array.from(this.awareness.getStates().keys());
        return ids.length ? awarenessProtocol.encodeAwarenessUpdate(this.awareness, ids) : null;
    }

    removeSocket(socketId) {
        const ids = this.clients.get(socketId);
        this.clients.delete(socketId);
        if (!ids) return;
        for (const id of ids) this.owners.delete(id);
        awarenessProtocol.removeAwarenessStates(this.awareness, Array.from(ids), null);
    }

    destroy() {
        this.awareness.destroy();
        this.doc.destroy();
    }
}

class CollabStore {
    constructor(options = {}, broadcast = () => {}) {
        this.opts = { ...DEFAULTS, ...options };
        this.broadcast = broadcast; // (roomId, exceptSocketId, event, payload)
        this.rooms = new Map();
        this.timers = new Map();
    }

    get(roomId) {
        this.cancelRelease(roomId);
        let room = this.rooms.get(roomId);
        if (!room) {
            room = new CollabRoom(roomId, this.opts, (except, event, payload) =>
                this.broadcast(roomId, except, event, payload)
            );
            this.rooms.set(roomId, room);
        }
        return room;
    }

    has(roomId) {
        return this.rooms.has(roomId);
    }

    leave(roomId, socketId) {
        this.rooms.get(roomId)?.removeSocket(socketId);
    }

    // The room is empty: forget its content after a while, unless someone comes back
    release(roomId) {
        if (!this.rooms.has(roomId)) return;
        this.cancelRelease(roomId);
        const timer = setTimeout(() => this.drop(roomId), this.opts.keepMs);
        timer.unref?.();
        this.timers.set(roomId, timer);
    }

    cancelRelease(roomId) {
        const timer = this.timers.get(roomId);
        if (timer) clearTimeout(timer);
        this.timers.delete(roomId);
    }

    drop(roomId) {
        this.cancelRelease(roomId);
        this.rooms.get(roomId)?.destroy();
        this.rooms.delete(roomId);
    }

    dropAll() {
        for (const roomId of Array.from(this.rooms.keys())) this.drop(roomId);
    }
}

module.exports = { CollabStore, CollabRoom };
