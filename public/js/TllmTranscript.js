'use strict';

/**
 * TLLM*meet - meeting transcription, browser side.
 *
 * A presenter starts it for the whole room (menu « Plus »). Every browser then sends its own
 * microphone to the server, cut into sentences on the pauses (an energy-based voice detector),
 * so each sentence carries one speaker. The server recognises it, keeps it with the speaker's
 * name and the moment it was said (Transcripts.js), and the organiser downloads the file after
 * the meeting. Nothing is sent while the microphone is off.
 *
 * Live captions do not wait for the end of the sentence: while it is being said, the browser sends
 * what it holds so far every INTERIM_MS (only shown, never kept), and the final text replaces it.
 */

(function () {
    const TICK_MS = 100;
    const MIN_SPEECH_MS = 300; // shorter: a cough, a click
    const END_SILENCE_MS = 700; // a pause this long ends the sentence
    const SOFT_SEGMENT_MS = 10000; // past this, a short breath ends the sentence
    const SOFT_SILENCE_MS = 250;
    const MAX_SEGMENT_MS = 15000; // a monologue is cut here: partial captions cost more on long sentences
    const IDLE_SEGMENT_MS = 6000; // silence: start a fresh recording, so sentences stay short
    const INTERIM_MS = 1200; // partial text of the sentence being said, for the captions
    const TIMESLICE_MS = 400; // the recorder hands over audio this often
    const LEAD_MS = 300; // audio kept before the first word
    const MAX_IN_FLIGHT = 2;
    const MAX_QUEUE = 20;
    const CAPTION_MS = 7000; // a caption stays this long after its last words
    const CAPTION_JOIN_MS = 10000; // the same speaker within this delay continues the same caption
    const CAPTION_CHARS = 160; // older words scroll out at the start

    const S = (window.tllmTranscript = {
        available: false,
        active: false,
        recording: false,
        captions: true, // this viewer's choice, kept in the browser
    });
    try {
        S.captions = localStorage.getItem('tllm-captions') !== 'off';
    } catch {
        /* default: shown */
    }

    let ctx = null;
    let analyser = null;
    let source = null;
    let sourceTrack = null;
    let timer = null;
    let seg = null; // { id, recorder, chunks, track, startedAt, firstSpeech, lastSpeech, speechMs, interim... }
    let noiseFloor = 0.004;
    const queue = [];
    let inFlight = 0;

    const room = () => window.tllmRoom;
    const amPresenter = () => typeof isPresenter !== 'undefined' && !!isPresenter;
    const micOff = () => !(rc && rc.peer_info && rc.peer_info.peer_audio === true);

    // The track actually sent to the room (after noise suppression), or the microphone stream
    function micTrack() {
        try {
            const id = rc.producerLabel?.get(mediaType.audio);
            const track = id && rc.producers?.get(id)?.track;
            if (track && track.readyState === 'live') return track;
        } catch {
            /* fall back to the stream */
        }
        const track = rc.localAudioStream?.getAudioTracks?.()[0];
        return track && track.readyState === 'live' ? track : null;
    }

    function mimeType() {
        if (typeof MediaRecorder === 'undefined') return null;
        for (const type of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) {
            if (MediaRecorder.isTypeSupported(type)) return type;
        }
        return '';
    }

    function listen(track) {
        if (track === sourceTrack && analyser) return true;
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            ctx = ctx || new AudioContext();
            if (ctx.state === 'suspended') ctx.resume().catch(() => {});
            source?.disconnect();
            source = ctx.createMediaStreamSource(new MediaStream([track]));
            analyser = ctx.createAnalyser();
            analyser.fftSize = 2048;
            source.connect(analyser);
            sourceTrack = track;
            return true;
        } catch (err) {
            console.warn('Transcription: no level meter', err);
            analyser = null;
            sourceTrack = null;
            return false;
        }
    }

    function level() {
        if (!analyser) return 0;
        const data = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        return Math.sqrt(sum / data.length);
    }

    function newSegment(track) {
        const type = mimeType();
        if (type === null) return null;
        let recorder;
        try {
            // 32 kbit/s is plenty for speech, and light on a phone connection
            const options = { audioBitsPerSecond: 32000, ...(type ? { mimeType: type } : {}) };
            recorder = new MediaRecorder(new MediaStream([track]), options);
        } catch (err) {
            console.warn('Transcription: cannot record', err);
            return null;
        }
        const s = {
            id: Math.random().toString(36).slice(2, 12),
            recorder,
            type: recorder.mimeType || type || 'audio/webm',
            chunks: [],
            track,
            startedAt: performance.now(),
            firstSpeech: null,
            lastSpeech: null,
            speechMs: 0,
            interimAt: 0,
            interimBusy: false,
        };
        recorder.ondataavailable = (e) => e.data && e.data.size > 0 && s.chunks.push(e.data);
        recorder.start(TIMESLICE_MS);
        return s;
    }

    // End the current recording; keep it when it holds speech
    function cut(keep) {
        const s = seg;
        seg = null;
        if (!s) return;
        const speechStart = s.firstSpeech != null ? Math.max(s.startedAt, s.firstSpeech - LEAD_MS) : s.startedAt;
        s.closed = true; // no more partial text for it
        s.recorder.onstop = () => {
            if (!keep) return;
            const blob = new Blob(s.chunks, { type: s.type });
            if (blob.size > 1000) enqueue(blob, s.type, speechStart, s.id);
        };
        try {
            if (s.recorder.state !== 'inactive') s.recorder.stop();
        } catch {
            /* already stopped */
        }
    }

    function tick() {
        if (!S.recording) return;
        const track = micTrack();
        if (!track || micOff()) {
            cut(!!seg && seg.speechMs >= MIN_SPEECH_MS); // the sentence said before muting is kept
            return;
        }
        if (seg && seg.track !== track) cut(seg.speechMs >= MIN_SPEECH_MS); // another microphone
        listen(track);
        if (!seg) seg = newSegment(track);
        if (!seg) return;

        const now = performance.now();
        const rms = level();
        const speaking = rms > Math.max(0.012, noiseFloor * 3);
        if (speaking) {
            seg.speechMs += TICK_MS;
            seg.lastSpeech = now;
            if (seg.firstSpeech == null) seg.firstSpeech = now;
        } else {
            noiseFloor = Math.min(0.02, noiseFloor * 0.95 + rms * 0.05);
        }

        const elapsed = now - seg.startedAt;
        const spoke = seg.speechMs >= MIN_SPEECH_MS;
        const quiet = seg.lastSpeech == null ? Infinity : now - seg.lastSpeech;
        if (spoke && quiet >= END_SILENCE_MS) {
            cut(true);
        } else if (spoke && elapsed >= SOFT_SEGMENT_MS && quiet >= SOFT_SILENCE_MS) {
            cut(true);
        } else if (elapsed >= MAX_SEGMENT_MS) {
            cut(spoke);
        } else if (!spoke && elapsed >= IDLE_SEGMENT_MS && (seg.lastSpeech == null || now - seg.lastSpeech > 1500)) {
            cut(false);
        } else {
            // Still speaking: the sentence so far, for the captions
            // (the recorder lags behind the level meter: wait until the first words are in its chunks)
            const ready = spoke && now - seg.firstSpeech >= 900;
            if (ready && !seg.interimBusy && now - seg.interimAt >= INTERIM_MS) sendInterim(seg);
            return;
        }
        // Start the next recording right away, so the next words are not lost
        seg = newSegment(track);
    }

    // The sentence so far: the chunks recorded since its start make a valid file. Shown, never kept.
    // One at a time per speaker, and never while finished sentences wait to be sent.
    function sendInterim(s) {
        if (queue.length || inFlight >= MAX_IN_FLIGHT || !s.chunks.length) return;
        s.interimBusy = true;
        s.interimAt = performance.now();
        const reader = new FileReader();
        reader.onloadend = () => {
            const audio = String(reader.result || '').split(',')[1];
            if (!audio || s.closed) {
                s.interimBusy = false;
                return;
            }
            rc.socket
                .request(
                    'getWhisperTranscription',
                    { audio, mimeType: s.type, meeting: true, interim: true, seg: s.id },
                    15000
                )
                .catch(() => {})
                .finally(() => (s.interimBusy = false));
        };
        reader.readAsDataURL(new Blob(s.chunks, { type: s.type }));
    }

    function enqueue(blob, type, speechStart, id) {
        if (queue.length >= MAX_QUEUE) queue.shift();
        queue.push({ blob, type, speechStart, id });
        pump();
    }

    function pump() {
        while (inFlight < MAX_IN_FLIGHT && queue.length) send(queue.shift());
    }

    function send({ blob, type, speechStart, id }) {
        inFlight++;
        const done = () => {
            inFlight--;
            pump();
        };
        const reader = new FileReader();
        reader.onloadend = () => {
            const audio = String(reader.result || '').split(',')[1];
            if (!audio) return done();
            rc.socket
                .request(
                    'getWhisperTranscription',
                    {
                        audio,
                        mimeType: type,
                        meeting: true,
                        seg: id,
                        ageMs: Math.round(performance.now() - speechStart),
                    },
                    120000
                )
                .then((res) => {
                    if (res?.inactive) stopRecording();
                    if (res?.error) console.warn('Transcription:', res.error);
                })
                .catch((err) => console.warn('Transcription request failed', err))
                .finally(done);
        };
        reader.readAsDataURL(blob);
    }

    function startRecording() {
        if (S.recording) return;
        if (mimeType() === null) {
            room()?.bubble?.({
                iconCls: 'fas fa-triangle-exclamation',
                title: 'Transcription impossible sur ce navigateur',
                text: 'Votre voix ne sera pas transcrite.',
                duration: 8000,
            });
            return;
        }
        S.recording = true;
        timer = setInterval(tick, TICK_MS);
    }

    function stopRecording() {
        if (!S.recording) return;
        S.recording = false;
        clearInterval(timer);
        timer = null;
        cut(!!seg && seg.speechMs >= MIN_SPEECH_MS);
        try {
            source?.disconnect();
        } catch {
            /* closed */
        }
        source = null;
        sourceTrack = null;
        analyser = null;
    }

    // ---------- Captions, in the style of Zoom: a dark band at the bottom of the videos ----------

    function captionHost() {
        let host = document.getElementById('tllmCaptions');
        if (host) return host;
        const stage = document.getElementById('tllmStage');
        if (!stage) return null;
        host = document.createElement('div');
        host.id = 'tllmCaptions';
        host.setAttribute('aria-live', 'polite');
        host.setAttribute('translate', 'no');
        host.classList.add('notranslate');
        stage.appendChild(host);
        return host;
    }

    // Keep the end of the text: the newest words matter
    function tail(text) {
        if (text.length <= CAPTION_CHARS) return text;
        const cut = text.slice(-CAPTION_CHARS);
        const space = cut.indexOf(' ');
        return '…' + (space > 0 && space < 30 ? cut.slice(space + 1) : cut);
    }

    // One line per speaker: the finished sentences of the last seconds, then the one being said.
    // A partial text is replaced by the next one, and by the final text of its sentence.
    function captionLine(host, data, now) {
        const last = host.lastElementChild;
        if (
            last &&
            last.dataset.peer === data.peer_id &&
            now - last._at < CAPTION_JOIN_MS &&
            !last.classList.contains('is-gone')
        ) {
            return last;
        }
        if (!data.text) return null;
        const line = document.createElement('div');
        line.className = 'tllm-cap';
        line.dataset.peer = data.peer_id;
        line._final = '';
        line._interim = null;
        line._done = [];
        const who = document.createElement('b');
        who.textContent = data.peer_name;
        line.append(who, document.createElement('span'));
        host.appendChild(line);
        while (host.children.length > 2) host.firstElementChild.remove();
        return line;
    }

    function showCaption(data) {
        if (!S.captions || !S.active) return;
        const host = captionHost();
        if (!host) return;
        const now = Date.now();
        const line = captionLine(host, data, now);
        if (!line) return;
        if (data.interim) {
            if (line._done.includes(data.seg)) return; // arrived after its final text
            line._interim = { seg: data.seg, text: data.text };
        } else {
            if (data.seg) line._done = [...line._done.slice(-5), data.seg];
            if (!data.seg || line._interim?.seg === data.seg) line._interim = null;
            if (data.text) line._final = `${line._final} ${data.text}`.trim();
        }
        const text = `${line._final} ${line._interim?.text || ''}`.trim();
        if (!text) return line.remove();
        line.lastElementChild.textContent = tail(text);
        line._at = now;
        clearTimeout(line._timer);
        line._timer = setTimeout(() => {
            line.classList.add('is-gone');
            setTimeout(() => line.remove(), 400);
        }, CAPTION_MS);
    }

    function clearCaptions() {
        const host = document.getElementById('tllmCaptions');
        if (host) host.textContent = '';
    }

    S.toggleCaptions = function () {
        S.captions = !S.captions;
        try {
            localStorage.setItem('tllm-captions', S.captions ? 'on' : 'off');
        } catch {
            /* this time only */
        }
        if (!S.captions) clearCaptions();
        room()?.bubble?.({
            iconCls: 'fas fa-closed-captioning',
            title: S.captions ? 'Sous-titres affichés' : 'Sous-titres masqués',
            text: S.captions ? '' : 'La transcription continue. Plus › Afficher les sous-titres.',
            duration: 3500,
        });
    };

    function apply(state, by, announce) {
        const was = S.active;
        S.available = !!state?.available;
        S.active = S.available && !!state?.active;
        if (S.active) startRecording();
        else {
            stopRecording();
            clearCaptions();
        }
        const T = room();
        if (!T) return;
        T.transcribing = S.active;
        T.renderBar?.();
        const notice = 'Coupez votre micro pour ne pas être transcrit.';
        if (announce === 'join') {
            if (S.active) {
                T.bubble?.({
                    iconCls: 'fas fa-closed-captioning',
                    title: 'La réunion est transcrite, avec votre nom',
                    text: notice,
                    cls: 'tllm-bubble-rec',
                    duration: 10000,
                });
            }
            return;
        }
        if (was === S.active) return;
        const who = by && by !== rc.peer_name ? by : 'Vous';
        T.sys?.(
            S.active
                ? `${who === 'Vous' ? 'Vous avez' : who + ' a'} lancé la transcription`
                : `${who === 'Vous' ? 'Vous avez' : who + ' a'} arrêté la transcription`
        );
        T.bubble?.({
            iconCls: 'fas fa-closed-captioning',
            title: S.active ? 'La réunion est transcrite, avec votre nom' : 'Transcription arrêtée',
            text: S.active ? notice : amPresenter() ? 'Le fichier sera téléchargeable après la visio.' : '',
            cls: S.active ? 'tllm-bubble-rec' : '',
            duration: S.active ? 10000 : 5000,
        });
    }

    // Presenters only (checked by the server too)
    S.toggle = function () {
        if (!S.available || !amPresenter()) return;
        rc.socket
            .request('setMeetingTranscription', { active: !S.active })
            .then((res) => {
                if (res?.error) {
                    room()?.bubble?.({
                        iconCls: 'fas fa-triangle-exclamation',
                        title: 'Transcription indisponible',
                        text: res.error === 'unavailable' ? 'Le serveur de transcription n’est pas configuré.' : '',
                        duration: 6000,
                    });
                }
            })
            .catch((err) => console.warn('Transcription toggle failed', err));
    };

    // Called by TllmRoom.js once the room is joined
    S.init = function () {
        if (S.started || typeof rc === 'undefined' || !rc?.socket) return;
        S.started = true;
        rc.socket.on('meetingTranscription', (state) => apply(state, state?.by, 'change'));
        rc.socket.on('meetingTranscript', (data) => {
            if (!data) return;
            showCaption({
                peer_id: String(data.peer_id || data.peer_name || ''),
                peer_name: String(data.peer_name || 'Participant'),
                text: String(data.text || ''),
                seg: typeof data.seg === 'string' ? data.seg : null,
                interim: data.interim === true,
            });
        });
        rc.socket
            .request('meetingTranscription')
            .then((state) => apply(state, null, 'join'))
            .catch(() => {});
    };
})();
