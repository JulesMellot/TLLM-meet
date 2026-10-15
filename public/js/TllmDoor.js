'use strict';

/**
 * TLLM*meet: the door of a room that is not open yet (/whoAreYou/<room>).
 *
 * Left, the sign: room name, orange band "Pas encore commencée", planned time, organiser, who is
 * already inside (GET /api/room/<id>, every 5 seconds). Right, the visitor sets up camera,
 * microphone and name while waiting. When the organiser opens the room the band turns red and
 * the visitor enters on their own, with these settings (name, mic and camera on or off, devices).
 */

(function () {
    const $ = (id) => document.getElementById(id);
    const roomId = decodeURIComponent(window.location.pathname.split('/').filter(Boolean).pop() || '');
    const params = new URLSearchParams(window.location.search);
    const POLL_MS = 5000;

    const ICONS = {
        mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z"/></svg>',
        micOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M15 12V6a3 3 0 0 0-5.83-1L15 10.83ZM3.27 2 2 3.27l7 7V12a3 3 0 0 0 4.4 2.65l1.5 1.5A5 5 0 0 1 7 12H5a7 7 0 0 0 6 6.92V21h2v-2.08a6.96 6.96 0 0 0 3.34-1.37L20.73 22 22 20.73ZM19 12h-2c0 .7-.15 1.37-.41 1.98l1.5 1.5A6.96 6.96 0 0 0 19 12Z"/></svg>',
        cam: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M15 8a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-2.5l4 3.5V7l-4 3.5Z"/></svg>',
        camOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3.27 2 2 3.27 4.73 6H4a1 1 0 0 0-1 1v9a2 2 0 0 0 2 2h8a2 2 0 0 0 1.38-.56L20.73 22 22 20.73ZM21 7l-4 3.5V8a2 2 0 0 0-2-2H9.82L21 17.18Z"/></svg>',
    };

    const state = {
        info: null,
        entering: false,
        open: false,
        since: Date.now(),
        mic: params.get('audio') !== '0' && params.get('audio') !== 'false',
        cam: params.get('video') !== '0' && params.get('video') !== 'false',
        audioTrack: null,
        videoTrack: null,
        micState: 'unknown', // ok | denied | missing | busy | error
        camState: 'unknown',
        heard: false,
        meter: null,
    };

    // ---------- small helpers ----------

    const fmt = (ms, opts) => new Intl.DateTimeFormat('fr-FR', opts).format(new Date(ms));
    const hour = (ms) => fmt(ms, { hour: '2-digit', minute: '2-digit' });
    const sameDay = (a, b) => fmt(a, { dateStyle: 'short' }) === fmt(b, { dateStyle: 'short' });

    function whenLabel(start, end) {
        const now = Date.now();
        let day;
        if (sameDay(start, now)) day = "aujourd'hui";
        else if (sameDay(start, now + 86400000)) day = 'demain';
        else day = fmt(start, { weekday: 'long', day: 'numeric', month: 'long' });
        return `${day}, de ${hour(start)} à ${hour(end)}`;
    }

    function names(people, count) {
        if (!count) return "personne pour l'instant";
        const shown = people.slice(0, 3);
        const rest = count - shown.length;
        return rest > 0 ? `${shown.join(', ')} et ${rest} autre${rest > 1 ? 's' : ''}` : shown.join(' et ');
    }

    function waited() {
        const min = Math.round((Date.now() - state.since) / 60000);
        return min < 1 ? '' : ` Vous attendez depuis ${min} min.`;
    }

    // ---------- the sign ----------

    function renderSign() {
        const info = state.info;
        if (!info) return;
        $('doorName').textContent = info.name;
        document.title = `${info.name} · TLLM*meet`;

        const facts = $('doorFacts');
        facts.textContent = '';
        const add = (term, value) => {
            const dt = document.createElement('dt');
            dt.textContent = term;
            const dd = document.createElement('dd');
            dd.textContent = value;
            facts.append(dt, dd);
        };
        if (info.booking) add('Prévue', whenLabel(info.booking.start, info.booking.end));
        if (info.organizer) add('Organisée par', info.organizer);
        add('Déjà là', names(info.people, info.count));

        const host = info.organizer || "L'organisateur";
        const foot = $('doorFoot');
        if (state.open) {
            foot.textContent = state.entering
                ? 'La salle vient d’ouvrir. Vous entrez dans un instant.'
                : 'La salle est ouverte. Entrez quand vous êtes prêt.';
        } else {
            foot.textContent = `${host} n'a pas encore ouvert la salle. Préparez-vous ici, vous entrerez dès qu'elle ouvre.${waited()}`;
        }
    }

    function tickClock() {
        $('doorClock').textContent = hour(Date.now());
    }

    async function poll() {
        if (state.entering) return;
        if (!document.hidden) {
            try {
                const res = await fetch(`/api/room/${encodeURIComponent(roomId)}`, { cache: 'no-store' });
                if (res.ok) {
                    state.info = await res.json();
                    if (state.info.active && !state.open) roomOpened();
                    renderSign();
                }
            } catch {
                /* try again at the next round */
            }
        }
        setTimeout(poll, POLL_MS);
    }

    // The one moment of the page: the band turns red, and the visitor goes in
    function roomOpened() {
        state.open = true;
        $('doorBand').className = 'tllm-band is-live';
        $('doorState').textContent = 'En cours';
        $('doorEnter').disabled = false;
        $('doorAutoWrap').hidden = true;
        if ($('doorAuto').checked && $('doorNameInput').value.trim()) {
            state.entering = true;
            setTimeout(enter, 1400);
        } else if (!$('doorNameInput').value.trim()) {
            $('doorError').textContent = 'Indiquez votre nom pour entrer.';
            $('doorNameInput').focus();
        }
    }

    // ---------- going in, with the settings chosen here ----------

    function saveDevices() {
        try {
            const stored = JSON.parse(localStorage.getItem('LOCAL_STORAGE_DEVICES')) || {
                audio: { count: 0, index: 0, select: null },
                speaker: { count: 0, index: 0, select: null },
                video: { count: 0, index: 0, select: null },
            };
            const put = (kind, select) => {
                if (!select.value) return;
                stored[kind] = { count: select.options.length, index: select.selectedIndex, select: select.value };
            };
            put('audio', $('doorMicSelect'));
            put('video', $('doorCamSelect'));
            localStorage.setItem('LOCAL_STORAGE_DEVICES', JSON.stringify(stored));
        } catch {
            /* private browsing: the room will pick the default devices */
        }
    }

    function enter() {
        const name = $('doorNameInput').value.trim();
        if (!name) {
            state.entering = false;
            $('doorError').textContent = 'Indiquez votre nom pour entrer.';
            $('doorNameInput').focus();
            return;
        }
        try {
            localStorage.setItem('peer_name', name);
        } catch {
            /* nothing to keep */
        }
        saveDevices();
        stopMedia();
        const query = new URLSearchParams(params);
        query.set('name', name);
        query.set('audio', state.mic && state.micState === 'ok' ? '1' : '0');
        query.set('video', state.cam && state.camState === 'ok' ? '1' : '0');
        window.location.href = `/join/${encodeURIComponent(roomId)}?${query.toString()}`;
    }

    // ---------- camera and microphone ----------

    function reasonOf(err) {
        const name = err?.name || '';
        if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
        if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'missing';
        if (name === 'NotReadableError' || name === 'AbortError') return 'busy';
        return 'error';
    }

    async function getTrack(kind, deviceId) {
        const constraints =
            kind === 'audio'
                ? { audio: deviceId ? { deviceId: { exact: deviceId } } : true }
                : {
                      video: deviceId
                          ? { deviceId: { exact: deviceId } }
                          : { width: { ideal: 1280 }, height: { ideal: 720 } },
                  };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        return kind === 'audio' ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0];
    }

    async function startAudio(deviceId) {
        state.audioTrack?.stop();
        try {
            state.audioTrack = await getTrack('audio', deviceId);
            state.audioTrack.enabled = state.mic;
            state.micState = 'ok';
            startMeter();
        } catch (err) {
            state.audioTrack = null;
            state.micState = reasonOf(err);
        }
    }

    async function startVideo(deviceId) {
        state.videoTrack?.stop();
        state.videoTrack = null;
        if (!state.cam) return renderPreview();
        try {
            state.videoTrack = await getTrack('video', deviceId);
            state.camState = 'ok';
        } catch (err) {
            state.camState = reasonOf(err);
        }
        renderPreview();
    }

    function renderPreview() {
        const video = $('doorVideo');
        if (state.videoTrack) {
            video.srcObject = new MediaStream([state.videoTrack]);
            video.hidden = false;
            $('doorFace').hidden = true;
        } else {
            video.srcObject = null;
            video.hidden = true;
            $('doorFace').hidden = false;
        }
    }

    function stopMedia() {
        state.audioTrack?.stop();
        state.videoTrack?.stop();
        state.meter?.ctx.close().catch(() => {});
        state.meter = null;
    }

    function startMeter() {
        state.meter?.ctx.close().catch(() => {});
        state.meter = null;
        if (!state.audioTrack || !window.AudioContext) return;
        const ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(new MediaStream([state.audioTrack]));
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        const data = new Uint8Array(analyser.fftSize);
        state.meter = { ctx };
        const loop = () => {
            if (!state.meter || state.meter.ctx !== ctx) return;
            analyser.getByteTimeDomainData(data);
            let peak = 0;
            for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
            const level = state.mic ? Math.min(100, (peak / 128) * 220) : 0;
            $('doorLevel').style.width = `${level}%`;
            if (level > 12 && !state.heard) {
                state.heard = true;
                renderChecks();
            }
            requestAnimationFrame(loop);
        };
        loop();
        // Browsers start audio only after a click: resume on the first one
        document.addEventListener('pointerdown', () => ctx.resume().catch(() => {}), { once: true });
    }

    async function fillDevices() {
        if (!navigator.mediaDevices?.enumerateDevices) return;
        const devices = await navigator.mediaDevices.enumerateDevices();
        const fill = (select, field, kind, track) => {
            const list = devices.filter((d) => d.kind === kind && d.deviceId);
            select.textContent = '';
            list.forEach((d, i) => {
                const option = document.createElement('option');
                option.value = d.deviceId;
                option.textContent = d.label || `${kind === 'videoinput' ? 'Caméra' : 'Micro'} ${i + 1}`;
                select.append(option);
            });
            const current = track?.getSettings?.().deviceId;
            if (current) select.value = current;
            field.hidden = list.length < 2;
        };
        fill($('doorCamSelect'), $('doorCamField'), 'videoinput', state.videoTrack);
        fill($('doorMicSelect'), $('doorMicField'), 'audioinput', state.audioTrack);
    }

    const PROBLEM = {
        denied: (what) =>
            `Le navigateur bloque ${what}. Autorisez-le avec l'icône à gauche de l'adresse, puis rechargez la page.`,
        missing: (what) =>
            `Aucun${what === 'la caméra' ? 'e caméra' : ' micro'} trouvé${what === 'la caméra' ? 'e' : ''} sur cet appareil.`,
        busy: (what) =>
            `${what === 'la caméra' ? 'La caméra' : 'Le micro'} est utilisé par une autre application. Fermez-la, puis rechargez.`,
        error: (what) => `${what === 'la caméra' ? 'La caméra' : 'Le micro'} ne répond pas.`,
    };

    function renderChecks() {
        const box = $('doorChecks');
        box.textContent = '';
        const line = (ok, text) => {
            const span = document.createElement('span');
            span.className = ok ? 'is-ok' : 'is-ko';
            span.textContent = text;
            box.append(span);
        };
        if (state.micState === 'ok') {
            if (!state.mic) line(true, 'Micro coupé. Vous entrerez en silence.');
            else line(true, state.heard ? 'Le micro vous entend.' : 'Micro prêt. Parlez pour vérifier le niveau.');
        } else if (state.micState !== 'unknown') line(false, PROBLEM[state.micState]('le micro'));
        if (!state.cam) line(true, 'Caméra éteinte. Vous entrerez sans image.');
        else if (state.camState === 'ok') line(true, 'La caméra fonctionne.');
        else if (state.camState !== 'unknown') line(false, PROBLEM[state.camState]('la caméra'));
    }

    function renderButtons() {
        const mic = $('doorMic');
        mic.innerHTML = state.mic ? ICONS.mic : ICONS.micOff;
        mic.classList.toggle('is-off', !state.mic);
        mic.setAttribute('aria-pressed', String(state.mic));
        mic.setAttribute('aria-label', state.mic ? 'Couper le micro' : 'Rallumer le micro');
        const cam = $('doorCam');
        cam.innerHTML = state.cam ? ICONS.cam : ICONS.camOff;
        cam.classList.toggle('is-off', !state.cam);
        cam.setAttribute('aria-pressed', String(state.cam));
        cam.setAttribute('aria-label', state.cam ? 'Éteindre la caméra' : 'Allumer la caméra');
    }

    function renderFace() {
        const name = $('doorNameInput').value.trim();
        $('doorFace').textContent = name ? name.charAt(0).toUpperCase() : '?';
    }

    // ---------- wiring ----------

    $('doorMic').onclick = () => {
        state.mic = !state.mic;
        if (state.audioTrack) state.audioTrack.enabled = state.mic;
        renderButtons();
        renderChecks();
    };
    $('doorCam').onclick = async () => {
        state.cam = !state.cam;
        renderButtons();
        await startVideo($('doorCamSelect').value || undefined);
        renderChecks();
    };
    $('doorCamSelect').onchange = async () => {
        await startVideo($('doorCamSelect').value);
        renderChecks();
    };
    $('doorMicSelect').onchange = async () => {
        state.heard = false;
        await startAudio($('doorMicSelect').value);
        renderChecks();
    };
    $('doorNameInput').addEventListener('input', () => {
        $('doorError').textContent = '';
        renderFace();
    });
    $('doorNameInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && state.open) enter();
    });
    $('doorEnter').onclick = () => {
        state.entering = true;
        enter();
    };
    $('doorLogin').href = `/login?room=${encodeURIComponent(roomId)}`;
    window.addEventListener('pagehide', stopMedia);

    let name = params.get('name') || '';
    if (!name) {
        try {
            name = localStorage.getItem('peer_name') || '';
        } catch {
            name = '';
        }
    }
    $('doorNameInput').value = name.slice(0, 60);
    $('doorName').textContent = roomId;
    renderFace();
    renderButtons();
    tickClock();
    setInterval(tickClock, 15000);
    setInterval(() => !state.open && renderSign(), 60000);
    poll();

    (async () => {
        if (!navigator.mediaDevices?.getUserMedia) {
            state.micState = state.camState = 'error';
            renderChecks();
            return;
        }
        await startAudio();
        await startVideo();
        await fillDevices().catch(() => {});
        renderChecks();
    })();
})();
