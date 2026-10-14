'use strict';

// TLLM*meet "meeting not started yet" page: polls the server and joins as soon as the admin opens it.

(function () {
    const POLL_MS = 5000;
    const parts = window.location.pathname.split('/');
    let roomId = '';
    try {
        roomId = decodeURIComponent(parts[parts.length - 1] || '');
    } catch {}

    const nameEl = document.getElementById('waitingRoomName');
    const stateEl = document.getElementById('waitingState');
    const statusEl = document.getElementById('waitingStatus');
    const elapsedEl = document.getElementById('waitingElapsed');
    const loginLink = document.getElementById('waitingRoomLoginLink');

    const text = (key, fallback) => (typeof BRAND !== 'undefined' && BRAND?.whoAreYou?.[key]) || fallback;

    if (roomId) {
        nameEl.textContent = roomId;
        nameEl.hidden = false;
        loginLink.href = '/login?room=' + encodeURIComponent(roomId);
    }

    const started = Date.now();
    function updateElapsed() {
        const minutes = Math.floor((Date.now() - started) / 60000);
        elapsedEl.textContent =
            minutes < 1
                ? text('waitingRoomElapsedJust', "Depuis moins d'une minute")
                : text('waitingRoomElapsedMinutes', 'Attente : {minutes}').replace(
                      '{minutes}',
                      minutes + (minutes === 1 ? ' minute' : ' minutes')
                  );
    }
    updateElapsed();
    setInterval(updateElapsed, 30000);

    let timer = null;
    async function check() {
        timer = null;
        try {
            const res = await fetch('/isRoomActive', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ roomId }),
            });
            const data = await res.json();
            if (data && data.message === true) {
                statusEl.textContent = text('waitingRoomReady', 'La visio commence, connexion…');
                stateEl.classList.add('is-ready');
                // Keep the original join parameters (name, audio, video...)
                window.location.href = '/join/' + encodeURIComponent(roomId) + window.location.search;
                return;
            }
        } catch {}
        statusEl.textContent = text('waitingRoomWaiting', "En attente de l'organisateur…");
        schedule();
    }

    function schedule() {
        if (!timer) timer = setTimeout(() => (document.visibilityState === 'visible' ? check() : schedule()), POLL_MS);
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            clearTimeout(timer);
            check();
        }
    });

    if (roomId) check();
})();
