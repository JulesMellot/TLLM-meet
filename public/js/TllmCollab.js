'use strict';

/**
 * TLLM*meet: client side of the shared editor and whiteboard (server side: app/src/Collab.js).
 *
 * One Yjs document per room, synced with the server over the MiroTalk socket. The server
 * holds the content, so late joiners get it, and drops writes from people not allowed to share.
 * The editor (TllmEditor.js) and the whiteboard use window.tllmCollab.
 */

(() => {
    const L = window.TllmCollabLib;
    if (!L) return console.warn('TLLM*meet: collab bundle missing');
    const { Y, syncProtocol, awarenessProtocol, encoding, decoding } = L;

    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    const REMOTE = 'tllm-remote';
    const listeners = { synced: [], writable: [], connection: [] };

    const C = (window.tllmCollab = {
        lib: L,
        doc,
        awareness,
        REMOTE,
        socket: null,
        synced: false,
        connected: false,
        writable: false,
        on(event, fn) {
            listeners[event].push(fn);
            if (event === 'synced' && C.synced) fn();
        },
        start,
        setWritable,
    });

    const fire = (event, value) => listeners[event].forEach((fn) => fn(value));

    const send = (event, data) => {
        if (C.socket?.connected) C.socket.emit(event, data);
    };

    function sendStep1() {
        const encoder = encoding.createEncoder();
        syncProtocol.writeSyncStep1(encoder, doc);
        send('collabSync', encoding.toUint8Array(encoder));
    }

    function sendAwareness() {
        if (awareness.getLocalState() === null) return;
        send('collabAwareness', awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID]));
    }

    function start(socket, me) {
        if (C.socket) return;
        C.socket = socket;
        C.connected = socket.connected;

        socket.on('collabSync', (data) => {
            const decoder = decoding.createDecoder(new Uint8Array(data));
            const encoder = encoding.createEncoder();
            const type = syncProtocol.readSyncMessage(decoder, encoder, doc, REMOTE);
            // The server asked what we have that it misses (only useful if we may write)
            if (encoding.length(encoder) > 0 && C.writable) send('collabSync', encoding.toUint8Array(encoder));
            if (type === syncProtocol.messageYjsSyncStep2 && !C.synced) {
                C.synced = true;
                fire('synced');
            }
        });

        socket.on('collabAwareness', (data) => {
            awarenessProtocol.applyAwarenessUpdate(awareness, new Uint8Array(data), REMOTE);
        });

        socket.on('disconnect', () => {
            C.connected = false;
            fire('connection', false);
        });
        socket.on('connect', () => {
            C.connected = true;
            fire('connection', true);
        });

        doc.on('update', (update, origin) => {
            if (origin === REMOTE || !C.writable) return;
            const encoder = encoding.createEncoder();
            syncProtocol.writeUpdate(encoder, update);
            send('collabSync', encoding.toUint8Array(encoder));
        });

        awareness.on('update', ({ added, updated, removed }, origin) => {
            if (origin === REMOTE) return;
            const mine = added.concat(updated, removed).filter((id) => id === doc.clientID);
            if (mine.length) send('collabAwareness', awarenessProtocol.encodeAwarenessUpdate(awareness, mine));
        });

        awareness.setLocalStateField('user', { name: me.name, color: me.color });
        window.addEventListener('beforeunload', () =>
            awarenessProtocol.removeAwarenessStates(awareness, [doc.clientID], 'leave')
        );

        sendStep1();
        sendAwareness();
    }

    // Allowed to share or not. When the right comes back, sync again so the server gets
    // anything typed locally in the meantime.
    function setWritable(value) {
        value = !!value;
        if (value === C.writable) return;
        C.writable = value;
        if (value && C.socket) sendStep1();
        fire('writable', value);
    }
})();
