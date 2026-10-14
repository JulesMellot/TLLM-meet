'use strict';

// TLLM*meet admin login. The server answers with an HttpOnly session cookie (no token in JS).

(function () {
    const form = document.getElementById('loginForm');
    const username = document.getElementById('username');
    const password = document.getElementById('password');
    const button = document.getElementById('loginButton');
    const error = document.getElementById('loginError');

    // Room requested before login (/login?room=xxx): go there right after login
    const room = new URLSearchParams(window.location.search).get('room');
    const next = () => {
        window.location.href = room ? '/join/' + encodeURIComponent(room) : '/';
    };

    // Already logged in
    fetch('/admin/session', { credentials: 'same-origin' })
        .then((res) => res.json())
        .then((session) => session && session.admin && next())
        .catch(() => {});

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        error.textContent = '';
        button.disabled = true;
        try {
            const res = await fetch('/login', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: username.value.trim(), password: password.value }),
            });
            if (res.ok) {
                const data = await res.json();
                if (data && data.name) window.localStorage.peer_name = data.name;
                return next();
            }
            error.textContent =
                res.status === 429 ? 'Trop de tentatives. Réessayez plus tard.' : 'Identifiant ou mot de passe incorrect.';
        } catch {
            error.textContent = 'Connexion impossible. Vérifiez votre réseau.';
        }
        button.disabled = false;
        password.select();
    });
})();
