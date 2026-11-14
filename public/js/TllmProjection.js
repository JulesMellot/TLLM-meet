'use strict';

/**
 * TLLM*meet: presentation mode, for a meeting held half in a room, half by video.
 *
 * The person whose computer is plugged into the projector keeps the meeting on their own screen
 * (chat, participants, notes, controls) and opens a second window for the room: it goes on the
 * projector (placed there by itself when the browser allows it), full screen, and shows only what
 * the room needs to see:
 *  - what is presented, big: the whiteboard or the shared notes when they are open, otherwise the
 *    latest screen shared (one's own included);
 *  - beside it, the people who are not in the room, the ones speaking first;
 *  - with nothing presented, those people in a grid; alone, the link to join.
 * One's own camera is left out: the room already sees the person. The window plays no sound
 * (the meeting window does) and receives nothing more: it shows the pictures the meeting already has.
 */

(function (root) {
    // ####################################################
    // WHAT THE PROJECTOR SHOWS (no browser needed: tested in tests/test-Projection.js)
    // ####################################################

    // tiles: [{ key, peerId, screen, since }]; content: 'board' | 'notes' | null
    function arrange({ tiles, content = null, me, spoke = new Map(), sideMax = 4 }) {
        const people = tiles.filter((t) => !t.screen && t.peerId !== me);
        const screens = tiles.filter((t) => t.screen);
        let main = null;
        if (content) main = { kind: content };
        else if (screens.length) {
            const latest = screens.reduce((a, b) => ((b.since || 0) > (a.since || 0) ? b : a));
            main = { kind: 'screen', tile: latest };
        }
        if (!main) return { main, people };
        // Beside what is presented: the last ones who spoke, in the order of the meeting
        const recent = [...people]
            .sort((a, b) => (spoke.get(b.peerId) || 0) - (spoke.get(a.peerId) || 0))
            .slice(0, sideMax);
        return { main, people: people.filter((t) => recent.includes(t)) };
    }

    // Largest 16:9 tiles for n people in a width x height area
    function fitGrid(n, width, height, gap = 12, ratio = 16 / 9) {
        let best = { cols: 1, w: 0, h: 0 };
        for (let cols = 1; cols <= Math.max(1, n); cols++) {
            const rows = Math.ceil(n / cols);
            const w = Math.min((width - gap * (cols - 1)) / cols, ((height - gap * (rows - 1)) / rows) * ratio);
            if (w > best.w) best = { cols, w: Math.floor(w), h: Math.floor(w / ratio) };
        }
        return best;
    }

    const api = { arrange, fitGrid };
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
        return;
    }
    if (typeof RoomClient === 'undefined') return;

    // ####################################################
    // THE WINDOW
    // ####################################################

    const NAME = 'tllm-projection';
    const $ = (id) => document.getElementById(id);
    const P = (root.tllmProjection = { win: null, ...api });
    const spoke = new Map(); // peer id -> last time heard
    const since = new Map(); // tile key -> first time seen
    let boardStream = null;
    let listening = false;

    P.isOpen = () => !!P.win && !P.win.closed;
    P.toggle = () => (P.isOpen() ? P.close() : P.open());

    const tell = (title, text = '') =>
        root.tllmRoom?.bubble?.({ name: 'TLLM', title, text, iconCls: 'fas fa-person-chalkboard', duration: 6000 });

    // The projector: another screen, an external one before the laptop's own, the largest first
    async function otherScreen() {
        if (!root.screen?.isExtended || typeof root.getScreenDetails !== 'function') return null;
        const details = await root.getScreenDetails();
        const others = details.screens.filter((s) => s !== details.currentScreen);
        others.sort((a, b) => Number(a.isInternal) - Number(b.isInternal) || b.width * b.height - a.width * a.height);
        return others[0] || null;
    }

    P.open = async function () {
        if (P.isOpen()) return P.win.focus();
        // Asked before: the window opens straight on the projector (asking would take the click away)
        let target = null;
        try {
            const permission = await navigator.permissions?.query({ name: 'window-management' });
            if (permission?.state === 'granted') target = await otherScreen();
        } catch {
            /* browser without the permission: the window is moved by hand */
        }
        const at = (s) => `left=${s.availLeft},top=${s.availTop},width=${s.availWidth},height=${s.availHeight}`;
        const win = root.open('', NAME, `popup,${target ? at(target) : 'width=1280,height=720'}`);
        if (!win) {
            tell(
                'La fenêtre de projection a été bloquée',
                'Autorisez les fenêtres pop-up pour ce site, puis réessayez.'
            );
            return;
        }
        P.win = win;
        build(win);
        if (!target && root.screen?.isExtended) {
            try {
                target = await otherScreen(); // the browser asks once
                if (target && !win.closed) {
                    win.moveTo(target.availLeft, target.availTop);
                    win.resizeTo(target.availWidth, target.availHeight);
                }
            } catch {
                target = null;
            }
        }
        if (!win.closed)
            win.document.getElementById('hint').querySelector('span').textContent = target
                ? 'Cliquez dans cette fenêtre pour la passer en plein écran'
                : "Faites glisser cette fenêtre sur l'écran du projecteur, puis cliquez dedans pour la passer en plein écran";
        listen();
        updateChip();
        root.tllmRoom?.network?.sync?.(); // the pictures shown there are wanted whole
    };

    P.close = function () {
        if (P.isOpen()) P.win.close();
        closed();
    };

    function closed() {
        P.win = null;
        since.clear();
        boardStream?.getTracks().forEach((t) => t.stop());
        boardStream = null;
        updateChip();
    }

    function listen() {
        if (listening || !rc?.socket) return;
        listening = true;
        rc.socket.on('audioVolume', (data) => data?.peer_id && spoke.set(data.peer_id, Date.now()));
        root.addEventListener('pagehide', () => P.isOpen() && P.win.close());
    }

    // "Projection en cours" in the top strip of the meeting, to stop it from there
    function updateChip() {
        let chip = $('tllmProjecting');
        if (!P.isOpen()) return chip?.remove();
        if (chip) return;
        chip = document.createElement('button');
        chip.type = 'button';
        chip.id = 'tllmProjecting';
        chip.className = 'tllm-top-btn tllm-projecting';
        chip.title = 'Arrêter la projection';
        chip.innerHTML =
            '<i class="fas fa-person-chalkboard" aria-hidden="true"></i><span class="tllm-lbl">Projection en cours</span><i class="fas fa-xmark" aria-hidden="true"></i>';
        chip.onclick = () => P.close();
        const copy = $('tllmCopyLink');
        if (copy) copy.before(chip);
        else $('tllmTop')?.appendChild(chip);
    }

    // The room's colours, carried over to the window
    function tokens() {
        const style = getComputedStyle(document.documentElement);
        return ['bg', 'surface', 'surface-2', 'text', 'text-2', 'accent', 'danger', 'radius', 'font']
            .map((name) => {
                const value = style.getPropertyValue(`--tllm-${name}`).trim();
                return value ? `--${name}:${value};` : '';
            })
            .join('');
    }

    function build(win) {
        const doc = win.document;
        const icons = document.querySelector('link[href*="font-awesome"]')?.href || '';
        doc.open();
        doc.write(`<!doctype html>
<html lang="fr" translate="no"><head><meta charset="utf-8"><title>Projection</title>
${icons ? `<link rel="stylesheet" href="${icons}">` : ''}
<style>${CSS.replace('/*TOKENS*/', tokens())}</style></head>
<body class="is-wait">
<main id="stage"><video id="mainVideo" autoplay playsinline muted></video><div id="notes"><div class="ql-editor"></div></div>
<p id="mainLabel"></p></main>
<aside id="people"></aside>
<section id="wait"><h1 id="waitRoom"></h1><p>Pour rejoindre la visio :</p><p id="waitLink"></p></section>
<footer id="foot"><span id="footRoom"></span><span id="footRec" hidden><i class="fas fa-circle"></i> Enregistrement</span><span id="footClock"></span></footer>
<button type="button" id="hint"><i class="fas fa-expand"></i><span></span></button>
</body></html>`);
        doc.close();
        doc.title = `Projection · ${rc.room_id || ''}`;
        doc.getElementById('waitRoom').textContent = rc.room_id || '';
        doc.getElementById('waitLink').textContent = `${location.host}/join/${rc.room_id || ''}`;
        doc.getElementById('footRoom').textContent = rc.room_id || '';

        const fullscreen = () => {
            if (doc.fullscreenElement) doc.exitFullscreen?.();
            else doc.documentElement.requestFullscreen?.().catch(() => {});
        };
        doc.addEventListener('click', () => !doc.fullscreenElement && fullscreen());
        doc.addEventListener('dblclick', () => doc.fullscreenElement && fullscreen());
        doc.addEventListener('keydown', (e) => e.key.toLowerCase() === 'f' && fullscreen());
        doc.addEventListener('fullscreenchange', () => doc.body.classList.toggle('is-full', !!doc.fullscreenElement));
        // The pointer disappears when it stays still
        let idle;
        doc.addEventListener('mousemove', () => {
            doc.body.classList.remove('is-idle');
            clearTimeout(idle);
            idle = setTimeout(() => doc.body.classList.add('is-idle'), 2500);
        });
        win.addEventListener('pagehide', () => win === P.win && closed());
        // Driven by the window's own clock: the meeting window may be behind the slides, slowed down
        win.setInterval(() => render(win), 400);
        render(win);
    }

    // ####################################################
    // DRAWING
    // ####################################################

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

    // The meeting's tiles, as MiroTalk draws them
    function collect() {
        const peers = new Map((root.tllmRoom?.peers || []).map((p) => [p.id, p]));
        const tiles = new Map();
        document.querySelectorAll('#videoPinMediaContainer .Camera, #videoMediaContainer .Camera').forEach((d) => {
            const peerId = d.dataset.peerId;
            if (!peerId) return;
            const video = d.querySelector('video');
            const stream = d.dataset.cameraOff === 'true' ? null : video?.srcObject || null;
            const screen = !!video && !video.hasAttribute('name');
            if (screen && !stream) return;
            const key = video?.id || `${peerId}-off`;
            if (!since.has(key)) since.set(key, Date.now());
            const peer = peers.get(peerId);
            const name =
                peer?.name ||
                $(`${peerId}__name`)
                    ?.textContent?.replace(/\(me\)/, '')
                    .trim() ||
                '';
            tiles.set(key, {
                key,
                peerId,
                screen,
                stream,
                name,
                since: since.get(key),
                audio: peer ? peer.audio : true,
                hand: !!peer?.hand,
            });
        });
        for (const key of since.keys()) if (!tiles.has(key)) since.delete(key);
        return [...tiles.values()];
    }

    function presented() {
        const board = root.tllmBoard;
        if (board?.open && board.canvas) return 'board';
        if (rc.isEditorOpen && root.tllmEditor?.quill) return 'notes';
        return null;
    }

    function setStream(video, stream) {
        if (video.srcObject !== stream) {
            video.srcObject = stream;
            if (stream) video.play?.().catch(() => {});
        }
    }

    function render(win) {
        if (win.closed || win !== P.win) return;
        const doc = win.document;
        const body = doc.body;
        if (!body || typeof rc === 'undefined' || !rc) return;
        const now = Date.now();
        const content = presented();
        const { main, people } = arrange({ tiles: collect(), content, me: rc.peer_id, spoke });

        body.className = body.className.replace(/\bis-(wait|grid|stage)\b/g, '').trim();
        body.classList.add(main ? 'is-stage' : people.length ? 'is-grid' : 'is-wait');

        // What is presented
        const video = doc.getElementById('mainVideo');
        const notes = doc.getElementById('notes');
        const label = doc.getElementById('mainLabel');
        video.hidden = !main || main.kind === 'notes';
        notes.hidden = main?.kind !== 'notes';
        if (main?.kind === 'screen') {
            setStream(video, main.tile.stream);
            label.textContent =
                main.tile.peerId === rc.peer_id ? '' : `Écran partagé par ${main.tile.name || 'un participant'}`;
        } else if (main?.kind === 'board') {
            const canvas = root.tllmBoard.canvas;
            if (!boardStream && canvas.lowerCanvasEl?.captureStream) {
                boardStream = canvas.lowerCanvasEl.captureStream(15);
                canvas.requestRenderAll();
            }
            setStream(video, boardStream);
            label.textContent = 'Tableau blanc';
        } else if (main?.kind === 'notes') {
            setStream(video, null);
            const source = root.tllmEditor.quill.root;
            const target = notes.firstElementChild;
            // Quill's own rendering, already shown in the meeting window
            if (target.innerHTML !== source.innerHTML) target.innerHTML = source.innerHTML;
            const range = source.scrollHeight - source.clientHeight;
            const ratio = range > 0 ? source.scrollTop / range : 0;
            notes.scrollTop = ratio * (notes.scrollHeight - notes.clientHeight);
            label.textContent = 'Notes partagées';
        } else {
            setStream(video, null);
            label.textContent = '';
        }
        label.hidden = !label.textContent;

        // The people at a distance
        const host = doc.getElementById('people');
        const wanted = new Set(people.map((t) => t.key));
        host.querySelectorAll('.tile').forEach((el) => !wanted.has(el.dataset.key) && el.remove());
        people.forEach((t, index) => {
            let el = [...host.children].find((c) => c.dataset.key === t.key);
            if (!el) {
                el = doc.createElement('div');
                el.className = 'tile';
                el.dataset.key = t.key;
                el.innerHTML =
                    '<video autoplay playsinline muted></video><span class="avatar"></span><span class="name"><i class="fas fa-hand"></i><i class="fas fa-microphone-slash"></i><b></b></span>';
            }
            if (host.children[index] !== el) host.insertBefore(el, host.children[index] || null);
            const v = el.querySelector('video');
            setStream(v, t.stream);
            v.hidden = !t.stream;
            const avatar = el.querySelector('.avatar');
            avatar.hidden = !!t.stream;
            avatar.textContent = initials(t.name);
            avatar.style.background = colorFor(t.name);
            el.querySelector('b').textContent = t.name;
            el.classList.toggle('muted', !t.audio);
            el.classList.toggle('hand', t.hand);
            el.classList.toggle('speaking', now - (spoke.get(t.peerId) || 0) < 1200);
        });
        host.hidden = !!main && !people.length;
        if (!main && people.length) {
            const fit = fitGrid(people.length, host.clientWidth, host.clientHeight);
            host.style.setProperty('--w', `${fit.w}px`);
            host.style.setProperty('--h', `${fit.h}px`);
        } else {
            host.style.removeProperty('--w');
            host.style.removeProperty('--h');
        }

        const recording = (root.tllmRoom?.recordingBy?.size || 0) > 0 || !!(rc.isRecording && rc.isRecording());
        doc.getElementById('footRec').hidden = !recording;
        doc.getElementById('footClock').textContent = new Date().toLocaleTimeString('fr-FR', {
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    const CSS = `
:root{/*TOKENS*/color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;height:100%;overflow:hidden}
body{background:var(--bg,#121416);color:var(--text,#e9ebed);font-family:var(--font,system-ui,sans-serif);
  display:grid;grid-template-columns:1fr auto;grid-template-rows:1fr auto;gap:16px;padding:16px;cursor:default}
body.is-idle.is-full{cursor:none}
[hidden]{display:none!important}
#stage{grid-column:1;grid-row:1;position:relative;min-width:0;min-height:0;display:flex;align-items:center;justify-content:center}
#mainVideo{width:100%;height:100%;object-fit:contain;border-radius:var(--radius,10px)}
#notes{width:100%;height:100%;overflow:hidden;background:#fff;color:#1d1d1f;border-radius:var(--radius,10px)}
#notes .ql-editor{max-width:1100px;margin:0 auto;padding:48px 64px;font-size:clamp(20px,2.2vw,34px);line-height:1.5}
#notes img{max-width:100%}
#notes .ql-editor :is(h1,h2,h3){line-height:1.2}
#mainLabel{position:absolute;left:12px;top:12px;margin:0;padding:6px 12px;border-radius:999px;background:rgba(0,0,0,.6);color:#fff;font-size:15px}
#people{grid-column:2;grid-row:1;display:flex;flex-direction:column;justify-content:center;gap:12px;width:clamp(200px,19vw,360px);min-height:0}
#wait{display:none}
.tile{position:relative;flex:none;width:100%;aspect-ratio:16/9;background:var(--surface,#1a1d20);border-radius:var(--radius,10px);overflow:hidden;outline:3px solid transparent;outline-offset:-3px;transition:outline-color .2s}
.tile.speaking{outline-color:var(--accent,#4c8dff)}
.tile video{width:100%;height:100%;object-fit:cover;display:block}
.avatar{position:absolute;inset:0;margin:auto;width:28%;aspect-ratio:1;height:auto;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:600;font-size:clamp(16px,2.4vw,48px)}
.name{position:absolute;left:8px;bottom:8px;max-width:calc(100% - 16px);display:flex;gap:6px;align-items:center;padding:4px 10px;border-radius:999px;background:rgba(0,0,0,.6);color:#fff;font-size:clamp(12px,1vw,18px);white-space:nowrap}
.name b{font-weight:500;overflow:hidden;text-overflow:ellipsis}
.name i{display:none}
.tile.muted .fa-microphone-slash{display:inline;color:#ff8a8d}
.tile.hand .fa-hand{display:inline;color:#ffd166}
body.is-grid #stage{display:none}
body.is-grid #people{grid-column:1/3;width:auto;flex-flow:row wrap;align-content:center;justify-content:center}
body.is-grid .tile{width:var(--w,320px);height:var(--h,180px);aspect-ratio:auto}
body.is-grid .name{font-size:clamp(14px,1.4vw,24px)}
body.is-wait #stage,body.is-wait #people{display:none}
body.is-wait #wait{grid-column:1/3;grid-row:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
#wait h1{margin:0 0 24px;font-size:clamp(32px,5vw,80px);font-weight:600}
#wait p{margin:4px;font-size:clamp(18px,2vw,32px);color:var(--text-2,#a9afb5)}
#waitLink{color:var(--text,#e9ebed)!important;font-weight:600}
#foot{grid-column:1/3;grid-row:2;display:flex;gap:16px;align-items:center;color:var(--text-2,#a9afb5);font-size:15px}
#footRoom{font-weight:600;color:var(--text,#e9ebed)}
#footRec{color:#ff8a8d}#footRec i{font-size:10px}
#footClock{margin-left:auto}
#hint{position:fixed;left:50%;bottom:56px;transform:translateX(-50%);display:flex;gap:10px;align-items:center;max-width:calc(100% - 32px);
  padding:12px 20px;border:0;border-radius:999px;background:var(--accent,#4c8dff);color:#fff;font:inherit;font-size:16px;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.35)}
body.is-full #hint{display:none}
`;
})(typeof window !== 'undefined' ? window : globalThis);
