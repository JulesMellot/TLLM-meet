'use strict';

/**
 * TLLM*meet - meeting transcription, browser side.
 *
 * A presenter starts it for the whole room (menu « Plus »). Every browser then sends its own
 * microphone to the server, cut into sentences on the pauses (an energy-based voice detector),
 * so each sentence carries one speaker. The server recognises it, keeps it with the speaker's
 * name and the moment it was said (Transcripts.js), and the organiser downloads the file after
 * the meeting. Nothing is sent while the microphone is off.
 */

(function () {
    const TICK_MS = 100;
    const MIN_SPEECH_MS = 300; // shorter: a cough, a click
    const END_SILENCE_MS = 700; // a pause this long ends the sentence
    const MAX_SEGMENT_MS = 25000;
    const IDLE_SEGMENT_MS = 6000; // silence: start a fresh recording, so sentences stay short
    const LEAD_MS = 300; // audio kept before the first word
    const MAX_IN_FLIGHT = 2;
    const MAX_QUEUE = 20;

    const S = (window.tllmTranscript = {
        available: false,
        active: false,
        recording: false,
    });

    let ctx = null;
    let analyser = null;
    let source = null;
    let sourceTrack = null;
    let timer = null;
    let seg = null; // { recorder, chunks, track, startedAt, firstSpeech, lastSpeech, speechMs }
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
            recorder,
            type: recorder.mimeType || type || 'audio/webm',
            chunks: [],
            track,
            startedAt: performance.now(),
            firstSpeech: null,
            lastSpeech: null,
            speechMs: 0,
        };
        recorder.ondataavailable = (e) => e.data && e.data.size > 0 && s.chunks.push(e.data);
        recorder.start();
        return s;
    }

    // End the current recording; keep it when it holds speech
    function cut(keep) {
        const s = seg;
        seg = null;
        if (!s) return;
        const speechStart = s.firstSpeech != null ? Math.max(s.startedAt, s.firstSpeech - LEAD_MS) : s.startedAt;
        s.recorder.onstop = () => {
            if (!keep) return;
            const blob = new Blob(s.chunks, { type: s.type });
            if (blob.size > 1000) enqueue(blob, s.type, speechStart);
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
        if (spoke && now - seg.lastSpeech >= END_SILENCE_MS) {
            cut(true);
        } else if (elapsed >= MAX_SEGMENT_MS) {
            cut(spoke);
        } else if (!spoke && elapsed >= IDLE_SEGMENT_MS && (seg.lastSpeech == null || now - seg.lastSpeech > 1500)) {
            cut(false);
        } else {
            return;
        }
        // Start the next recording right away, so the next words are not lost
        seg = newSegment(track);
    }

    function enqueue(blob, type, speechStart) {
        if (queue.length >= MAX_QUEUE) queue.shift();
        queue.push({ blob, type, speechStart });
        pump();
    }

    function pump() {
        while (inFlight < MAX_IN_FLIGHT && queue.length) send(queue.shift());
    }

    function send({ blob, type, speechStart }) {
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
                    { audio, mimeType: type, meeting: true, ageMs: Math.round(performance.now() - speechStart) },
                    60000
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

    function apply(state, by, announce) {
        const was = S.active;
        S.available = !!state?.available;
        S.active = S.available && !!state?.active;
        if (S.active) startRecording();
        else stopRecording();
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
            // Live captions, only for those who opened the « Sous-titres » panel
            if (typeof transcription === 'undefined' || !transcription || transcription.isHidden) return;
            if (!data?.text) return;
            transcription.handleTranscript({
                peer_name: String(data.peer_name || ''),
                peer_avatar: '',
                text_data: String(data.text),
            });
        });
        rc.socket
            .request('meetingTranscription')
            .then((state) => apply(state, null, 'join'))
            .catch(() => {});
    };
})();
