'use strict';

/**
 * TLLM*meet: shared text editor.
 *
 * Replaces MiroTalk's editor sync (whole-document snapshots and raw deltas relayed between
 * browsers) with a Yjs document kept by the server (TllmCollab.js, app/src/Collab.js):
 * several people can type at once without losing text, everyone sees the others' cursors,
 * late joiners get the content, and only the people allowed to share can write.
 */

(() => {
    if (typeof RoomClient === 'undefined' || typeof handleEditor !== 'function') return;

    const $ = (id) => document.getElementById(id);
    const P = RoomClient.prototype;
    const MAX_IMAGE_BYTES = 1024 * 1024;
    const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
    const COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];

    const E = (window.tllmEditor = { quill: null, binding: null, ready: false });

    const colorFor = (name) => {
        let h = 0;
        for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
        return COLORS[h % COLORS.length];
    };

    const tell = (title, text = '') => {
        if (window.tllmRoom?.bubble)
            window.tllmRoom.bubble({ iconCls: 'fas fa-file-pen', title, text, duration: 5000 });
        else console.info(title, text);
    };

    // ####################################################
    // QUILL + YJS
    // ####################################################

    // eslint-disable-next-line no-global-assign
    handleEditor = function () {
        const lib = window.tllmCollab?.lib;
        if (!lib) return console.warn('TLLM*meet: shared editor unavailable');

        Quill.register('modules/cursors', lib.QuillCursors, true);

        quill = new Quill('#editor', {
            theme: 'snow',
            placeholder: 'Écrivez ici. Tout le monde voit le texte en direct.',
            modules: {
                cursors: { hideDelayMs: 4000, transformOnTextChange: true },
                // Undo only what I typed, never the others' text
                history: { userOnly: true },
                toolbar: [
                    [{ header: [1, 2, 3, false] }],
                    ['bold', 'italic', 'underline', 'strike'],
                    [{ list: 'ordered' }, { list: 'bullet' }, { list: 'check' }],
                    ['link', 'blockquote', 'code-block'],
                    ['clean'],
                ],
                uploader: { mimetypes: IMAGE_TYPES, handler: insertImages },
            },
        });
        E.quill = quill;

        // Pasted pictures: web or small embedded images only
        const Delta = Quill.import('delta');
        quill.clipboard.addMatcher('IMG', (node, delta) => {
            const src = node.getAttribute('src') || '';
            const ok =
                /^https?:\/\//i.test(src) ||
                (/^data:image\/(png|jpe?g|gif|webp);/i.test(src) && src.length < MAX_IMAGE_BYTES * 1.4);
            return ok ? delta : new Delta();
        });
        quill.clipboard.addMatcher('IFRAME', () => new Delta());
        quill.clipboard.addMatcher('VIDEO', () => new Delta());

        quill.enable(false);
        decorateHeader();

        const collab = window.tllmCollab;
        const name = rc?.peer_name || (typeof peer_name !== 'undefined' ? peer_name : 'Participant');
        E.binding = new lib.QuillBinding(collab.doc.getText('editor'), quill, collab.awareness);
        collab.on('synced', () => {
            E.ready = true;
            // Opening a room that already has notes: let people know they are there
            if (quill.getLength() > 1 && !rc.isEditorOpen) {
                tell('Des notes partagées existent déjà', 'Retrouvez-les dans le menu Plus.');
            }
            refresh();
        });
        collab.on('writable', refresh);
        collab.on('connection', refresh);
        collab.awareness.on('change', renderPeople);
        collab.start(rc.socket, { name, color: colorFor(name) });
        collab.setWritable(window.tllmRoom?.canShare ? window.tllmRoom.canShare() : !!isPresenter);
        refresh();
    };

    function insertImages(range, files) {
        const ok = files.filter((f) => IMAGE_TYPES.includes(f.type) && f.size <= MAX_IMAGE_BYTES);
        if (ok.length < files.length) tell('Image trop lourde', 'Une image ne doit pas dépasser 1 Mo.');
        let index = range.index;
        ok.forEach((file) => {
            const reader = new FileReader();
            reader.onload = () => {
                quill.insertEmbed(index, 'image', reader.result, 'user');
                index += 1;
                quill.setSelection(index, 0, 'silent');
            };
            reader.readAsDataURL(file);
        });
    }

    function refresh() {
        if (!E.quill) return;
        const collab = window.tllmCollab;
        const canWrite = collab.synced && collab.writable && collab.connected;
        E.quill.enable(canWrite);
        $('editorRoom')?.classList.toggle('tllm-editor-readonly', !collab.writable);
        const status = $('tllmEditorStatus');
        if (!status) return;
        let text = '';
        if (!collab.connected) text = 'Connexion perdue';
        else if (!collab.synced) text = 'Chargement…';
        else if (!collab.writable) text = 'Lecture seule';
        status.textContent = text;
        status.hidden = !text;
    }

    // ####################################################
    // HEADER: title, who is here, status
    // ####################################################

    function decorateHeader() {
        const title = document.querySelector('#editorHeader .editor-title-text');
        if (title) title.textContent = 'Notes partagées';
        const wrap = document.querySelector('#editorHeader .editor-header-title');
        if (!wrap || $('tllmEditorPeople')) return;
        const people = document.createElement('span');
        people.id = 'tllmEditorPeople';
        people.className = 'tllm-editor-people';
        const status = document.createElement('span');
        status.id = 'tllmEditorStatus';
        status.className = 'tllm-editor-status';
        status.hidden = true;
        wrap.append(people, status);
        $('editorRoom')?.setAttribute('translate', 'no');
        $('editorRoom')?.classList.add('notranslate');

        // The notes are left out of the automatic translation (the text is the users'), so the
        // buttons get their French labels here
        const labels = {
            editorUndoBtn: ['fas fa-undo', 'Annuler la frappe'],
            editorRedoBtn: ['fas fa-redo', 'Rétablir'],
            editorCopyBtn: ['fas fa-paste', 'Copier le texte'],
            editorSaveBtn: ['fas fa-floppy-disk', 'Exporter'],
            editorCleanBtn: ['fas fa-trash', 'Tout effacer'],
            editorCloseBtn: ['fas fa-times', 'Fermer'],
        };
        for (const [id, [iconCls, label]] of Object.entries(labels)) {
            const btn = $(id);
            if (!btn) continue;
            btn.setAttribute('aria-label', label);
            if (btn._tippy) btn._tippy.setContent(label);
            else btn.title = label;
            const item = document.querySelector(`#editorHeader [data-panel-action-target="${id}"]`);
            if (item) {
                item.textContent = '';
                const i = document.createElement('i');
                i.className = iconCls;
                item.append(i, ` ${label}`);
            }
        }
        $('editorDropDownMenu')?.setAttribute('aria-label', 'Plus d’actions');
    }

    function renderPeople() {
        const box = $('tllmEditorPeople');
        const collab = window.tllmCollab;
        if (!box || !collab) return;
        box.textContent = '';
        const seen = new Set();
        collab.awareness.getStates().forEach((state, clientId) => {
            const user = state?.user;
            // Only the people who have the editor open (their cursor is in it)
            if (!user || clientId === collab.doc.clientID || !state.cursor || seen.has(user.name)) return;
            seen.add(user.name);
            const dot = document.createElement('span');
            dot.className = 'tllm-editor-dot';
            dot.style.background = /^#[0-9a-f]{6}$/i.test(user.color) ? user.color : '#8a94a6';
            dot.textContent = String(user.name).trim().charAt(0).toUpperCase() || '?';
            dot.title = user.name;
            box.append(dot);
        });
    }

    // ####################################################
    // MIROTALK EDITOR METHODS
    // ####################################################

    // The old sync events are not used any more
    P.editorUpdate = function () {};
    P.handleEditorUpdateData = function () {};
    P.handleEditorData = function () {};
    P.editorIsLocked = () => false;
    P.toggleLockUnlockEditor = function () {};
    P.toggleEditorPrivate = async function () {};
    P.toggleEditorPin = function () {};

    // A presenter opened the editor: open it here too, once. Closing stays personal.
    P.handleEditorActionsData = function (data) {
        if (data?.action === 'open' && !this.isEditorOpen) this.toggleEditor();
    };

    const origToggle = P.toggleEditor;
    P.toggleEditor = function () {
        origToggle.call(this);
        if (this.isEditorOpen && E.quill) setTimeout(() => E.quill.focus(), 50);
        if (this.isEditorOpen) renderPeople();
    };

    P.editorUndo = function () {
        if (window.tllmCollab?.writable) E.quill?.history.undo();
    };
    P.editorRedo = function () {
        if (window.tllmCollab?.writable) E.quill?.history.redo();
    };

    P.editorClean = function () {
        if (!E.quill || !window.tllmCollab?.writable) return;
        if (!E.quill.getText().trim() && E.quill.getLength() <= 1) return;
        Swal.fire({
            background: typeof swalBackground !== 'undefined' ? swalBackground : undefined,
            position: 'center',
            title: 'Tout effacer ?',
            text: 'Le texte disparaît pour tout le monde. Vous pourrez annuler avec le bouton Annuler la frappe.',
            showCancelButton: true,
            confirmButtonText: 'Tout effacer',
            cancelButtonText: 'Garder',
            customClass: { confirmButton: 'swal-destructive' },
        }).then((result) => {
            if (result.isConfirmed) E.quill.deleteText(0, E.quill.getLength(), 'user');
        });
    };

    P.editorCopy = function () {
        const text = E.quill?.getText() || '';
        if (!text.trim()) return;
        navigator.clipboard
            ?.writeText(text)
            .then(() => tell('Texte copié'))
            .catch(() => tell('Copie impossible', 'Sélectionnez le texte et utilisez Ctrl+C.'));
    };

    P.editorSave = function () {
        if (!E.quill) return;
        Swal.fire({
            background: typeof swalBackground !== 'undefined' ? swalBackground : undefined,
            position: 'center',
            title: 'Exporter les notes',
            showDenyButton: true,
            showCancelButton: true,
            confirmButtonText: 'PDF',
            denyButtonText: 'Texte (.txt)',
            cancelButtonText: 'Annuler',
        }).then((result) => {
            if (result.isConfirmed) exportPdf();
            else if (result.isDenied) exportText();
        });
    };

    const fileBase = () => {
        const room = String(rc?.room_id || 'visio').replace(/[^\w-]+/g, '-');
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return `notes-${room}-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };

    function exportText() {
        const blob = new Blob([E.quill.getText()], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${fileBase()}.txt`;
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    // The browser's print dialog makes the PDF ("Enregistrer au format PDF"): real text, the
    // formatting kept, nothing to install
    function exportPdf() {
        const frame = document.createElement('iframe');
        frame.setAttribute('aria-hidden', 'true');
        frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
        document.body.append(frame);
        // Quill 2.0.3 writes every space as &nbsp;, which stops long lines from wrapping
        const html = E.quill.getSemanticHTML().replace(/&nbsp;/g, ' ');
        const title = `Notes de la visio ${rc?.room_id || ''}`.trim();
        const doc = frame.contentDocument;
        doc.open();
        doc.write(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title></title>
<style>
  body { font: 12pt/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #111; margin: 0; }
  h1.doc-title { font-size: 16pt; margin: 0 0 4pt; }
  p.doc-date { color: #666; margin: 0 0 16pt; font-size: 10pt; }
  img { max-width: 100%; }
  pre { background: #f4f4f5; padding: 8pt; white-space: pre-wrap; }
  blockquote { border-left: 3pt solid #ccc; margin: 0; padding-left: 10pt; color: #444; }
  a { color: #1d4ed8; }
  @page { margin: 18mm; }
</style></head><body></body></html>`);
        doc.close();
        doc.title = fileBase();
        const h = doc.createElement('h1');
        h.className = 'doc-title';
        h.textContent = title;
        const p = doc.createElement('p');
        p.className = 'doc-date';
        p.textContent = new Date().toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' });
        const body = doc.createElement('div');
        body.innerHTML = window.filterXSS ? window.filterXSS(html) : html;
        doc.body.append(h, p, body);
        setTimeout(() => {
            frame.contentWindow.focus();
            frame.contentWindow.print();
            setTimeout(() => frame.remove(), 60000);
        }, 200);
    }
})();
