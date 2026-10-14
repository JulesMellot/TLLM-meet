'use strict';

// TLLM*meet home: guests see "you need a link", the logged-in admin can create a meeting.

(function () {
    const guestView = document.getElementById('guestView');
    const adminView = document.getElementById('adminView');
    const adminName = document.getElementById('adminName');
    const form = document.getElementById('newRoomForm');
    const input = document.getElementById('roomName');
    const button = document.getElementById('createRoomButton');
    const error = document.getElementById('createRoomError');

    fetch('/admin/session', { credentials: 'same-origin' })
        .then((res) => res.json())
        .then((session) => {
            if (!session || !session.admin) return;
            adminName.textContent = session.name || '';
            guestView.hidden = true;
            adminView.hidden = false;
            input.focus();
        })
        .catch(() => {});

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        error.textContent = '';
        button.disabled = true;
        try {
            const res = await fetch('/admin/rooms', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: input.value.trim() }),
            });
            if (res.status === 401) {
                window.location.href = '/login';
                return;
            }
            if (!res.ok) throw new Error(String(res.status));
            const data = await res.json();
            window.location.href = data.url;
        } catch {
            error.textContent = 'Impossible de créer la visio. Réessayez.';
            button.disabled = false;
        }
    });
})();
