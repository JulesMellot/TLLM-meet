'use strict';

// TLLM*meet: the page of a phone in the meeting room (/salle/<room>#<key>), opened from the QR code
// of the projector. Votes in the polls, reactions and questions, without joining the video call.
// The server only lets it do that (app/src/Audience.js).

(function () {
    const $ = (id) => document.getElementById(id);
    const REACTIONS = ['👏', '👍', '❤️', '😂', '😮', '🎉'];
    const roomId = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
    const key = decodeURIComponent(location.hash.slice(1));

    const store = {
        get(name) {
            try {
                return localStorage.getItem(name) || '';
            } catch {
                return '';
            }
        },
        set(name, value) {
            try {
                localStorage.setItem(name, value);
            } catch {
                /* the page works without it */
            }
        },
    };
    const randomId = () =>
        window.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    let clientId = store.get('tllm-salle-id');
    if (!/^[a-z0-9-]{8,64}$/i.test(clientId)) {
        clientId = randomId();
        store.set('tllm-salle-id', clientId);
    }

    let socket = null;
    let name = store.get('tllm-salle-name');
    let polls = [];
    let joined = false;

    function show(id) {
        ['noKey', 'enter', 'inside', 'ended'].forEach((s) => ($(s).hidden = s !== id));
    }

    let toastTimer;
    function toast(text) {
        const el = $('toast');
        el.textContent = text;
        el.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => (el.hidden = true), 2200);
    }

    function setRoomName(text) {
        $('enterRoom').textContent = text;
        $('insideRoom').textContent = text;
        document.title = `${text} · dans la salle`;
    }

    // ---------------- Connection ----------------

    function connect() {
        if (socket) return;
        socket = io({ transports: ['websocket', 'polling'] });
        socket.on('connect', () => joined && join()); // back after a cut: same phone, same votes
        socket.on('disconnect', () => setStatus(false));
        socket.on('updatePolls', (list) => {
            polls = Array.isArray(list) ? list : [];
            renderPolls();
        });
        socket.on('audienceEnded', ended);
    }

    function join() {
        return new Promise((resolve) => {
            socket.emit('audienceJoin', { room_id: roomId, key, name, clientId }, (answer) => {
                if (answer?.ok) {
                    joined = true;
                    setRoomName(answer.name || roomId);
                    polls = Array.isArray(answer.polls) ? answer.polls : [];
                    setStatus(true);
                    renderPolls();
                    show('inside');
                } else if (answer?.ended && joined) {
                    ended();
                }
                resolve(answer || { error: 'Pas de réponse du serveur.' });
            });
        });
    }

    function ended() {
        joined = false;
        show('ended');
        socket?.disconnect();
    }

    function setStatus(online) {
        $('insideStatus').textContent = online ? 'Connecté' : 'Reconnexion…';
        document.body.classList.toggle('is-offline', !online);
    }

    // ---------------- Polls ----------------

    function countdown(poll) {
        if (!poll.endsAt || poll.closed) return '';
        const s = Math.max(0, Math.round((poll.endsAt - Date.now()) / 1000));
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }

    function renderPolls() {
        const host = $('polls');
        const now = Date.now();
        polls.forEach((p) => (p.endsAt = p.remainingMs != null ? now + p.remainingMs : null));
        // Open polls first, then the results of the closed ones (newest first)
        const list = [...polls].reverse().sort((a, b) => Number(a.closed) - Number(b.closed));
        host.textContent = '';
        if (!list.length) {
            const p = document.createElement('p');
            p.className = 'tllm-hint';
            p.textContent = 'Aucun sondage pour l’instant. Il apparaîtra ici dès qu’il sera lancé.';
            host.appendChild(p);
            return;
        }
        for (const poll of list) host.appendChild(pollCard(poll));
    }

    function pollCard(poll) {
        const card = document.createElement('article');
        card.className = 'tllm-salle-poll' + (poll.closed ? ' is-closed' : '');
        const head = document.createElement('div');
        head.className = 'tllm-salle-poll-head';
        const q = document.createElement('h3');
        q.textContent = poll.question;
        const tag = document.createElement('span');
        tag.className = 'tllm-salle-tag';
        tag.dataset.countdown = poll.id;
        tag.textContent = poll.closed ? 'Terminé' : countdown(poll) || 'En cours';
        head.append(q, tag);
        card.appendChild(head);

        const mine = new Set(poll.myVotes || []);
        const total = (poll.counts || []).reduce((a, b) => a + b, 0);
        poll.options.forEach((option, i) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'tllm-salle-option' + (mine.has(option) ? ' is-mine' : '');
            btn.disabled = poll.closed;
            btn.setAttribute('aria-pressed', String(mine.has(option)));
            const label = document.createElement('span');
            label.className = 'tllm-salle-option-label';
            label.textContent = option;
            btn.appendChild(label);
            if (poll.counts) {
                const pct = total ? Math.round((poll.counts[i] / total) * 100) : 0;
                btn.style.setProperty('--pct', `${pct}%`);
                const value = document.createElement('span');
                value.className = 'tllm-salle-option-value';
                value.textContent = `${pct} %`;
                btn.appendChild(value);
            }
            btn.onclick = () => vote(poll, option);
            card.appendChild(btn);
        });

        const foot = document.createElement('p');
        foot.className = 'tllm-hint';
        const parts = [`${poll.total} vote${poll.total > 1 ? 's' : ''}`];
        if (!poll.closed) parts.push(poll.multiple ? 'plusieurs réponses possibles' : 'une seule réponse');
        if (!poll.counts) parts.push('résultats à la clôture');
        if (poll.anonymous) parts.push('anonyme');
        else if (!poll.closed) parts.push('votre prénom est visible des organisateurs');
        foot.textContent = parts.join(' · ');
        card.appendChild(foot);
        return card;
    }

    function vote(poll, option) {
        if (poll.closed || !socket?.connected) return;
        const mine = new Set(poll.myVotes || []);
        if (poll.multiple) {
            if (mine.has(option)) mine.delete(option);
            else mine.add(option);
        } else if (mine.has(option)) {
            mine.clear(); // tapped again: the vote is withdrawn
        } else {
            mine.clear();
            mine.add(option);
        }
        socket.emit('audienceVote', { pollId: poll.id, options: [...mine] });
        poll.myVotes = [...mine]; // shown at once, the server confirms
        renderPolls();
        if (navigator.vibrate) navigator.vibrate(15);
    }

    setInterval(() => {
        document.querySelectorAll('[data-countdown]').forEach((el) => {
            const poll = polls.find((p) => p.id === el.dataset.countdown);
            if (poll && !poll.closed && poll.endsAt) el.textContent = countdown(poll);
        });
    }, 1000);

    // ---------------- Reactions and questions ----------------

    function buildReactions() {
        const host = $('reactions');
        for (const emoji of REACTIONS) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = emoji;
            btn.setAttribute('aria-label', `Réagir ${emoji}`);
            btn.onclick = () => {
                if (!socket?.connected) return;
                socket.emit('audienceReact', { emoji });
                btn.classList.remove('is-sent');
                void btn.offsetWidth;
                btn.classList.add('is-sent');
            };
            host.appendChild(btn);
        }
    }

    $('askForm').onsubmit = (e) => {
        e.preventDefault();
        const text = $('askText').value.trim();
        if (!text || !socket?.connected) return;
        $('askButton').disabled = true;
        socket.emit('audienceQuestion', { text }, (answer) => {
            $('askButton').disabled = false;
            $('askError').textContent = answer?.error || '';
            if (answer?.ok) {
                $('askText').value = '';
                toast('Question envoyée');
            }
        });
    };

    // ---------------- Start ----------------

    $('enterForm').onsubmit = async (e) => {
        e.preventDefault();
        name = $('enterName').value.trim();
        if (!name) return;
        store.set('tllm-salle-name', name);
        $('enterButton').disabled = true;
        $('enterError').textContent = '';
        connect();
        const answer = await join();
        $('enterButton').disabled = false;
        if (!answer.ok) $('enterError').textContent = answer.error || 'Impossible d’entrer.';
        else $('insideName').textContent = name;
    };

    if (!key) {
        show('noKey');
        return;
    }
    setRoomName(roomId);
    fetch(`/api/room/${encodeURIComponent(roomId)}`, { cache: 'no-store' })
        .then((res) => (res.ok ? res.json() : null))
        .then((info) => !joined && info?.name && setRoomName(info.name))
        .catch(() => {});
    $('enterName').value = name;
    buildReactions();
    show('enter');
})();
