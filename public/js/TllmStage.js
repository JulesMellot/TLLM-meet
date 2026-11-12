'use strict';

/**
 * TLLM*meet: what a presenter shows, everybody sees.
 *
 * When a presenter (the admin, the moderator of the room, or someone they promoted) opens or closes
 * the whiteboard or the shared notes, it opens or closes for everybody. The room keeps what is shown
 * (app/src/Server.js, 'stage'): who arrives later, or comes back after a cut, lands on the same thing.
 * A participant can still close it for themselves; the next change by a presenter applies again.
 */

(() => {
    if (typeof RoomClient === 'undefined') return;

    const P = RoomClient.prototype;
    const S = (window.tllmStage = { content: null, applying: false, started: false });
    const amPresenter = () => typeof isPresenter !== 'undefined' && !!isPresenter;
    const board = () => window.tllmBoard;
    const shown = () => (board()?.open ? 'board' : rc?.isEditorOpen ? 'editor' : null);

    // Show what the room shows, without telling anybody
    S.apply = function (content) {
        if (typeof rc === 'undefined' || !rc) return;
        S.applying = true;
        try {
            const b = board();
            if (content === 'board') {
                if (b && !b.open) b.toggle(true);
            } else if (content === 'editor') {
                if (b?.open) b.toggle(false);
                if (!rc.isEditorOpen) rc.toggleEditor();
            } else {
                if (b?.open) b.toggle(false);
                if (rc.isEditorOpen) rc.toggleEditor();
            }
        } finally {
            S.applying = false;
        }
        S.content = content || null;
    };

    // A presenter changed what they show: tell the room once the change is complete (opening the
    // notes closes the board first: only the final state is sent)
    let queued = false;
    function changed() {
        if (S.applying || !S.started || !amPresenter() || queued) return;
        queued = true;
        queueMicrotask(() => {
            queued = false;
            const content = shown();
            if (content === S.content) return;
            S.content = content;
            rc.socket.emit('stage', { content }, () => {});
        });
    }
    S.changed = changed;

    function ask() {
        rc.socket.emit('stage', { get: true }, (answer) => {
            if (!answer || answer.error) return;
            const content = answer.stage?.content || null;
            // Arriving in a room where nothing is shown leaves the person's own choice alone
            if (content || S.content) S.apply(content);
        });
    }

    S.start = function () {
        if (S.started || typeof rc === 'undefined' || !rc?.socket) return;
        S.started = true;
        const b = board();
        if (b) {
            const toggle = b.toggle;
            b.toggle = function (...args) {
                const result = toggle.apply(this, args);
                changed();
                return result;
            };
        }
        rc.socket.on('stage', (data) => S.apply(data?.content || null));
        rc.socket.on('connect', ask); // back after a cut
        ask();
    };

    const toggleEditor = P.toggleEditor;
    P.toggleEditor = function (...args) {
        const result = toggleEditor.apply(this, args);
        changed();
        return result;
    };

    // The former "open for everyone" messages are replaced by the room's stage
    const editorSendAction = P.editorSendAction;
    P.editorSendAction = function (action) {
        if (action === 'open' || action === 'close') return;
        return editorSendAction.call(this, action);
    };

    if (typeof roomIsReady === 'function') {
        const origRoomIsReady = roomIsReady;
        // eslint-disable-next-line no-global-assign
        roomIsReady = function (...args) {
            const result = origRoomIsReady.apply(this, args);
            try {
                S.start();
            } catch (err) {
                console.error('TLLM stage failed to start', err);
            }
            return result;
        };
    }
})();
