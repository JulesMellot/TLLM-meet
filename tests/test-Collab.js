'use strict';

const assert = require('assert');
const Y = require('yjs');
const syncProtocol = require('y-protocols/sync');
const awarenessProtocol = require('y-protocols/awareness');
const encoding = require('lib0/encoding');
const decoding = require('lib0/decoding');
const { CollabStore, CollabRoom } = require('../app/src/Collab');

const updateMessage = (text, field = 'editor') => {
    const doc = new Y.Doc();
    doc.getText(field).insert(0, text);
    const encoder = encoding.createEncoder();
    syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(doc));
    return encoding.toUint8Array(encoder);
};

const awarenessMessage = (clientId, state, clock = 1) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 1);
    encoding.writeVarUint(encoder, clientId);
    encoding.writeVarUint(encoder, clock);
    encoding.writeVarString(encoder, JSON.stringify(state));
    return encoding.toUint8Array(encoder);
};

describe('test-Collab (shared editor and whiteboard state)', () => {
    let sent;
    let room;
    const opts = { keepMs: 50, maxMessageBytes: 4096, maxDocBytes: 8192, maxAwarenessBytes: 1024 };

    beforeEach(() => {
        sent = [];
        room = new CollabRoom('r1', opts, (except, event, payload) => sent.push({ except, event, payload }));
    });
    afterEach(() => room.destroy());

    it('answers a sync step 1 with the content, then asks what it misses', () => {
        room.handleSync('a', updateMessage('Bonjour'), true);
        const encoder = encoding.createEncoder();
        syncProtocol.writeSyncStep1(encoder, new Y.Doc());
        const { replies, rejected } = room.handleSync('b', encoding.toUint8Array(encoder), false);
        assert.equal(rejected, false);
        assert.equal(replies.length, 2);
        const doc = new Y.Doc();
        syncProtocol.readSyncMessage(decoding.createDecoder(replies[0]), encoding.createEncoder(), doc, null);
        assert.equal(doc.getText('editor').toString(), 'Bonjour');
        assert.equal(decoding.readVarUint(decoding.createDecoder(replies[1])), syncProtocol.messageYjsSyncStep1);
    });

    it('applies writes from people allowed to share and relays them to the others', () => {
        const result = room.handleSync('a', updateMessage('Bonjour'), true);
        assert.equal(result.rejected, false);
        assert.equal(room.doc.getText('editor').toString(), 'Bonjour');
        assert.equal(sent.length, 1);
        assert.equal(sent[0].except, 'a');
        assert.equal(sent[0].event, 'collabSync');
    });

    it('drops writes from people not allowed to share', () => {
        const result = room.handleSync('b', updateMessage('Pirate'), false);
        assert.equal(result.rejected, true);
        assert.equal(room.doc.getText('editor').toString(), '');
        assert.equal(sent.length, 0);
    });

    it('rejects garbage, empty and oversized messages', () => {
        assert.equal(room.handleSync('a', 'text', true).rejected, true);
        assert.equal(room.handleSync('a', new Uint8Array(), true).rejected, true);
        assert.equal(room.handleSync('a', new Uint8Array([9, 9, 9]), true).rejected, true);
        assert.equal(room.handleSync('a', new Uint8Array([2, 200, 200, 200]), true).rejected, true);
        assert.equal(room.handleSync('a', updateMessage('x'.repeat(5000)), true).rejected, true);
        assert.equal(room.doc.getText('editor').toString(), '');
    });

    it('stops growing the document past its size limit', () => {
        for (let i = 0; i < 3; i++) room.handleSync('a', updateMessage('y'.repeat(3000), 'f' + i), true);
        const last = room.handleSync('a', updateMessage('z'.repeat(3000), 'g'), true);
        assert.equal(last.rejected, true);
        assert.ok(Y.encodeStateAsUpdate(room.doc).length <= opts.maxDocBytes);
    });

    it('sets the cursor name from the server and cleans the colour', () => {
        assert.ok(room.handleAwareness('a', awarenessMessage(11, { user: { name: 'Admin', color: 'red' } }), 'Bob'));
        assert.deepEqual(room.awareness.getStates().get(11).user, { name: 'Bob', color: '#8a94a6' });
        room.handleAwareness('a', awarenessMessage(11, { user: { color: '#AA3311' } }, 2), 'Bob');
        assert.equal(room.awareness.getStates().get(11).user.color, '#AA3311');
        const relayed = sent.filter((m) => m.event === 'collabAwareness');
        assert.equal(relayed[0].except, 'a');
    });

    it('does not let a socket speak for the cursor of another one', () => {
        room.handleAwareness('a', awarenessMessage(11, { user: {} }), 'Bob');
        assert.equal(room.handleAwareness('b', awarenessMessage(11, { user: {} }, 5), 'Carol'), false);
        assert.equal(room.awareness.getStates().get(11).user.name, 'Bob');
    });

    it('removes the cursors of a socket that leaves', () => {
        room.handleAwareness('a', awarenessMessage(11, { user: {} }), 'Bob');
        sent = [];
        room.removeSocket('a');
        assert.equal(room.awareness.getStates().has(11), false);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].except, null);
    });

    it('ignores a socket that floods the room', () => {
        const limited = new CollabRoom('r2', { ...opts, syncRate: [1, 3] }, () => {});
        const results = [];
        for (let i = 0; i < 5; i++)
            results.push(limited.handleSync('a', updateMessage('x' + i, 'f' + i), true).rejected);
        assert.deepEqual(results, [false, false, false, true, true]);
        assert.equal(
            limited.handleSync('b', updateMessage('y'), true).rejected,
            false,
            'other sockets are not affected'
        );
        limited.destroy();
    });

    it('keeps an empty room content for a while, then forgets it', async () => {
        const store = new CollabStore(opts);
        store.get('r').handleSync('a', updateMessage('Notes'), true);
        store.release('r');
        assert.equal(store.get('r').doc.getText('editor').toString(), 'Notes', 'a rejoin cancels the release');
        store.release('r');
        await new Promise((r) => setTimeout(r, 80));
        assert.equal(store.has('r'), false);
        store.dropAll();
    });
});
