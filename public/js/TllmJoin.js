'use strict';

/**
 * TLLM*meet - screen shown before joining a meeting.
 *
 * 1. Camera and microphone are requested together, in a single browser prompt. When something fails,
 *    the reason is kept (blocked, dismissed, no device, device used by another application) and shown
 *    in plain words with a "Réessayer" button, instead of silently joining without camera or microphone.
 * 2. MiroTalk's join dialog is laid out like the meeting screen: a large preview with the microphone and
 *    camera buttons on it, a microphone level meter, the name, the devices and one "Rejoindre" button.
 * MiroTalk keeps the logic (name checks, devices, virtual background); this file only re-arranges it.
 */

(function () {
    if (typeof initEnumerateDevices !== 'function') return;

    const $ = (id) => document.getElementById(id);
    const media = { video: 'unknown', audio: 'unknown' };
    window.tllmMedia = media;
    let granted = []; // tracks from the single request, reused by MiroTalk's device listing

    // ####################################################
    // PERMISSIONS
    // ####################################################

    function reasonOf(err) {
        const name = err?.name || '';
        const message = String(err?.message || '').toLowerCase();
        if (name === 'NotAllowedError' && message.includes('dismiss')) return 'dismissed';
        if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'denied';
        if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError')
            return 'missing';
        if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'busy';
        return 'error';
    }

    async function request(constraints) {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        return stream.getTracks();
    }

    async function checkMedia() {
        if (!navigator.mediaDevices?.getUserMedia) {
            media.video = media.audio = 'unsupported';
            return;
        }
        try {
            granted = await request({ audio: true, video: true });
            media.video = media.audio = 'ok';
            return;
        } catch (err) {
            console.warn('[TLLM] camera + microphone request failed', err?.name, err?.message);
        }
        // Find out which one fails and why (at most one more prompt each)
        for (const kind of ['video', 'audio']) {
            try {
                granted.push(...(await request({ [kind]: true })));
                media[kind] = 'ok';
            } catch (err) {
                media[kind] = reasonOf(err);
                console.warn(`[TLLM] ${kind} request failed`, err?.name, err?.message);
            }
        }
    }

    // A track from the single request, or a new request (device list refreshed later on)
    async function streamFor(kind) {
        const index = granted.findIndex((track) => track.kind === kind);
        if (index >= 0) {
            const [track] = granted.splice(index, 1);
            return new MediaStream([track]);
        }
        return navigator.mediaDevices.getUserMedia({ [kind]: true });
    }

    // eslint-disable-next-line no-global-assign
    initEnumerateVideoDevices = async function () {
        try {
            const stream = await streamFor('video');
            await enumerateVideoDevices(stream);
            isVideoAllowed = true;
            media.video = 'ok';
        } catch (err) {
            isVideoAllowed = false;
            if (media.video === 'ok' || media.video === 'unknown') media.video = reasonOf(err);
        }
    };

    // eslint-disable-next-line no-global-assign
    initEnumerateAudioDevices = async function () {
        try {
            const stream = await streamFor('audio');
            await enumerateAudioDevices(stream);
            await getMicrophoneVolumeIndicator(stream);
            isAudioAllowed = true;
            media.audio = 'ok';
        } catch (err) {
            isAudioAllowed = false;
            if (media.audio === 'ok' || media.audio === 'unknown') media.audio = reasonOf(err);
        }
    };

    const origInitEnumerateDevices = initEnumerateDevices;
    // eslint-disable-next-line no-global-assign
    initEnumerateDevices = async function (...args) {
        await checkMedia();
        return origInitEnumerateDevices.apply(this, args);
    };

    // ####################################################
    // JOIN SCREEN
    // ####################################################

    if (typeof whoAreYou === 'function') {
        const origWhoAreYou = whoAreYou;
        // eslint-disable-next-line no-global-assign
        whoAreYou = async function (...args) {
            const result = await origWhoAreYou.apply(this, args);
            try {
                buildJoinScreen();
            } catch (err) {
                console.error('[TLLM] join screen layout failed', err);
            }
            return result;
        };
    }

    const cfg = () => (typeof BUTTONS !== 'undefined' && BUTTONS) || {};
    const isIOS = () =>
        /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text) node.textContent = text;
        return node;
    }

    function field(labelText, control) {
        const wrap = el('label', 'tllm-join-field');
        wrap.append(el('span', 'tllm-join-label', labelText), control);
        return wrap;
    }

    // The sign of the room: name, who is inside, planned time (GET /api/room/<id>)
    function buildSign() {
        const roomName = typeof room_id !== 'undefined' ? room_id : '';
        const sign = el('section', 'tllm-join-sign');
        const band = el('div', 'tllm-join-band');
        const stateText = el('span', '', 'Salle ouverte');
        const clock = el('b');
        const tick = () =>
            (clock.textContent = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(
                new Date()
            ));
        tick();
        setInterval(tick, 15000);
        band.append(stateText, clock);
        const body = el('div', 'tllm-join-sign-body');
        const name = el('h1', 'tllm-join-name-big', roomName);
        const facts = el('dl', 'tllm-join-facts');
        const foot = el('p', 'tllm-join-foot', 'Réglez votre caméra et votre micro, puis entrez.');
        body.append(name, facts, foot);
        sign.append(band, body);

        const fact = (term, value) => {
            const dt = el('dt', '', term);
            const dd = el('dd', '', value);
            facts.append(dt, dd);
        };
        const hour = (ms) =>
            new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
        fetch(`/api/room/${encodeURIComponent(roomName)}`, { cache: 'no-store' })
            .then((res) => (res.ok ? res.json() : null))
            .then((info) => {
                if (!info) return;
                name.textContent = info.name;
                facts.textContent = '';
                if (info.booking) fact('Prévue', `de ${hour(info.booking.start)} à ${hour(info.booking.end)}`);
                if (info.organizer) fact('Organisée par', info.organizer);
                if (info.active) {
                    band.classList.remove('is-free');
                    stateText.textContent = 'En cours';
                    const shown = info.people.slice(0, 3);
                    const rest = info.count - shown.length;
                    fact(
                        'Déjà là',
                        info.count
                            ? rest > 0
                                ? `${shown.join(', ')} et ${rest} autre${rest > 1 ? 's' : ''}`
                                : shown.join(' et ')
                            : "personne pour l'instant"
                    );
                } else {
                    // Only the organiser gets here while the room is closed: they open it
                    band.classList.add('is-free');
                    stateText.textContent = 'Vous ouvrez la salle';
                    foot.textContent = 'Les invités qui attendent devant la porte entreront dès que vous serez dedans.';
                }
            })
            .catch(() => {});
        return sign;
    }

    function buildJoinScreen() {
        const popup = document.querySelector('.swal2-popup.init-modal-size');
        if (!popup || popup.classList.contains('tllm-join')) return;
        popup.classList.add('tllm-join');
        popup.parentElement?.classList.add('tllm-join-wrap');

        const videoContainer = $('initVideoContainer');
        const input = popup.querySelector('.swal2-input');
        const validation = popup.querySelector('.swal2-validation-message');
        const actions = popup.querySelector('.swal2-actions');
        const confirm = popup.querySelector('.swal2-confirm');
        if (!videoContainer || !input || !actions) return;

        const brand = el('a', 'tllm-join-brand');
        brand.href = '/';
        brand.innerHTML = 'TLLM<span>*</span>meet';

        const grid = el('div', 'tllm-join-grid');
        const right = el('section', 'tllm-join-right');
        right.setAttribute('aria-label', 'Vos réglages');
        grid.append(buildSign(), right);

        // Right: preview with the microphone / camera / background buttons on it, then name and devices
        right.append(videoContainer);
        const controls = el('div', 'tllm-join-controls');
        ['initAudioButton', 'initVideoButton', 'initVirtualBackgroundButton'].forEach((id) => {
            const button = $(id);
            if (button) controls.append(button);
        });
        if (media.video !== 'ok') $('initVirtualBackgroundButton')?.classList.add('hidden');
        videoContainer.append(controls);

        // SweetAlert only reads its input when it stays a direct child of the popup: keep it there, hidden,
        // and show a copy that writes into it
        const name = el('input', 'tllm-join-name');
        name.type = 'text';
        name.id = 'tllmJoinName';
        name.maxLength = 254;
        name.placeholder = 'Votre prénom et nom';
        name.autocomplete = 'name';
        name.value = input.value;
        name.disabled = input.disabled;
        name.addEventListener('input', () => {
            input.value = name.value;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        name.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.isComposing) {
                e.preventDefault();
                confirm?.click();
            }
        });
        input.classList.add('tllm-join-swal-input');
        input.tabIndex = -1;
        right.append(field('Votre nom', name));
        if (validation) right.append(validation);

        const devices = [
            ['initVideoSelect', 'Caméra', 'video'],
            ['initMicrophoneSelect', 'Micro', 'audio'],
            ['initSpeakerSelect', 'Haut-parleur', 'audio'],
        ];
        devices.forEach(([id, label]) => {
            const select = $(id);
            if (
                !select ||
                select.classList.contains('hidden') ||
                select.style.display === 'none' ||
                !select.options.length
            )
                return;
            right.append(field(label, select));
        });

        const meter = el('div', 'tllm-join-meter');
        meter.innerHTML =
            '<span>Micro</span><span class="tllm-join-meter-track"><span class="tllm-join-meter-fill" id="tllmJoinMeter"></span></span>';
        meter.setAttribute('aria-hidden', 'true');
        right.append(meter);

        const notice = el('div', 'tllm-join-notice');
        notice.id = 'tllmJoinNotice';
        right.append(notice);

        if (confirm) confirm.textContent = 'Entrer dans la salle';
        right.append(actions);
        const cancel = el('button', 'tllm-join-cancel', 'Repartir sans entrer');
        cancel.type = 'button';
        cancel.onclick = () => $('initExitButton')?.click();
        right.append(cancel);

        const title = popup.querySelector('.swal2-title');
        popup.insertBefore(grid, title ? title.nextSibling : popup.firstChild);
        popup.insertBefore(brand, grid);
        renderNotice();
        name.focus();
        name.setSelectionRange(name.value.length, name.value.length);

        startMeter(popup);
        $('initMicrophoneSelect')?.addEventListener('change', () => startMeter(popup));
    }

    const LABEL = { video: 'la caméra', audio: 'le micro' };
    const DEVICE = { video: 'caméra', audio: 'micro' };

    function problemText(kind, state) {
        const what = LABEL[kind];
        switch (state) {
            case 'denied':
                return isIOS()
                    ? `L'accès à ${what} est refusé. Ouvrez Réglages › Safari › ${kind === 'video' ? 'Caméra' : 'Microphone'}, choisissez « Autoriser », puis revenez ici.`
                    : `L'accès à ${what} est bloqué par le navigateur. Cliquez sur l'icône à gauche de l'adresse du site, autorisez ${what}, puis « Réessayer ».`;
            case 'dismissed':
                return `Vous n'avez pas répondu à la demande d'accès à ${what}. Cliquez sur « Réessayer » et choisissez « Autoriser ».`;
            case 'missing':
                return `Aucun ${DEVICE[kind]} détecté. Branchez-en un, puis « Réessayer ».`;
            case 'busy':
                return `${kind === 'video' ? 'La caméra est déjà utilisée' : 'Le micro est déjà utilisé'} par une autre application (Teams, Zoom, un autre onglet…). Fermez-la, puis « Réessayer ».`;
            case 'unsupported':
                return "Ce navigateur ne permet pas d'utiliser la caméra et le micro. Essayez avec Chrome, Edge, Firefox ou Safari à jour.";
            default:
                return `Impossible d'utiliser ${what}. Cliquez sur « Réessayer ».`;
        }
    }

    function renderNotice() {
        const notice = $('tllmJoinNotice');
        if (!notice) return;
        const wanted = {
            video: cfg().main?.startVideoButton !== false,
            audio: cfg().main?.startAudioButton !== false,
        };
        const problems = ['audio', 'video'].filter(
            (kind) => wanted[kind] && media[kind] !== 'ok' && media[kind] !== 'unknown'
        );
        notice.hidden = problems.length === 0;
        if (!problems.length) return;
        const same =
            problems.length === 2 && media.audio === media.video && media.audio !== 'busy' && media.audio !== 'missing';
        const items = same
            ? [
                  problemText('video', media.video)
                      .replace(LABEL.video, 'la caméra et au micro')
                      .replace('autorisez la caméra et au micro', 'autorisez la caméra et le micro'),
              ]
            : problems.map((kind) => problemText(kind, media[kind]));
        notice.innerHTML = `<p class="tllm-join-notice-title"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i> ${
            problems.length === 2
                ? 'Caméra et micro indisponibles'
                : problems[0] === 'video'
                  ? 'Caméra indisponible'
                  : 'Micro indisponible'
        }</p>`;
        items.forEach((text) => notice.append(el('p', '', text)));
        const actions = el('div', 'tllm-join-notice-actions');
        const retry = el('button', 'tllm-join-retry', 'Réessayer');
        retry.type = 'button';
        retry.onclick = () => retryAccess(retry);
        actions.append(retry);
        actions.append(el('span', 'tllm-join-hint', 'Vous pouvez aussi rejoindre sans, et réessayer plus tard.'));
        notice.append(actions);
    }

    async function retryAccess(button) {
        button.disabled = true;
        button.textContent = 'Vérification…';
        const before = { ...media };
        for (const kind of ['video', 'audio']) {
            if (media[kind] === 'ok') continue;
            try {
                const tracks = await request({ [kind]: true });
                tracks.forEach((track) => track.stop());
                media[kind] = 'ok';
            } catch (err) {
                media[kind] = reasonOf(err);
            }
        }
        if ((before.video !== 'ok' && media.video === 'ok') || (before.audio !== 'ok' && media.audio === 'ok')) {
            // MiroTalk reads the devices once, at load: start again with the access now granted
            window.location.reload();
            return;
        }
        renderNotice();
    }

    // Microphone level, so people can check they are heard before joining
    let meterStop = null;
    async function startMeter(popup) {
        if (meterStop) meterStop();
        meterStop = null;
        const fill = $('tllmJoinMeter');
        if (!fill || media.audio !== 'ok' || !(window.AudioContext || window.webkitAudioContext)) {
            fill?.closest('.tllm-join-meter')?.setAttribute('hidden', '');
            return;
        }
        let stream;
        try {
            const deviceId = $('initMicrophoneSelect')?.value;
            stream = await navigator.mediaDevices.getUserMedia({
                audio: deviceId ? { deviceId: { exact: deviceId } } : true,
            });
        } catch {
            return;
        }
        const Ctx = window.AudioContext || window.webkitAudioContext;
        const ctx = new Ctx();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        ctx.createMediaStreamSource(stream).connect(analyser);
        const data = new Uint8Array(analyser.fftSize);
        let frame;
        const loop = () => {
            if (!document.contains(popup)) return stop();
            analyser.getByteTimeDomainData(data);
            let sum = 0;
            for (const v of data) sum += (v - 128) * (v - 128);
            const level = Math.min(1, Math.sqrt(sum / data.length) / 40);
            const muted = $('initAudioButton')?.classList.contains('fa-microphone-slash');
            fill.style.width = `${muted ? 0 : Math.round(level * 100)}%`;
            frame = requestAnimationFrame(loop);
        };
        const stop = () => {
            cancelAnimationFrame(frame);
            stream.getTracks().forEach((track) => track.stop());
            ctx.close().catch(() => {});
            meterStop = null;
        };
        meterStop = stop;
        loop();
    }
})();
