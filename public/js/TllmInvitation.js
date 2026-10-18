'use strict';

// TLLM*meet: the link an admin sent to a future moderator (/invitation/<token>).
// Creates the account (username, password, confirmation) or sets a new password. The server
// logs the person in right away, then the home page opens.

(function () {
    const $ = (id) => document.getElementById(id);
    const token = window.location.pathname.split('/').pop();
    const api = `/api/invitation/${encodeURIComponent(token)}`;
    let kind = 'create';

    function show(id) {
        for (const view of ['loading', 'invalidView', 'formView']) $(view).hidden = view !== id;
    }

    function setup(invitation) {
        kind = invitation.kind;
        if (kind === 'reset') {
            document.title = 'Nouveau mot de passe · TLLM*meet';
            $('heading').textContent = 'Nouveau mot de passe';
            $('lead').textContent =
                `Choisissez le nouveau mot de passe du compte${invitation.name ? ` de ${invitation.name}` : ''}. L’ancien ne marchera plus.`;
            $('usernameField').hidden = true;
            $('rules').textContent = 'De 8 à 36 caractères.';
            $('submitButton').textContent = 'Enregistrer';
        } else {
            document.title = 'Créer votre compte · TLLM*meet';
            $('lead').textContent =
                'Vous avez reçu une invitation pour organiser des visios. Choisissez l’identifiant et le mot de passe avec lesquels vous vous connecterez.';
        }
        show('formView');
        (kind === 'reset' ? $('password') : $('username')).focus();
    }

    $('inviteForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const error = $('formError');
        const button = $('submitButton');
        error.textContent = '';
        const body = { password: $('password').value, confirm: $('confirm').value };
        if (kind === 'create') body.username = $('username').value.trim();
        if (kind === 'create' && !body.username) {
            error.textContent = 'Choisissez un identifiant.';
            return;
        }
        if (body.password.length < 8) {
            error.textContent = 'Le mot de passe doit faire au moins 8 caractères.';
            return;
        }
        if (body.password !== body.confirm) {
            error.textContent = 'Les deux mots de passe ne sont pas identiques.';
            return;
        }
        button.disabled = true;
        try {
            const res = await fetch(api, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await res.json().catch(() => ({}));
            if (res.status === 404) return show('invalidView');
            if (!res.ok) throw new Error(data.error || 'Erreur, réessayez.');
            if (data.name) window.localStorage.peer_name = data.name;
            window.location.href = '/';
        } catch (err) {
            error.textContent = err.message;
            button.disabled = false;
        }
    });

    fetch(api, { credentials: 'same-origin' })
        .then((res) => (res.ok ? res.json() : null))
        .then((invitation) => (invitation ? setup(invitation) : show('invalidView')))
        .catch(() => {
            $('loading').textContent = 'Impossible de charger la page. Réessayez.';
        });
})();
