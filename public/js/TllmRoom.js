'use strict';

/**
 * TLLM*meet - meeting screen in the style of Zoom, built on top of MiroTalk's RoomClient.
 *
 * MiroTalk keeps doing the real work (media, signalling, permissions). This file only:
 *  - draws a top strip, a fixed bottom bar and one docked side panel (Discussion, Participants, Sondages),
 *  - drives MiroTalk's own (now hidden) buttons, so every upstream rule still applies,
 *  - replaces the chat, participants and polls views, and the notifications.
 * Kept out of Room.js / RoomClient.js on purpose: upstream updates stay easy to merge.
 */

(function () {
    if (typeof RoomClient === 'undefined') return;

    const $ = (id) => document.getElementById(id);
    const esc = (value) =>
        String(value ?? '').replace(
            /[&<>"']/g,
            (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
        );
    const isShown = (id) => {
        const el = $(id);
        return !!el && !el.classList.contains('hidden') && el.style.display !== 'none';
    };
    const clickId = (id) => $(id)?.click();
    const now = () => new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const amPresenter = () => typeof isPresenter !== 'undefined' && !!isPresenter;
    const isPhone = () => window.matchMedia('(max-width: 720px)').matches;
    const cfg = () => (typeof BUTTONS !== 'undefined' && BUTTONS) || {};

    const COLORS = ['#3b6fd8', '#2f8f6b', '#a0592e', '#7d4bb3', '#b2456e', '#4f7f2f', '#2f7f8f', '#8f6a2f'];
    const colorFor = (name) => {
        let h = 0;
        for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        return COLORS[h % COLORS.length];
    };
    const initials = (name) =>
        String(name || '?')
            .trim()
            .split(/\s+/)
            .map((w) => w[0])
            .slice(0, 2)
            .join('')
            .toUpperCase();

    const icon = (cls) => `<i class="${cls}" aria-hidden="true"></i>`;

    // The shell is written in French and holds what participants type (messages, poll answers, names):
    // MiroTalk's automatic page translation must leave it alone ("Cancel" in a message is not a button)
    const noTranslate = (el) => {
        el.setAttribute('translate', 'no');
        el.classList.add('notranslate');
        return el;
    };

    const T = (window.tllmRoom = {
        started: false,
        panel: null, // 'chat' | 'people' | 'polls'
        chat: [], // { sys } or { fromId, fromName, toId, toName, html, time, private, mine }
        unread: 0,
        to: 'all',
        peers: [], // [{ id, name, audio, video, hand, presenter, you }]
        polls: [],
        pollUnseen: false,
        newPollOpen: false,
        showVoters: {},
        recordingBy: new Set(),
        sharers: new Set(), // participants a presenter allowed to share
    });

    // Screen, whiteboard, editor, files and videos: presenters, and the people they allowed (checked by the server too)
    const canShare = () => amPresenter() || T.sharers.has(rc?.peer_id);
    T.canShare = canShare;

    // ####################################################
    // PATCHES: route MiroTalk's panels and windows to the new layout
    // ####################################################

    const P = RoomClient.prototype;

    // No more windows dragged around the screen, no panel pinned next to the videos by MiroTalk:
    // the side panel and the shared content area are managed by this file
    P.makeDraggable = function () {};
    P.canBePinned = function () {
        return false;
    };

    // Upstream shortcuts and auto-open paths now open the docked panel instead of the old windows
    P.toggleChat = async function () {
        T.togglePanel('chat');
    };
    P.togglePoll = function () {
        T.togglePanel('polls');
    };
    P.toggleShowParticipants = function () {
        T.togglePanel('people');
    };

    // Chat messages (socket and DataChannel) and recording lines land in the new thread
    P.showMessage = async function (data, fromPeer = true) {
        T.onMessage(data, fromPeer);
    };

    // Polls are rendered by the panel (the server sends one view per participant)
    P.pollsUpdate = function (polls) {
        T.onPolls(polls);
    };

    // Role changes: keep upstream behaviour, add a line in the thread
    const origPresenterRole = P.handlePresenterRole;
    P.handlePresenterRole = function (data) {
        origPresenterRole.call(this, data);
        if (data?.peer_name) {
            T.sys(
                data.is_presenter
                    ? `${data.peer_name} est maintenant présentateur`
                    : `${data.peer_name} n'est plus présentateur`
            );
        }
        T.refreshPeersSoon();
        T.renderBar();
    };

    // Sounds: only the raised hand, for presenters (played by this file). Everything else is silent.
    P.sound = async function () {};
    if (typeof sound === 'function') {
        // eslint-disable-next-line no-global-assign
        sound = async function () {};
    }

    // Recording: the chat line, the top badge and one bubble replace the toast and the spoken message
    const origMsgHTML = P.msgHTML;
    P.msgHTML = function (data, ...rest) {
        if (data?.type === 'recording') return;
        return origMsgHTML.call(this, data, ...rest);
    };

    // ####################################################
    // START: once the room is joined
    // ####################################################

    if (typeof roomIsReady === 'function') {
        const origRoomIsReady = roomIsReady;
        // eslint-disable-next-line no-global-assign
        roomIsReady = function (...args) {
            const result = origRoomIsReady.apply(this, args);
            try {
                T.start();
            } catch (err) {
                console.error('TLLM room shell failed to start', err);
            }
            return result;
        };
    }

    T.start = function () {
        if (T.started || typeof rc === 'undefined' || !rc) return;
        T.started = true;
        document.body.classList.add('tllm-room');
        installToastFilter();
        buildShell();
        watchUpstreamButtons();
        watchTiles();
        watchLayout();
        listenToRoom();
        T.refreshPeers();
        T.renderBar();
        setInterval(tick, 1000);
        window.addEventListener('resize', () => {
            closePop();
            T.resizeStage();
        });
        T.resizeStage();
    };

    // ####################################################
    // SHELL
    // ####################################################

    function buildShell() {
        // Stage: MiroTalk's video containers move into it, so their sizing code measures the stage
        const stage = document.createElement('main');
        stage.id = 'tllmStage';
        stage.setAttribute('aria-label', 'Vidéos');
        noTranslate(stage);
        document.body.appendChild(stage);
        ['videoPinMediaContainer', 'videoMediaContainer', 'userEmoji'].forEach((id) => {
            const el = $(id);
            if (el) stage.appendChild(el);
        });
        const reactions = document.createElement('div');
        reactions.id = 'tllmReactions';
        stage.appendChild(reactions);

        const top = document.createElement('header');
        top.id = 'tllmTop';
        noTranslate(top);
        top.innerHTML = `
            <span class="tllm-logo" aria-hidden="true">*</span>
            <span class="tllm-room-name" id="tllmRoomName"></span>
            <span class="tllm-timer" id="tllmTimer"></span>
            <span class="tllm-rec" id="tllmRec" hidden>Enregistrement</span>
            <span class="tllm-spacer"></span>
            <div class="tllm-seg" role="group" aria-label="Affichage">
                <button type="button" id="tllmViewGrid" aria-pressed="true">Grille</button>
                <button type="button" id="tllmViewSpeaker" aria-pressed="false">Orateur</button>
            </div>
            <button type="button" class="tllm-top-btn" id="tllmCopyLink">${icon('fas fa-link')}<span class="tllm-lbl">Copier le lien</span></button>`;
        document.body.appendChild(top);
        $('tllmRoomName').textContent = rc.room_id || '';

        const bar = document.createElement('nav');
        bar.id = 'tllmBar';
        noTranslate(bar);
        bar.setAttribute('aria-label', 'Commandes de la visio');
        bar.innerHTML = `
            <div class="tllm-group">
                <div class="tllm-split">
                    ${barButton('tllmMic', 'fas fa-microphone', 'Micro')}
                    <button type="button" class="tllm-caret" id="tllmMicCaret" aria-label="Choisir le micro et le haut-parleur">${icon('fas fa-chevron-up')}</button>
                </div>
                <div class="tllm-split">
                    ${barButton('tllmCam', 'fas fa-video', 'Caméra')}
                    <button type="button" class="tllm-caret" id="tllmCamCaret" aria-label="Choisir la caméra">${icon('fas fa-chevron-up')}</button>
                </div>
            </div>
            <div class="tllm-group tllm-center">
                ${barButton('tllmShare', 'fas fa-display', "Partager l'écran", 'tllm-desk')}
                ${barButton('tllmHand', 'fas fa-hand', 'Lever la main', 'tllm-desk')}
                ${barButton('tllmReact', 'fas fa-face-smile', 'Réactions', 'tllm-desk')}
                ${barButton('tllmChat', 'fas fa-message', 'Discussion', '', '<span class="tllm-badge" id="tllmChatBadge" hidden></span>')}
                ${barButton('tllmPeople', 'fas fa-user-group', 'Participants', '', '<span class="tllm-count" id="tllmPeopleCount"></span>')}
                ${barButton('tllmPolls', 'fas fa-square-poll-horizontal', 'Sondages', 'tllm-desk', '<span class="tllm-badge" id="tllmPollBadge" hidden>1</span>')}
                ${barButton('tllmMore', 'fas fa-ellipsis', 'Plus')}
            </div>
            <div class="tllm-group">
                <button type="button" class="tllm-leave" id="tllmLeave"><span class="tllm-lbl">Quitter</span>${icon('fas fa-phone-slash')}</button>
            </div>`;
        document.body.appendChild(bar);

        const panel = document.createElement('aside');
        panel.id = 'tllmPanel';
        noTranslate(panel);
        panel.hidden = true;
        panel.setAttribute('aria-labelledby', 'tllmPanelTitle');
        panel.innerHTML = `
            <div class="tllm-panel-head">
                <button type="button" class="tllm-icon-btn tllm-panel-back" id="tllmPanelBack" aria-label="Retour à la visio">${icon('fas fa-arrow-left')}</button>
                <h2 id="tllmPanelTitle"></h2>
                <button type="button" class="tllm-icon-btn tllm-panel-close" id="tllmPanelClose" aria-label="Fermer">${icon('fas fa-xmark')}</button>
            </div>
            <div class="tllm-panel-body" id="tllmPanelBody"></div>
            <div class="tllm-panel-foot" id="tllmPanelFoot"></div>`;
        document.body.appendChild(panel);

        const bubbles = document.createElement('div');
        bubbles.id = 'tllmBubbles';
        noTranslate(bubbles);
        bubbles.setAttribute('aria-live', 'polite');
        document.body.appendChild(bubbles);

        // Bar
        $('tllmMic').onclick = () => clickId(isShown('stopAudioButton') ? 'stopAudioButton' : 'startAudioButton');
        $('tllmCam').onclick = () => clickId(isShown('stopVideoButton') ? 'stopVideoButton' : 'startVideoButton');
        $('tllmMicCaret').onclick = (e) => deviceMenu(e.currentTarget, 'audio');
        $('tllmCamCaret').onclick = (e) => deviceMenu(e.currentTarget, 'video');
        $('tllmShare').onclick = toggleShare;
        $('tllmHand').onclick = toggleHand;
        $('tllmReact').onclick = (e) => reactionsMenu(e.currentTarget);
        $('tllmChat').onclick = () => T.togglePanel('chat');
        $('tllmPeople').onclick = () => T.togglePanel('people');
        $('tllmPolls').onclick = () => T.togglePanel('polls');
        $('tllmMore').onclick = (e) => moreMenu(e.currentTarget);
        $('tllmLeave').onclick = (e) => leaveMenu(e.currentTarget);
        $('tllmPanelClose').onclick = () => T.togglePanel(T.panel);
        $('tllmPanelBack').onclick = () => T.togglePanel(T.panel);

        // Top strip
        $('tllmViewGrid').onclick = () => setView('grid');
        $('tllmViewSpeaker').onclick = () => setView('speaker-top');
        $('tllmCopyLink').onclick = copyLink;

        document.addEventListener('click', onDocumentClick);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closePop();
        });
    }

    function barButton(id, iconCls, label, extra = '', after = '') {
        return `<button type="button" class="tllm-bb ${extra}" id="${id}" aria-pressed="false">
            <span class="tllm-ic">${icon(iconCls)}</span><span class="tllm-lb">${label}</span>${after}</button>`;
    }

    function setIcon(btn, cls) {
        const ic = btn?.querySelector('.tllm-ic');
        if (ic) ic.innerHTML = icon(cls);
    }

    T.renderBar = function () {
        if (!T.started) return;
        const micOn = isShown('stopAudioButton');
        const camOn = isShown('stopVideoButton');
        const sharing = isShown('stopScreenButton');
        const hand = isShown('lowerHandButton');

        const mic = $('tllmMic');
        mic.classList.toggle('tllm-off', !micOn);
        setIcon(mic, micOn ? 'fas fa-microphone' : 'fas fa-microphone-slash');
        mic.querySelector('.tllm-lb').textContent = micOn ? 'Micro' : 'Micro coupé';
        mic.disabled = !isShown('stopAudioButton') && !isShown('startAudioButton');

        const cam = $('tllmCam');
        cam.classList.toggle('tllm-off', !camOn);
        setIcon(cam, camOn ? 'fas fa-video' : 'fas fa-video-slash');
        cam.querySelector('.tllm-lb').textContent = camOn ? 'Caméra' : 'Caméra coupée';
        cam.disabled = !isShown('stopVideoButton') && !isShown('startVideoButton');

        const share = $('tllmShare');
        share.hidden = !canShare() || (!isShown('startScreenButton') && !isShown('stopScreenButton'));
        document.body.classList.toggle('tllm-cannot-share', !canShare());
        window.tllmCollab?.setWritable(canShare());
        share.setAttribute('aria-pressed', String(sharing));
        share.querySelector('.tllm-lb').textContent = sharing ? 'Arrêter le partage' : "Partager l'écran";

        const handBtn = $('tllmHand');
        handBtn.hidden = !isShown('raiseHandButton') && !isShown('lowerHandButton');
        handBtn.setAttribute('aria-pressed', String(hand));
        handBtn.classList.toggle('tllm-hand-on', hand);
        handBtn.querySelector('.tllm-lb').textContent = hand ? 'Baisser la main' : 'Lever la main';

        $('tllmChat').setAttribute('aria-pressed', String(T.panel === 'chat'));
        $('tllmPeople').setAttribute('aria-pressed', String(T.panel === 'people'));
        $('tllmPolls').setAttribute('aria-pressed', String(T.panel === 'polls'));
        $('tllmPolls').hidden = cfg().main?.pollButton === false;

        const badge = $('tllmChatBadge');
        badge.hidden = !T.unread || T.panel === 'chat';
        badge.textContent = T.unread > 9 ? '9+' : String(T.unread);
        $('tllmPollBadge').hidden = !T.pollUnseen || T.panel === 'polls';
        $('tllmPeopleCount').textContent = T.peers.length ? String(T.peers.length) : '';

        const recording = T.recordingBy.size > 0 || (rc.isRecording && rc.isRecording());
        $('tllmRec').hidden = !recording;
    };

    // Upstream buttons change state through their "hidden" class: follow them
    function watchUpstreamButtons() {
        const ids = [
            'startAudioButton',
            'stopAudioButton',
            'startVideoButton',
            'stopVideoButton',
            'startScreenButton',
            'stopScreenButton',
            'raiseHandButton',
            'lowerHandButton',
            'startRecButton',
            'stopRecButton',
        ];
        const observer = new MutationObserver(() => T.renderBar());
        ids.forEach((id) => {
            const el = $(id);
            if (el) observer.observe(el, { attributes: true, attributeFilter: ['class', 'style', 'disabled'] });
        });
    }

    function tick() {
        const time = $('sessionTime')?.innerText?.trim();
        if (time && $('tllmTimer')) $('tllmTimer').textContent = time;
    }

    T.resizeStage = function () {
        requestAnimationFrame(() => {
            if (typeof resizeVideoMedia === 'function') resizeVideoMedia();
            if (typeof wbIsOpen !== 'undefined' && wbIsOpen && typeof setupWhiteboardCanvasSize === 'function') {
                setupWhiteboardCanvasSize();
            }
        });
    };

    // Whiteboard and editor are shown in the video area (videos become a strip on top);
    // captions take the place of the side panel
    function syncLayout() {
        const wb = $('whiteboard')?.classList.contains('show') || window.tllmBoard?.open;
        const editor = $('editorRoom')?.classList.contains('show');
        const captions = $('transcriptionRoom')?.style.display === 'block';
        document.body.classList.toggle('tllm-content', !!(wb || editor));
        document.body.classList.toggle('tllm-captions-open', !!captions);
        document.body.classList.toggle('tllm-panel-open', !!T.panel || !!captions);
        T.resizeStage();
    }
    T.syncLayout = syncLayout;

    function watchLayout() {
        const observer = new MutationObserver(syncLayout);
        ['whiteboard', 'editorRoom', 'transcriptionRoom'].forEach((id) => {
            const el = $(id);
            if (el) observer.observe(el, { attributes: true, attributeFilter: ['class', 'style'] });
        });
    }

    // Free area for shared content, in viewport pixels
    function contentBox() {
        const stage = $('tllmStage');
        const r = stage ? stage.getBoundingClientRect() : { left: 0, top: 0, width: innerWidth, height: innerHeight };
        const strip = isPhone() ? 84 : 120;
        return { left: r.left + 8, top: r.top + strip, width: r.width - 16, height: r.height - strip - 8 };
    }

    if (typeof setupWhiteboardCanvasSize === 'function') {
        const origWbSize = setupWhiteboardCanvasSize;
        // eslint-disable-next-line no-global-assign
        setupWhiteboardCanvasSize = function () {
            if (!T.started || typeof wbCanvas === 'undefined' || !wbCanvas) return origWbSize();
            const box = contentBox();
            const padding = isPhone() ? 10 : 20;
            const header = isPhone() ? 40 : 60;
            const scale = Math.max(
                0.1,
                Math.min((box.width - padding) / wbReferenceWidth, (box.height - padding - header) / wbReferenceHeight)
            );
            const w = wbReferenceWidth * scale;
            const h = wbReferenceHeight * scale;
            wbCanvas.setWidth(w);
            wbCanvas.setHeight(h);
            wbCanvas.setZoom(scale);
            setWhiteboardSize(w + padding, h + header + padding);
            whiteboardCenter();
            wbCanvas.calcOffset();
            wbCanvas.renderAll();
            if (typeof wbRepositionParticipantLabels === 'function') wbRepositionParticipantLabels();
        };
    }
    if (typeof whiteboardCenter === 'function') {
        const origWbCenter = whiteboardCenter;
        // eslint-disable-next-line no-global-assign
        whiteboardCenter = function () {
            if (!T.started) return origWbCenter();
            const box = contentBox();
            const wb = $('whiteboard');
            wb.style.top = `${box.top + box.height / 2}px`;
            wb.style.left = `${box.left + box.width / 2}px`;
            wb.style.transform = 'translate(-50%, -50%)';
        };
    }

    function setView(mode) {
        if (typeof setParticipantViewMode === 'function') setParticipantViewMode(mode);
        $('tllmViewGrid').setAttribute('aria-pressed', String(mode === 'grid'));
        $('tllmViewSpeaker').setAttribute('aria-pressed', String(mode !== 'grid'));
        T.resizeStage();
    }

    function copyLink() {
        const url = `${location.origin}/join/${encodeURIComponent(rc.room_id)}`;
        const label = $('tllmCopyLink').querySelector('.tllm-lbl');
        const done = () => {
            label.textContent = 'Lien copié';
            setTimeout(() => (label.textContent = 'Copier le lien'), 1600);
        };
        if (navigator.clipboard?.writeText)
            navigator.clipboard.writeText(url).then(done, () => prompt('Lien de la visio', url));
        else prompt('Lien de la visio', url);
    }

    function toggleShare() {
        clickId(isShown('stopScreenButton') ? 'stopScreenButton' : 'startScreenButton');
    }

    function toggleHand() {
        clickId(isShown('lowerHandButton') ? 'lowerHandButton' : 'raiseHandButton');
        T.refreshPeersSoon();
    }

    // ####################################################
    // POPOVER MENUS
    // ####################################################

    let openPop = null;

    function closePop() {
        if (!openPop) return;
        openPop.el.remove();
        openPop.anchor?.setAttribute('aria-expanded', 'false');
        openPop = null;
    }

    function showPop(anchor, html, { align = 'center', key } = {}) {
        if (openPop && openPop.key === key) return closePop();
        closePop();
        const el = document.createElement('div');
        el.className = 'tllm-pop';
        noTranslate(el);
        el.setAttribute('role', 'menu');
        el.innerHTML = html;
        document.body.appendChild(el);
        const r = anchor.getBoundingClientRect();
        const pw = el.offsetWidth;
        const ph = el.offsetHeight;
        let left = align === 'right' ? r.right - pw : align === 'left' ? r.left : r.left + r.width / 2 - pw / 2;
        left = Math.max(12, Math.min(left, window.innerWidth - pw - 12));
        let topPos = r.top - ph - 8;
        if (topPos < 12) topPos = r.bottom + 8;
        el.style.left = `${left}px`;
        el.style.top = `${Math.max(12, Math.min(topPos, window.innerHeight - ph - 12))}px`;
        anchor.setAttribute('aria-expanded', 'true');
        openPop = { el, anchor, key };
        return el;
    }

    const item = (act, iconCls, label, extra = '', checked = false) =>
        `<button type="button" class="tllm-item ${extra}" data-act="${act}" role="menuitem"><span class="tllm-item-ic">${icon(
            iconCls
        )}</span><span class="tllm-item-lb">${esc(label)}</span>${checked ? `<span class="tllm-check">${icon('fas fa-check')}</span>` : ''}</button>`;
    const heading = (text) => `<h4>${esc(text)}</h4>`;

    // Device menus list the options of MiroTalk's own selects (in the settings) and drive them
    function deviceMenu(anchor, kind) {
        const options = (selectId) => {
            const select = $(selectId);
            if (!select || !select.options.length) return '';
            return [...select.options]
                .map((o) =>
                    item(
                        `dev:${selectId}:${o.value}`,
                        'fas fa-circle-dot tllm-dot',
                        o.text || 'Appareil',
                        '',
                        o.value === select.value
                    )
                )
                .join('');
        };
        let html = '';
        if (kind === 'audio') {
            html +=
                heading('Micro') + (options('microphoneSelect') || `<p class="tllm-pop-empty">Aucun micro détecté</p>`);
            const speakers = options('speakerSelect');
            if (speakers) html += heading('Haut-parleur') + speakers;
            html += '<hr>' + item('settings:tabAudioDevicesBtn', 'fas fa-sliders', 'Réglages audio');
        } else {
            html +=
                heading('Caméra') + (options('videoSelect') || `<p class="tllm-pop-empty">Aucune caméra détectée</p>`);
            html += '<hr>';
            if (isShown('swapCameraButton'))
                html += item('click:swapCameraButton', 'fas fa-camera-rotate', 'Changer de caméra');
            if (cfg().settings?.virtualBackground !== false)
                html += item('settings:tabVirtualBackgroundBtn', 'fas fa-image', 'Arrière-plan flou ou image');
            html += item('settings:tabVideoDevicesBtn', 'fas fa-sliders', 'Réglages vidéo');
        }
        showPop(anchor, html, { align: 'left', key: 'dev-' + kind });
    }

    function moreMenu(anchor) {
        let html = '';
        if (isPhone()) {
            if (!$('tllmShare').hidden)
                html += item(
                    'share',
                    'fas fa-display',
                    isShown('stopScreenButton') ? 'Arrêter le partage' : "Partager l'écran"
                );
            if (!$('tllmHand').hidden)
                html += item('hand', 'fas fa-hand', isShown('lowerHandButton') ? 'Baisser la main' : 'Lever la main');
            html += item('react', 'fas fa-face-smile', 'Réactions');
            if (!$('tllmPolls').hidden) html += item('polls', 'fas fa-square-poll-horizontal', 'Sondages');
            html += '<hr>';
        }
        const speaker = $('tllmViewSpeaker').getAttribute('aria-pressed') === 'true';
        html += heading('Affichage');
        html += item('view:grid', 'fas fa-table-cells-large', 'Grille', '', !speaker);
        html += item('view:speaker-top', 'fas fa-square', 'Orateur en grand', '', speaker);
        if (isShown('fullScreenButton')) html += item('click:fullScreenButton', 'fas fa-expand', 'Plein écran');

        let share = '';
        if (isShown('whiteboardButton')) share += item('click:whiteboardButton', 'fas fa-chalkboard', 'Tableau blanc');
        if (isShown('editorButton')) share += item('click:editorButton', 'fas fa-file-pen', 'Notes partagées');
        if (isShown('fileShareExtraButton'))
            share += item('click:fileShareExtraButton', 'fas fa-paperclip', 'Envoyer un fichier');
        if ($('tabVideoShareBtn') && cfg().settings?.tabVideoShareBtn !== false)
            share += item('settings:tabVideoShareBtn', 'fab fa-youtube', 'Partager une vidéo');
        // Nothing to share without the permission of a presenter
        if (share && canShare()) html += heading('Partager') + share;

        let meeting = '';
        // Without the right to share, the notes can still be read
        if (!canShare() && isShown('whiteboardButton'))
            meeting += item('click:whiteboardButton', 'fas fa-chalkboard', 'Voir le tableau blanc');
        if (!canShare() && isShown('editorButton'))
            meeting += item('click:editorButton', 'fas fa-file-lines', 'Lire les notes partagées');
        if (isShown('transcriptionButton'))
            meeting += item('click:transcriptionButton', 'fas fa-closed-captioning', 'Sous-titres');
        if (amPresenter() && isShown('startRecButton'))
            meeting += item('click:startRecButton', 'fas fa-circle-dot', 'Enregistrer');
        if (isShown('stopRecButton'))
            meeting += item('click:stopRecButton', 'fas fa-circle-stop', "Arrêter l'enregistrement");
        if (isShown('breakoutRoomButton'))
            meeting += item('click:breakoutRoomButton', 'fas fa-people-arrows', 'Salles de sous-groupe');
        meeting += item('settings:', 'fas fa-gear', 'Paramètres');
        html += heading('Réunion') + meeting;
        showPop(anchor, html, { align: 'center', key: 'more' });
    }

    function leaveMenu(anchor) {
        let html = item('leave', 'fas fa-right-from-bracket', 'Quitter la visio', amPresenter() ? '' : 'tllm-danger');
        if (amPresenter() && T.peers.length > 1) {
            html += item('leaveAll', 'fas fa-power-off', 'Terminer pour tout le monde', 'tllm-danger');
        }
        showPop(anchor, html, { align: 'right', key: 'leave' });
    }

    const REACTIONS = [
        ['👏', ':clap:'],
        ['👍', ':+1:'],
        ['❤️', ':heart:'],
        ['😂', ':joy:'],
        ['😮', ':open_mouth:'],
        ['🎉', ':tada:'],
    ];

    function reactionsMenu(anchor) {
        const html = `<div class="tllm-reactions">${REACTIONS.map(
            ([e]) => `<button type="button" data-emoji="${e}" aria-label="Réagir ${e}">${e}</button>`
        ).join('')}</div>`;
        showPop(anchor, html, { align: 'center', key: 'react' });
    }

    function sendReaction(emoji) {
        const shortcodes = (REACTIONS.find(([e]) => e === emoji) || [])[1] || '';
        const cmd = {
            type: 'roomEmoji',
            peer_name: rc.peer_name,
            peer_id: rc.peer_id,
            emoji,
            shortcodes,
            broadcast: true,
        };
        if (rc.thereAreParticipants()) rc.emitCmd(cmd);
        floatReaction(emoji, rc.peer_id, rc.peer_name);
    }

    function openSettings(tabId) {
        if (!rc.isMySettingsOpen) clickId('settingsButton');
        if (tabId) setTimeout(() => clickId(tabId), 50);
    }

    function handleAct(act) {
        closePop();
        if (act.startsWith('dev:')) {
            const [, selectId, ...rest] = act.split(':');
            const select = $(selectId);
            if (select) {
                select.value = rest.join(':');
                select.dispatchEvent(new Event('change', { bubbles: true }));
            }
            return;
        }
        if (act.startsWith('click:')) return clickId(act.slice(6));
        if (act.startsWith('settings:')) return openSettings(act.slice(9));
        if (act.startsWith('view:')) return setView(act.slice(5));
        if (act === 'share') return toggleShare();
        if (act === 'hand') return toggleHand();
        if (act === 'react') return reactionsMenu($('tllmMore'));
        if (act === 'polls') return T.togglePanel('polls');
        if (act === 'leave') return typeof leaveRoom === 'function' && leaveRoom();
        if (act === 'leaveAll') return typeof leaveRoom === 'function' && leaveRoom(true, true);
        if (act.startsWith('pm:')) return startPrivate(act.slice(3));
        if (act.startsWith('mute:')) return rc.peerAction('me', act.slice(5), 'mute', true, false);
        if (act.startsWith('role:')) {
            const [, id, grant] = act.split(':');
            return rc.setPresenterRole(id, grant === '1');
        }
        if (act.startsWith('eject:')) return rc.peerAction('me', act.slice(6), 'eject', true, false);
        if (act.startsWith('share:')) {
            const [, id, allowed] = act.split(':');
            return rc.socket.emit('setSharePermission', { peer_id: id, allowed: allowed === '1' });
        }
        if (act.startsWith('pin:')) {
            const tile = document.querySelector(
                `#videoMediaContainer .Camera[data-peer-id="${CSS.escape(act.slice(4))}"]`
            );
            tile?.querySelector('[id$="__pin"]')?.click();
            return;
        }
    }

    function peerMenu(anchor, peerId) {
        const peer = T.peers.find((p) => p.id === peerId);
        if (!peer || peer.you) return;
        let html = item(`pm:${peer.id}`, 'fas fa-message', 'Message privé');
        if (anchor.closest('.Camera')) html += item(`pin:${peer.id}`, 'fas fa-thumbtack', 'Épingler');
        if (amPresenter()) {
            html += '<hr>';
            html += item(
                `mute:${peer.id}`,
                'fas fa-microphone-slash',
                peer.audio ? 'Couper son micro' : "Lui demander d'activer son micro"
            );
            html += peer.presenter
                ? item(`role:${peer.id}:0`, 'fas fa-person-chalkboard', 'Retirer le rôle de présentateur')
                : item(`role:${peer.id}:1`, 'fas fa-person-chalkboard', 'Rendre présentateur');
            if (!peer.presenter) {
                html += T.sharers.has(peer.id)
                    ? item(`share:${peer.id}:0`, 'fas fa-display', 'Ne plus autoriser à partager')
                    : item(`share:${peer.id}:1`, 'fas fa-display', 'Autoriser à partager');
            }
            html += item(`eject:${peer.id}`, 'fas fa-right-from-bracket', 'Retirer de la visio', 'tllm-danger');
        }
        showPop(anchor, html, { align: 'right', key: 'peer-' + peer.id });
    }

    function onDocumentClick(e) {
        const t = e.target;
        if (!(t instanceof Element)) return;
        const act = t.closest('.tllm-pop [data-act]');
        if (act) return handleAct(act.dataset.act);
        const emoji = t.closest('.tllm-pop [data-emoji]');
        if (emoji) {
            closePop();
            return sendReaction(emoji.dataset.emoji);
        }
        const more = t.closest('[data-tllm-peer]');
        if (more) return peerMenu(more, more.dataset.tllmPeer);
        if (openPop && !openPop.el.contains(t) && !openPop.anchor.contains(t)) closePop();
    }

    // ####################################################
    // SIDE PANEL
    // ####################################################

    T.togglePanel = function (name) {
        if (!T.started) return;
        T.panel = T.panel === name ? null : name;
        if (T.panel === 'chat') T.unread = 0;
        if (T.panel === 'polls') T.pollUnseen = false;
        $('tllmPanel').hidden = !T.panel;
        if (T.panel === 'people') T.refreshPeers();
        renderPanel();
        T.renderBar();
        syncLayout();
    };

    function renderPanel() {
        if (!T.panel) return;
        const titles = {
            chat: 'Discussion',
            people: `Participants (${T.peers.length})`,
            polls: 'Sondages',
        };
        $('tllmPanelTitle').textContent = titles[T.panel];
        if (T.panel === 'chat') renderChat();
        if (T.panel === 'people') renderPeople();
        if (T.panel === 'polls') renderPolls();
    }

    // ---------------- Discussion ----------------

    T.sys = function (text) {
        T.chat.push({ sys: text, time: now() });
        if (T.panel === 'chat') renderChatList();
    };

    T.onMessage = function (data, fromPeer) {
        // Recording start/stop lines from MiroTalk ("🔴 action")
        if (!fromPeer && typeof data.peer_msg === 'string' && data.peer_msg.startsWith('🔴')) {
            const action = data.peer_msg.replace('🔴', '').trim().toLowerCase();
            const stopped = /stop|arr/.test(action);
            if (stopped) T.recordingBy.delete(data.peer_id);
            else T.recordingBy.add(data.peer_id);
            T.sys(`${data.peer_name} a ${stopped ? 'arrêté' : 'démarré'} l'enregistrement`);
            if (!stopped) {
                bubble({
                    iconCls: 'fas fa-circle-dot',
                    title: `${data.peer_name === rc.peer_name ? 'Vous enregistrez' : data.peer_name + ' enregistre'} la visio`,
                    text: 'Rester dans la visio vaut accord pour être enregistré.',
                    cls: 'tllm-bubble-rec',
                    duration: 8000,
                });
            }
            T.renderBar();
            return;
        }
        const isPrivate = data.to_peer_id && data.to_peer_id !== 'all';
        T.chat.push({
            fromId: data.peer_id,
            fromName: data.peer_name,
            toId: data.to_peer_id,
            toName: data.to_peer_name,
            html: typeof filterXSS === 'function' ? filterXSS(String(data.peer_msg || '')) : esc(data.peer_msg),
            time: now(),
            private: isPrivate,
        });
        if (T.panel === 'chat') return renderChatList();
        T.unread++;
        T.renderBar();
        bubble({
            name: data.peer_name,
            title: isPrivate ? `${data.peer_name} · privé` : data.peer_name,
            text: textOf(data.peer_msg),
            onClick: () => {
                if (isPrivate) T.to = data.peer_id;
                if (T.panel !== 'chat') T.togglePanel('chat');
            },
        });
    };

    function textOf(html) {
        const div = document.createElement('div');
        div.innerHTML = typeof filterXSS === 'function' ? filterXSS(String(html || '')) : esc(html);
        return (div.textContent || '').trim() || 'Pièce jointe';
    }

    function renderChat() {
        renderChatList();
        renderChatCompose();
    }

    function renderChatList() {
        const body = $('tllmPanelBody');
        if (T.panel !== 'chat' || !body) return;
        const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
        if (!T.chat.length) {
            body.innerHTML = `<p class="tllm-empty">Aucun message pour l'instant.<br>Écrivez à tout le monde ou en privé à une personne.</p>`;
            return;
        }
        body.innerHTML = T.chat
            .map((m) => {
                if (m.sys) return `<p class="tllm-sys">${esc(m.sys)}</p>`;
                const who = m.mine ? 'Vous' : m.fromName;
                const tag = m.private
                    ? `<span class="tllm-private-tag">Privé${m.mine ? ' · à ' + esc(m.toName) : ''}</span>`
                    : '';
                return `<div class="tllm-msg${m.private ? ' tllm-private' : ''}">
                    <div class="tllm-msg-meta"><span class="tllm-who">${esc(who)}</span>${tag}<span>${esc(m.time)}</span></div>
                    <div class="tllm-msg-txt">${m.html}</div>
                </div>`;
            })
            .join('');
        body.querySelectorAll('.tllm-msg-txt a').forEach((a) => {
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
        });
        if (atBottom || T.chat[T.chat.length - 1]?.mine) body.scrollTop = body.scrollHeight;
    }

    function renderChatCompose() {
        const foot = $('tllmPanelFoot');
        const others = T.peers.filter((p) => !p.you);
        if (T.to !== 'all' && !others.some((p) => p.id === T.to)) T.to = 'all';
        const options = ['<option value="all">Tout le monde</option>']
            .concat(others.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (privé)</option>`))
            .join('');
        const draft = $('tllmChatInput')?.value || '';
        foot.innerHTML = `
            <div class="tllm-to-row"><label for="tllmTo">À</label><select id="tllmTo">${options}</select></div>
            <div class="tllm-compose">
                ${canShare() && isShown('fileShareExtraButton') ? `<button type="button" class="tllm-icon-btn" id="tllmAttachBtn" aria-label="Envoyer un fichier">${icon('fas fa-paperclip')}</button>` : ''}
                <textarea id="tllmChatInput" rows="1" placeholder="Écrire un message…" aria-label="Message" maxlength="4000"></textarea>
                <button type="button" class="tllm-send" id="tllmSendBtn" aria-label="Envoyer">${icon('fas fa-paper-plane')}</button>
            </div>`;
        const input = $('tllmChatInput');
        input.value = draft;
        $('tllmTo').value = T.to;
        $('tllmTo').onchange = (e) => (T.to = e.target.value);
        $('tllmSendBtn').onclick = sendChat;
        input.onkeydown = (e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                sendChat();
            }
        };
        input.oninput = () => {
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 120) + 'px';
        };
        if ($('tllmAttachBtn')) $('tllmAttachBtn').onclick = () => clickId('fileShareExtraButton');
    }

    let lastSent = 0;
    function sendChat() {
        const input = $('tllmChatInput');
        const text = (input?.value || '').trim();
        if (!text) return;
        const isPublic = T.to === 'all';
        if (isPublic && rc._moderator?.chat_cant_publicly) return T.sys("L'admin a désactivé la discussion publique.");
        if (!isPublic && rc._moderator?.chat_cant_privately) return T.sys("L'admin a désactivé les messages privés.");
        if (Date.now() - lastSent < (rc.chatMessageTimeBetween || 1000)) return;
        lastSent = Date.now();

        const target = T.peers.find((p) => p.id === T.to);
        const peer_msg = rc.formatMsg(text);
        if (!peer_msg) return;
        const data = {
            room_id: rc.room_id,
            peer_name: rc.peer_name,
            peer_avatar: rc.peer_avatar,
            peer_id: rc.peer_id,
            to_peer_id: isPublic ? 'all' : T.to,
            to_peer_name: isPublic ? 'all' : target?.name || '',
            peer_msg,
            msg_id: `${rc.peer_id}_${Date.now()}`,
        };
        rc.socket.emit('message', data);
        T.chat.push({
            fromId: rc.peer_id,
            fromName: rc.peer_name,
            toId: data.to_peer_id,
            toName: data.to_peer_name,
            html: typeof filterXSS === 'function' ? filterXSS(peer_msg) : esc(text),
            time: now(),
            private: !isPublic,
            mine: true,
        });
        input.value = '';
        input.style.height = '';
        renderChatList();
        input.focus();
    }

    function startPrivate(peerId) {
        T.to = peerId;
        if (T.panel !== 'chat') T.togglePanel('chat');
        else renderChatCompose();
        $('tllmChatInput')?.focus();
    }

    // ---------------- Participants ----------------

    let refreshTimer = null;
    T.refreshPeersSoon = function () {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(T.refreshPeers, 250);
    };

    T.refreshPeers = async function () {
        if (!rc?.socket) return;
        let room;
        try {
            room = await rc.getRoomInfo();
        } catch {
            return;
        }
        if (!room?.peers) return;
        const previous = new Map(T.peers.map((p) => [p.id, p]));
        T.sharers = new Set(Array.isArray(room.sharers) ? room.sharers : []);
        const entries = new Map(JSON.parse(room.peers));
        T.peers = [...entries.entries()].map(([id, peer]) => {
            const info = peer.peer_info || peer;
            return {
                id,
                name: info.peer_name || peer.peer_name || '?',
                audio: !!info.peer_audio,
                video: !!info.peer_video,
                hand: !!info.peer_hand,
                presenter: !!info.peer_presenter,
                you: id === rc.peer_id,
            };
        });
        // Remote hand raised: discreet bubble and sound, for presenters only
        T.peers.forEach((p) => {
            const before = previous.get(p.id);
            if (!p.you && p.hand && before && !before.hand && amPresenter()) handRaised(p);
        });
        T.renderBar();
        if (T.panel === 'people') renderPeople();
        if (T.panel === 'chat') renderChatCompose();
        if (T.panel)
            $('tllmPanelTitle').textContent =
                T.panel === 'people' ? `Participants (${T.peers.length})` : $('tllmPanelTitle').textContent;
        decorateTiles();
    };

    function renderPeople() {
        const body = $('tllmPanelBody');
        const filter = (T.filter || '').toLowerCase();
        const list = T.peers.filter((p) => p.name.toLowerCase().includes(filter));
        const hands = list.filter((p) => p.hand);
        const rest = list
            .filter((p) => !p.hand)
            .sort((a, b) => Number(b.you) - Number(a.you) || Number(b.presenter) - Number(a.presenter));
        const row = (p) => `<div class="tllm-prow">
                <span class="tllm-avatar" style="background:${colorFor(p.name)}">${esc(initials(p.name))}</span>
                <span class="tllm-pname">${esc(p.name)} <span class="tllm-role">${p.you ? 'Vous' : ''}${p.you && p.presenter ? ' · ' : ''}${p.presenter ? 'présentateur' : ''}</span></span>
                <span class="tllm-st">
                    ${p.hand ? `<span class="tllm-st-hand">${icon('fas fa-hand')}</span>` : ''}
                    ${!p.presenter && T.sharers.has(p.id) ? `<span title="Peut partager">${icon('fas fa-display')}</span>` : ''}
                    <span class="${p.audio ? '' : 'tllm-st-off'}" title="${p.audio ? 'Micro actif' : 'Micro coupé'}">${icon(p.audio ? 'fas fa-microphone' : 'fas fa-microphone-slash')}</span>
                    <span class="${p.video ? '' : 'tllm-st-off'}" title="${p.video ? 'Caméra active' : 'Caméra coupée'}">${icon(p.video ? 'fas fa-video' : 'fas fa-video-slash')}</span>
                </span>
                ${p.you ? '' : `<button type="button" class="tllm-icon-btn" data-tllm-peer="${esc(p.id)}" aria-label="Options pour ${esc(p.name)}">${icon('fas fa-ellipsis')}</button>`}
            </div>`;
        const search = $('tllmSearch');
        const hadFocus = document.activeElement === search;
        body.innerHTML = `
            <input class="tllm-search" id="tllmSearch" type="search" placeholder="Rechercher" aria-label="Rechercher un participant" value="${esc(T.filter || '')}">
            ${hands.length ? `<p class="tllm-section">Main levée (${hands.length})</p>${hands.map(row).join('')}` : ''}
            <p class="tllm-section">Dans la visio (${rest.length})</p>${rest.map(row).join('')}`;
        const newSearch = $('tllmSearch');
        newSearch.oninput = (e) => {
            T.filter = e.target.value;
            renderPeople();
        };
        if (hadFocus) {
            newSearch.focus();
            newSearch.setSelectionRange(newSearch.value.length, newSearch.value.length);
        }
        let foot = `<button type="button" id="tllmCopyLink2">${icon('fas fa-link')} Copier le lien</button>`;
        if (amPresenter() && T.peers.length > 1)
            foot += `<button type="button" id="tllmMuteAll">${icon('fas fa-microphone-slash')} Couper tous les micros</button>`;
        $('tllmPanelFoot').innerHTML = `<div class="tllm-foot-actions">${foot}</div>`;
        $('tllmCopyLink2').onclick = copyLink;
        if ($('tllmMuteAll')) $('tllmMuteAll').onclick = () => rc.peerAction('me', rc.peer_id, 'mute', true, true);
    }

    // Tiles: one "⋯" menu per remote participant, the rest of MiroTalk's tile toolbar is hidden by CSS
    function decorateTiles() {
        document.querySelectorAll('#videoMediaContainer .Camera[data-peer-id]').forEach((tile) => {
            const peerId = tile.dataset.peerId;
            if (peerId === rc.peer_id || tile.querySelector('.tllm-tile-more')) return;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'tllm-tile-more';
            btn.dataset.tllmPeer = peerId;
            const peer = T.peers.find((p) => p.id === peerId);
            btn.setAttribute('aria-label', `Options pour ${peer ? peer.name : 'ce participant'}`);
            btn.innerHTML = icon('fas fa-ellipsis');
            tile.appendChild(btn);
        });
    }

    function watchTiles() {
        const container = $('videoMediaContainer');
        if (!container) return;
        new MutationObserver(() => {
            decorateTiles();
        }).observe(container, { childList: true });
    }

    // Join / leave / state changes from the server
    function listenToRoom() {
        const names = () => new Map(T.peers.map((p) => [p.id, p.name]));
        rc.socket.on('refreshParticipantsCount', async () => {
            const before = names();
            await T.refreshPeers();
            T.peers.filter((p) => !before.has(p.id) && !p.you).forEach((p) => T.sys(`${p.name} a rejoint la visio`));
        });
        rc.socket.on('removeMe', (data) => {
            if (data?.peer_name) T.sys(`${data.peer_name} a quitté la visio`);
            T.refreshPeersSoon();
        });
        rc.socket.on('updatePeerInfo', () => T.refreshPeersSoon());
        rc.socket.on('sharePermission', (data) => {
            if (!data?.peer_id) return;
            if (data.allowed) T.sharers.add(data.peer_id);
            else T.sharers.delete(data.peer_id);
            const mine = data.peer_id === rc.peer_id;
            if (mine) {
                T.sys(data.allowed ? 'Vous pouvez maintenant partager' : 'Vous ne pouvez plus partager');
                bubble({
                    iconCls: 'fas fa-display',
                    title: data.allowed ? 'Vous pouvez maintenant partager' : 'Vous ne pouvez plus partager',
                    text: data.allowed ? 'Écran, tableau blanc, éditeur et fichiers' : '',
                    duration: 6000,
                });
                if (!data.allowed && isShown('stopScreenButton')) clickId('stopScreenButton');
            } else {
                T.sys(`${data.peer_name} ${data.allowed ? 'peut maintenant partager' : 'ne peut plus partager'}`);
            }
            T.renderBar();
            if (T.panel) renderPanel();
        });
        rc.socket.on('setVideoOff', () => T.refreshPeersSoon());
    }

    // ---------------- Polls ----------------

    T.onPolls = function (polls) {
        T.polls = Array.isArray(polls) ? polls : [];
        const now = Date.now();
        T.polls.forEach((p) => (p.endsAt = p.remainingMs != null ? now + p.remainingMs : null));
        rc.knownPollIds = rc.knownPollIds || new Set();
        const fresh = T.polls.filter((p) => !rc.knownPollIds.has(p.id));
        T.polls.forEach((p) => rc.knownPollIds.add(p.id));
        if (rc.pollsInitialSync) {
            rc.pollsInitialSync = false;
        } else if (fresh.length && T.panel !== 'polls' && !amPresenter()) {
            T.pollUnseen = true;
            bubble({
                name: 'Sondage',
                title: 'Nouveau sondage',
                text: fresh[0].question,
                onClick: () => T.panel !== 'polls' && T.togglePanel('polls'),
            });
        }
        // The poll being edited got a vote meanwhile: it can no longer change
        if (T.editingPollId && !T.polls.some((p) => p.id === T.editingPollId && p.editable)) {
            T.editingPollId = null;
            T.newPollOpen = false;
            if (T.panel === 'polls') renderPolls();
        }
        T.renderBar();
        if (T.panel === 'polls') renderPollList();
    };

    const DURATIONS = [
        [0, 'Non'],
        [60, 'Après 1 min'],
        [120, 'Après 2 min'],
        [300, 'Après 5 min'],
        [600, 'Après 10 min'],
        [1800, 'Après 30 min'],
    ];

    const timeLeft = (ms) => {
        const total = Math.max(0, Math.ceil(ms / 1000));
        const m = Math.floor(total / 60);
        const sec = String(total % 60).padStart(2, '0');
        return `${m}:${sec}`;
    };

    // The form and the list are separate, so a vote coming in does not wipe what the
    // presenter is typing
    function renderPolls() {
        const body = $('tllmPanelBody');
        body.innerHTML = `<div id="tllmPollFormBox"></div><div id="tllmPollList"></div>`;
        $('tllmPanelFoot').innerHTML = '';
        renderPollForm();
        renderPollList();
    }

    function renderPollForm() {
        const box = $('tllmPollFormBox');
        if (!box) return;
        if (!amPresenter()) {
            box.innerHTML = '';
            return;
        }
        if (!T.newPollOpen) {
            box.innerHTML = `<button type="button" class="tllm-primary tllm-block" id="tllmNewPoll">${icon('fas fa-plus')} Nouveau sondage</button>`;
            $('tllmNewPoll').onclick = () => {
                T.newPollOpen = true;
                T.editingPollId = null;
                renderPollForm();
                $('tllmPollQ').focus();
            };
            return;
        }
        const editing = T.polls.find((p) => p.id === T.editingPollId);
        const options = editing ? editing.options : ['', ''];
        const optInput = (value, i) =>
            `<input required maxlength="200" placeholder="Réponse ${i + 1}" aria-label="Réponse ${i + 1}" value="${esc(value)}">`;
        box.innerHTML = `<form class="tllm-poll-form" id="tllmPollForm">
            <label for="tllmPollQ">Question</label>
            <input id="tllmPollQ" required maxlength="300" placeholder="Que voulez-vous demander ?" value="${esc(editing?.question || '')}">
            <label>Réponses</label>
            <div class="tllm-poll-opts" id="tllmPollOpts">${options.map(optInput).join('')}</div>
            <button type="button" class="tllm-link" id="tllmAddOpt">+ Ajouter une réponse</button>
            ${
                editing
                    ? ''
                    : `<fieldset class="tllm-poll-settings">
                <legend>Réglages</legend>
                <label class="tllm-check"><input type="checkbox" id="tllmPollMulti"> Plusieurs réponses possibles</label>
                <label class="tllm-check"><input type="checkbox" id="tllmPollAnon"> Vote anonyme <span>personne ne voit qui a voté quoi, même l'admin</span></label>
                <label class="tllm-check"><input type="checkbox" id="tllmPollHide"> Résultats cachés jusqu'à la clôture</label>
                <label class="tllm-select">Clôture automatique
                    <select id="tllmPollDuration">${DURATIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
                </label>
              </fieldset>`
            }
            <p class="tllm-form-error" id="tllmPollError" hidden></p>
            <div class="tllm-row">
                <button type="submit" class="tllm-primary">${editing ? 'Enregistrer' : 'Lancer le sondage'}</button>
                <button type="button" class="tllm-secondary" id="tllmPollCancel">Annuler</button>
            </div>
          </form>`;
        $('tllmPollCancel').onclick = () => {
            T.newPollOpen = false;
            T.editingPollId = null;
            renderPollForm();
        };
        $('tllmAddOpt').onclick = () => {
            const opts = $('tllmPollOpts');
            if (opts.children.length >= 10) return;
            opts.insertAdjacentHTML('beforeend', optInput('', opts.children.length));
            opts.lastElementChild.removeAttribute('required');
            opts.lastElementChild.focus();
        };
        $('tllmPollForm').onsubmit = (e) => {
            e.preventDefault();
            const question = $('tllmPollQ').value.trim();
            const answers = [...$('tllmPollOpts').querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean);
            const error = $('tllmPollError');
            const fail = (text) => {
                error.textContent = text;
                error.hidden = false;
            };
            if (!question || answers.length < 2) return fail('Il faut une question et au moins deux réponses.');
            if (new Set(answers).size !== answers.length) return fail('Deux réponses sont identiques.');
            if (editing) {
                rc.socket.emit('editPoll', { pollId: editing.id, question, options: answers });
            } else {
                rc.socket.emit('createPoll', {
                    question,
                    options: answers,
                    multiple: $('tllmPollMulti').checked,
                    anonymous: $('tllmPollAnon').checked,
                    hideResults: $('tllmPollHide').checked,
                    duration: Number($('tllmPollDuration').value) || 0,
                });
            }
            T.newPollOpen = false;
            T.editingPollId = null;
            renderPollForm();
        };
    }

    function pollMeta(poll) {
        const total = poll.total || 0;
        const parts = [poll.closed ? 'Terminé' : 'En cours', `${total} votant${total > 1 ? 's' : ''}`];
        if (poll.multiple) parts.push('plusieurs réponses');
        parts.push(poll.anonymous ? 'anonyme' : 'nominatif');
        if (!poll.closed && poll.endsAt)
            parts.push(`fin dans <span data-countdown="${esc(poll.id)}">${timeLeft(poll.endsAt - Date.now())}</span>`);
        return parts.join(' · ');
    }

    function renderPollList() {
        const list = $('tllmPollList');
        if (!list) return;
        const presenter = amPresenter();
        let html = '';
        if (!T.polls.length) html += `<p class="tllm-empty">Aucun sondage pour l'instant.</p>`;
        [...T.polls].reverse().forEach((poll) => {
            const total = poll.total || 0;
            const shown = Array.isArray(poll.counts);
            const mineAll = poll.myVotes || [];
            html += `<div class="tllm-poll${poll.multiple ? ' tllm-poll-multi' : ''}" data-poll-card="${esc(poll.id)}">
                <p class="tllm-poll-q">${esc(poll.question)}</p>
                <div class="tllm-poll-state">${pollMeta(poll)}</div>
                ${
                    !poll.closed && !poll.anonymous && !presenter
                        ? `<p class="tllm-poll-hint">Les présentateurs voient votre choix.</p>`
                        : ''
                }
                ${poll.options
                    .map((option, i) => {
                        const count = shown ? poll.counts[i] || 0 : 0;
                        const pct = shown && total ? Math.round((count / total) * 100) : 0;
                        const mine = mineAll.includes(option);
                        return `<button type="button" class="tllm-opt${mine ? ' tllm-mine' : ''}" data-poll="${esc(poll.id)}" data-opt="${i}" style="--pct:${pct}%" ${poll.closed ? 'disabled' : ''} aria-pressed="${mine}">
                            <span class="tllm-radio"></span><span class="tllm-opt-lb">${esc(option)}</span>${shown ? `<span class="tllm-opt-res">${count} · ${pct} %</span>` : ''}</button>`;
                    })
                    .join('')}
                ${!shown ? `<p class="tllm-poll-hint">Résultats affichés à la clôture.</p>` : ''}
                ${!poll.closed && mineAll.length ? `<p class="tllm-poll-hint">${poll.multiple ? 'Touchez une réponse pour la retirer.' : 'Touchez votre réponse pour retirer votre vote.'}</p>` : ''}
                ${
                    presenter
                        ? `<div class="tllm-poll-actions">
                            ${poll.voters ? `<button type="button" class="tllm-link" data-voters="${esc(poll.id)}">${T.showVoters[poll.id] ? 'Masquer les votes' : 'Voir qui a voté'}</button>` : ''}
                            ${poll.editable ? `<button type="button" class="tllm-link" data-edit="${esc(poll.id)}">Modifier</button>` : ''}
                            ${poll.closed ? '' : `<button type="button" class="tllm-link" data-close="${esc(poll.id)}">Clôturer</button>`}
                            <button type="button" class="tllm-link" data-csv="${esc(poll.id)}">Exporter (tableur)</button>
                            <button type="button" class="tllm-link tllm-link-danger" data-del="${esc(poll.id)}">Supprimer</button>
                          </div>
                          ${
                              poll.voters && T.showVoters[poll.id]
                                  ? `<ul class="tllm-voters">${
                                        poll.voters
                                            .map((v) => `<li>${esc(v.name)} : ${esc(v.choices.join(', '))}</li>`)
                                            .join('') || '<li>Personne n’a encore voté.</li>'
                                    }</ul>`
                                  : ''
                          }`
                        : ''
                }
            </div>`;
        });
        list.innerHTML = html;

        list.querySelectorAll('.tllm-opt').forEach((btn) => {
            btn.onclick = () => {
                const poll = T.polls.find((p) => p.id === btn.dataset.poll);
                if (!poll || poll.closed) return;
                const option = poll.options[Number(btn.dataset.opt)];
                const mine = poll.myVotes || [];
                let next;
                if (mine.includes(option)) next = mine.filter((o) => o !== option);
                else next = poll.multiple ? [...mine, option] : [option];
                rc.socket.emit('vote', { pollId: poll.id, options: next });
            };
        });
        list.querySelectorAll('[data-voters]').forEach((btn) => {
            btn.onclick = () => {
                T.showVoters[btn.dataset.voters] = !T.showVoters[btn.dataset.voters];
                renderPollList();
            };
        });
        list.querySelectorAll('[data-edit]').forEach((btn) => {
            btn.onclick = () => {
                T.newPollOpen = true;
                T.editingPollId = btn.dataset.edit;
                renderPollForm();
                $('tllmPollQ')?.focus();
            };
        });
        list.querySelectorAll('[data-close]').forEach((btn) => {
            btn.onclick = () => rc.socket.emit('closePoll', { pollId: btn.dataset.close });
        });
        list.querySelectorAll('[data-csv]').forEach((btn) => {
            btn.onclick = () => exportPollCsv(T.polls.find((p) => p.id === btn.dataset.csv));
        });
        list.querySelectorAll('[data-del]').forEach((btn) => {
            btn.onclick = () =>
                confirmBox('Supprimer ce sondage ?', 'Les votes seront perdus.', 'Supprimer', () =>
                    rc.socket.emit('deletePoll', { pollId: btn.dataset.del })
                );
        });
        tickPolls();
    }

    // Countdown of the polls that close on their own (the server closes them)
    function tickPolls() {
        clearTimeout(T.pollTimer);
        const running = T.polls.some((p) => !p.closed && p.endsAt);
        if (!running || T.panel !== 'polls') return;
        T.pollTimer = setTimeout(() => {
            document.querySelectorAll('[data-countdown]').forEach((el) => {
                const poll = T.polls.find((p) => p.id === el.dataset.countdown);
                if (poll?.endsAt) el.textContent = timeLeft(poll.endsAt - Date.now());
            });
            tickPolls();
        }, 1000);
    }

    // Spreadsheet export: semicolons and a BOM, so Excel in French opens it as columns
    function exportPollCsv(poll) {
        if (!poll) return;
        const cell = (value) => {
            let text = String(value ?? '');
            if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; // never run as a formula
            return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        };
        const row = (...cells) => cells.map(cell).join(';');
        const total = poll.total || 0;
        const lines = [
            row('Question', poll.question),
            row('État', poll.closed ? 'Terminé' : 'En cours'),
            row('Type', poll.multiple ? 'Plusieurs réponses' : 'Une réponse', poll.anonymous ? 'Anonyme' : 'Nominatif'),
            row('Votants', total),
            '',
            row('Réponse', 'Voix', '% des votants'),
            ...poll.options.map((option, i) => {
                const count = poll.counts?.[i] || 0;
                return row(option, count, total ? Math.round((count / total) * 100) : 0);
            }),
        ];
        if (poll.voters?.length) {
            lines.push('', row('Participant', 'Réponses'));
            poll.voters.forEach((v) => lines.push(row(v.name, v.choices.join(', '))));
        }
        const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        const slug = poll.question
            .toLowerCase()
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .slice(0, 40)
            .replace(/^-|-$/g, '');
        a.download = `sondage-${slug || 'resultats'}.csv`;
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    // ####################################################
    // NOTIFICATIONS
    // ####################################################

    function bubble({ name, title, text = '', cls = '', onClick, iconCls, duration = 4000 }) {
        const host = $('tllmBubbles');
        if (!host) return;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tllm-bubble ' + cls;
        const lead = iconCls
            ? `<span class="tllm-avatar tllm-avatar-icon">${icon(iconCls)}</span>`
            : `<span class="tllm-avatar" style="background:${colorFor(name)}">${esc(initials(name))}</span>`;
        b.innerHTML = `${lead}<span class="tllm-b-text"><b>${esc(title)}</b>${text ? `<span>${esc(text)}</span>` : ''}</span>`;
        b.onclick = () => {
            b.remove();
            onClick && onClick();
        };
        host.appendChild(b);
        while (host.children.length > 3) host.firstElementChild.remove();
        setTimeout(() => b.remove(), duration);
    }
    T.bubble = bubble;

    function handRaised(peer) {
        bubble({
            name: peer.name,
            title: `${peer.name} lève la main`,
            text: 'Voir les participants',
            cls: 'tllm-bubble-hand',
            onClick: () => T.panel !== 'people' && T.togglePanel('people'),
        });
        T.playHandSound();
    }

    function confirmBox(title, text, okLabel, onOk) {
        const wrap = document.createElement('div');
        wrap.className = 'tllm-modal-wrap';
        noTranslate(wrap);
        wrap.innerHTML = `<div class="tllm-modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
            <h3>${esc(title)}</h3><p>${esc(text)}</p>
            <div class="tllm-row tllm-row-end"><button type="button" class="tllm-secondary" data-m="cancel">Annuler</button>
            <button type="button" class="tllm-danger-btn" data-m="ok">${esc(okLabel)}</button></div></div>`;
        document.body.appendChild(wrap);
        wrap.querySelector('[data-m="ok"]').focus();
        wrap.onclick = (e) => {
            const m = e.target.closest?.('[data-m]')?.dataset.m;
            if (e.target === wrap || m === 'cancel') wrap.remove();
            if (m === 'ok') {
                wrap.remove();
                onOk();
            }
        };
        wrap.onkeydown = (e) => e.key === 'Escape' && wrap.remove();
    }

    // MiroTalk's small notifications all go through showSwalToast. In the meeting:
    //  - confirmations of one's own actions and events already visible elsewhere are dropped,
    //  - warnings, errors and messages from the admin / presenter become a discreet bubble.
    const KEEP =
        /moderat|modérat|presenter|présentateur|has closed your|a fermé|banned|banni|ejected|expuls|lobby|salle d'attente|not allowed|pas autoris|n'autorise|interdit/i;
    function installToastFilter() {
        if (typeof showSwalToast !== 'function' || showSwalToast.__tllm) return;
        const filtered = function (options = {}) {
            const raw =
                [options.title, options.text, options.html].find((v) => typeof v === 'string' && v.trim()) || '';
            let text = textOf(raw);
            if (typeof window.tllmTranslate === 'function') text = window.tllmTranslate(text, 'toasts');
            const important = options.icon === 'error' || options.icon === 'warning' || KEEP.test(text);
            if (important && text) {
                bubble({
                    iconCls: options.icon === 'error' ? 'fas fa-circle-exclamation' : 'fas fa-circle-info',
                    title: text,
                    cls: options.icon === 'error' ? 'tllm-bubble-error' : '',
                    duration: 6000,
                });
            } else {
                console.log('[TLLM] notification hidden:', text);
            }
            return Promise.resolve({ isDismissed: true, dismiss: 'tllm' });
        };
        filtered.__tllm = true;
        // eslint-disable-next-line no-global-assign
        showSwalToast = filtered;
    }

    // ####################################################
    // REACTIONS
    // ####################################################

    function floatReaction(emoji, peerId, peerName) {
        const host = $('tllmReactions');
        const stage = $('tllmStage');
        if (!host || !stage) return;
        const tile =
            document.querySelector(`#videoMediaContainer .Camera[data-peer-id="${CSS.escape(peerId || '')}"]`) ||
            document.querySelector('#videoMediaContainer .Camera');
        const s = stage.getBoundingClientRect();
        const r = tile ? tile.getBoundingClientRect() : { left: s.left + 40, bottom: s.bottom - 20, width: 120 };
        const el = document.createElement('span');
        el.className = 'tllm-float';
        el.innerHTML = `<span class="tllm-float-emoji">${esc(emoji)}</span><span class="tllm-float-name">${esc(peerName || '')}</span>`;
        el.style.left = `${r.left - s.left + 12 + Math.random() * Math.max(10, r.width / 3)}px`;
        el.style.top = `${r.bottom - s.top - 70}px`;
        host.appendChild(el);
        setTimeout(() => el.remove(), 2700);
    }

    // Incoming reactions: float over the sender's tile, without the upstream sounds
    P.handleRoomEmoji = function (cmd) {
        const peer = T.peers.find((p) => p.name === cmd.peer_name);
        floatReaction(cmd.emoji, cmd.peer_id || peer?.id, cmd.peer_name === rc.peer_name ? 'Vous' : cmd.peer_name);
    };

    T.playHandSound = function () {
        try {
            const audio = new Audio('../sounds/raiseHand.wav');
            audio.volume = 0.5;
            audio.play().catch(() => {});
        } catch {
            /* ignore */
        }
    };
})();
