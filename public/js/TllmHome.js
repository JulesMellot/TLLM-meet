'use strict';

// TLLM*meet home.
// Guests: a field to paste the link they received.
// Organiser: the corridor. Every room with its band (en cours, réservée, fermée), the agenda of
// the dates fixed by the polls, and the polls still waiting for answers. Data: /api/admin/overview.
// An admin (HOST_USERS) sees everyone's rooms and polls, and manages the moderator accounts
// (/api/admin/moderators). A moderator sees only their own.

(function () {
    const $ = (id) => document.getElementById(id);
    const state = { timeZone: 'Europe/Paris', overview: null };

    // ---------- small helpers ----------

    const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    const fmt = (ms, opts) =>
        new Intl.DateTimeFormat('fr-FR', { timeZone: state.timeZone, ...opts }).format(new Date(ms));
    const hour = (ms) => fmt(ms, { hour: '2-digit', minute: '2-digit' });
    const dayKey = (ms) => fmt(ms, { year: 'numeric', month: '2-digit', day: '2-digit' });

    function dayLabel(ms) {
        const today = Date.now();
        if (dayKey(ms) === dayKey(today)) return "aujourd'hui";
        if (dayKey(ms) === dayKey(today + 86400000)) return 'demain';
        if (dayKey(ms) === dayKey(today - 86400000)) return 'hier';
        return `le ${fmt(ms, { weekday: 'long', day: 'numeric', month: 'long' })}`;
    }

    function minutesSince(ms) {
        const min = Math.max(0, Math.round((Date.now() - ms) / 60000));
        if (min < 1) return "moins d'une minute";
        if (min < 60) return `${min} min`;
        const h = Math.floor(min / 60);
        return `${h} h${min % 60 ? ` ${String(min % 60).padStart(2, '0')}` : ''}`;
    }

    const duration = (ms) => {
        const min = Math.round(ms / 60000);
        return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60}` : ''}`;
    };

    function names(people, count) {
        if (!people.length) return '';
        const shown = people.slice(0, 2);
        const rest = count - shown.length;
        if (rest <= 0) return shown.join(' et ');
        return `${shown.join(', ')} et ${rest} autre${rest > 1 ? 's' : ''}`;
    }

    function el(tag, cls, text) {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function toast(text) {
        const t = $('toast');
        t.textContent = text;
        t.hidden = false;
        clearTimeout(toast.timer);
        toast.timer = setTimeout(() => (t.hidden = true), 2600);
    }

    function copy(text) {
        if (!navigator.clipboard) return toast(text);
        navigator.clipboard.writeText(text).then(
            () => toast('Lien copié'),
            () => toast(text)
        );
    }

    const slugify = (s) =>
        s
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 40);

    // ---------- guest: go to a room from a pasted link or a dictated name ----------

    $('goForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const raw = $('goInput').value.trim();
        const error = $('goError');
        error.textContent = '';
        if (!raw) {
            error.textContent = 'Collez le lien reçu, ou tapez le nom de la salle.';
            return;
        }
        const found = raw.match(/\/(join|rdv)\/([A-Za-z0-9_.~-]+)/);
        if (found) {
            window.location.href = `/${found[1]}/${encodeURIComponent(found[2])}`;
            return;
        }
        // A web address that is not a meeting link, or nothing usable
        const slug = slugify(raw);
        if (!slug || /:\/\/|^www\.|\//.test(raw)) {
            error.textContent = 'Ce n’est pas un lien de visio. Vérifiez le message reçu.';
            return;
        }
        window.location.href = `/join/${encodeURIComponent(slug)}`;
    });

    // ---------- organiser ----------

    function tick() {
        $('today').textContent = cap(fmt(Date.now(), { weekday: 'long', day: 'numeric', month: 'long' }));
        $('clock').textContent = hour(Date.now());
    }

    function updatePreview() {
        const slug = slugify($('roomName').value) || 'nouvelle-salle';
        const note = $('roomPreview');
        note.textContent = 'Lien créé : ';
        note.append(el('b', '', `${window.location.host}/join/${slug}-xxxxxx`));
        note.append('. La fin aléatoire empêche de deviner l’adresse.');
    }

    function roomRow(room) {
        const live = room.active;
        const soon = !live && room.booking && room.booking.start - Date.now() < 24 * 3600000;
        const li = el('li', `tllm-room${live ? ' is-live' : soon ? ' is-soon' : ''}`);
        li.append(el('span', 'tllm-room-tab'));

        const text = el('div');
        text.append(el('div', 'tllm-room-name-row', room.name));
        const stateLine = el('div', 'tllm-room-state');
        if (live) {
            stateLine.append(el('strong', '', room.since ? `En cours depuis ${minutesSince(room.since)}` : 'En cours'));
            const who = names(room.people, room.count);
            stateLine.append(who ? `, avec ${who}` : ', personne dedans');
        } else if (room.booking) {
            stateLine.append(
                el('strong', '', `Réservée ${dayLabel(room.booking.start)} à ${hour(room.booking.start)}`)
            );
            stateLine.append(', date fixée par le sondage');
        } else if (room.lastUsedAt) {
            stateLine.append(`Fermée, dernière visio ${dayLabel(room.lastUsedAt)}`);
        } else {
            stateLine.append('Jamais ouverte');
        }
        text.append(stateLine);
        if (room.organizer) text.append(el('div', 'tllm-room-owner', `Salle de ${room.organizer}`));
        li.append(text);

        const actions = el('div', 'tllm-room-actions');
        const url = `/join/${encodeURIComponent(room.id)}`;
        const copyBtn = el('button', 'tllm-button is-quiet is-small', 'Copier le lien');
        copyBtn.type = 'button';
        copyBtn.onclick = () => copy(`${window.location.origin}${url}`);
        const go = el(
            'a',
            `tllm-button is-small${live ? '' : ' is-quiet'}`,
            live ? 'Rejoindre' : room.lastUsedAt ? 'Rouvrir' : 'Ouvrir'
        );
        go.href = url;
        // Latest meeting transcription, once it is final
        const t = room.transcript;
        if (t && (t.status === 'ready' || t.status === 'paused')) {
            const dl = el('a', 'tllm-button is-quiet is-small', 'Transcription');
            dl.href = `/transcriptions/${encodeURIComponent(room.id)}/${t.id}.txt`;
            dl.setAttribute('download', '');
            dl.title = 'Télécharger la transcription de la dernière visio';
            actions.append(dl);
        }
        actions.append(copyBtn, go);
        li.append(actions);
        return li;
    }

    function renderRooms(rooms) {
        const list = $('rooms');
        list.textContent = '';
        if (!rooms.length) {
            list.append(
                el('li', 'tllm-empty', 'Aucune salle pour l’instant. Donnez un nom ci-dessus pour ouvrir la première.')
            );
            return;
        }
        rooms.forEach((room) => list.append(roomRow(room)));
    }

    function renderAgenda(agenda) {
        const list = $('agenda');
        list.textContent = '';
        if (!agenda.length) {
            list.append(el('li', 'tllm-empty', 'Aucune date fixée pour l’instant.'));
            list.firstChild.style.padding = '0 0 6px';
            return;
        }
        let lastDay = '';
        for (const item of agenda) {
            const key = dayKey(item.start);
            if (key !== lastDay) {
                lastDay = key;
                list.append(el('li', 'tllm-agenda-day', cap(dayLabel(item.start).replace(/^le /, ''))));
            }
            const li = el('li', 'tllm-agenda-item');
            const a = el('a');
            a.href = `/rdv/${encodeURIComponent(item.id)}`;
            a.append(el('span', 'tllm-agenda-time', hour(item.start)));
            a.append(el('span', 'tllm-agenda-what', item.title));
            const how = `${duration(item.end - item.start)}, ${item.available} personne${item.available > 1 ? 's' : ''} disponible${item.available > 1 ? 's' : ''}`;
            a.append(el('span', 'tllm-agenda-how', item.organizer ? `${how}, par ${item.organizer}` : how));
            li.append(a);
            list.append(li);
        }
    }

    function renderPolls(polls) {
        const list = $('polls');
        list.textContent = '';
        if (!polls.length) {
            list.append(el('li', 'tllm-empty', 'Aucun sondage en cours.'));
            list.firstChild.style.padding = '0';
            return;
        }
        for (const poll of polls) {
            const li = el('li', 'tllm-poll');
            const a = el('a');
            a.href = `/rdv/${encodeURIComponent(poll.id)}`;
            const top = el('div', 'tllm-poll-top');
            top.append(el('span', 'tllm-poll-title', poll.title));
            const count = el('span', 'tllm-poll-count', String(poll.answers));
            count.append(
                el('span', '', poll.expected ? ` sur ${poll.expected}` : ` réponse${poll.answers > 1 ? 's' : ''}`)
            );
            top.append(count);
            a.append(top);
            if (poll.expected && poll.expected <= 30) {
                const ticks = el('div', 'tllm-ticks');
                ticks.setAttribute('aria-hidden', 'true');
                for (let i = 0; i < poll.expected; i++) ticks.append(el('i', i < poll.answers ? 'is-on' : ''));
                a.append(ticks);
            }
            let how;
            if (poll.expected) {
                how = `La date se fixera à la ${poll.expected}${poll.expected === 1 ? 're' : 'e'} réponse`;
                how += poll.deadline ? `, ou ${dayLabel(poll.deadline)}.` : '.';
            } else {
                how = poll.deadline
                    ? `Réponses jusqu’à ${dayLabel(poll.deadline).replace(/^le /, '')}. Vous choisirez la date.`
                    : 'Vous choisirez la date vous-même.';
            }
            a.append(el('p', '', how));
            if (poll.organizer) a.append(el('p', '', `Proposé par ${poll.organizer}`));
            li.append(a);
            list.append(li);
        }
    }

    async function loadOverview() {
        try {
            const res = await fetch('/api/admin/overview', { credentials: 'same-origin' });
            if (!res.ok) return;
            const data = await res.json();
            state.overview = data;
            state.timeZone = data.timeZone || state.timeZone;
            tick();
            renderRooms(data.rooms);
            renderAgenda(data.agenda);
            renderPolls(data.polls);
        } catch {
            /* the next refresh will try again */
        }
    }

    // ---------- admin: moderator accounts ----------
    // The admin only makes links: the person picks the username and password on the link page.

    async function modApi(method, url, body) {
        const res = await fetch(url, {
            method,
            credentials: 'same-origin',
            headers: body ? { 'Content-Type': 'application/json' } : {},
            body: body ? JSON.stringify(body) : undefined,
        });
        if (res.status === 401) {
            window.location.href = '/login';
            throw new Error('');
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Erreur, réessayez.');
        return data;
    }

    // "aujourd'hui", "demain à 16:23", "le 25 oct."
    function shortDay(ms, withHour = false) {
        const label = dayLabel(ms);
        if (!label.startsWith('le ')) return withHour ? `${label} à ${hour(ms)}` : label;
        return `le ${fmt(ms, { day: 'numeric', month: 'short' })}`;
    }
    const expires = (ms) => `expire ${shortDay(ms, true)}`;

    function initials(name) {
        const words = String(name || '?')
            .trim()
            .split(/\s+/);
        return ((words[0]?.[0] || '?') + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
    }

    // A fresh link, shown once under its row (the server keeps only its hash)
    function linkBox(url, lead, note) {
        const box = el('div', 'tllm-mod-link');
        const text = el('p');
        text.append(el('b', '', lead), ` ${note}`);
        const row = el('div', 'tllm-mod-link-row');
        const input = el('input', 'tllm-input');
        input.type = 'text';
        input.readOnly = true;
        input.value = url;
        input.setAttribute('aria-label', 'Lien à envoyer');
        input.onclick = () => input.select();
        const copyBtn = el('button', 'tllm-button is-small', 'Copier');
        copyBtn.type = 'button';
        copyBtn.onclick = () => copy(url);
        row.append(input, copyBtn);
        box.append(text, row);
        return box;
    }

    // "⋯" menu: [label, action, danger] entries, null for a separator
    function rowMenu(label, items) {
        const menu = el('details', 'tllm-menu');
        const summary = el('summary', '', '⋯');
        summary.setAttribute('aria-label', label);
        const list = el('div', 'tllm-menu-list');
        for (const item of items) {
            if (!item) {
                list.append(el('hr'));
                continue;
            }
            const [text, action, danger] = item;
            const b = el('button', danger ? 'is-danger' : '', text);
            b.type = 'button';
            b.onclick = async () => {
                menu.open = false;
                try {
                    await action();
                } catch (err) {
                    if (err.message) toast(err.message);
                }
            };
            list.append(b);
        }
        menu.append(summary, list);
        return menu;
    }

    // Close an open menu on a click elsewhere or Escape
    document.addEventListener('click', (e) => {
        for (const menu of document.querySelectorAll('.tllm-menu[open]')) {
            if (!menu.contains(e.target)) menu.open = false;
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        for (const menu of document.querySelectorAll('.tllm-menu[open]')) {
            menu.open = false;
            menu.querySelector('summary').focus();
        }
    });

    function personRow({ id, name, state, pill, pending, menu }) {
        const li = el('li', `tllm-mod${pending ? ' is-pending' : ''}`);
        li.dataset.id = id;
        const avatar = el('span', 'tllm-mod-avatar', initials(name));
        avatar.setAttribute('aria-hidden', 'true');
        const who = el('div', 'tllm-mod-who');
        const line = el('div', 'tllm-mod-name', name);
        if (pill) line.append(el('span', 'tllm-pill', pill));
        who.append(line, el('div', 'tllm-mod-state', state));
        li.append(avatar, who, menu);
        return li;
    }

    async function sendResetLink(mod) {
        const data = await modApi('POST', `/api/admin/moderators/${encodeURIComponent(mod.id)}/reset`);
        await loadModerators();
        $('mods')
            .querySelector(`[data-id="${mod.id}"]`)
            ?.append(
                linkBox(
                    data.url,
                    `Envoyez ce lien à ${mod.displayname}.`,
                    'Il permet de choisir un nouveau mot de passe, une seule fois, pendant 48 heures.'
                )
            );
    }

    async function removeModerator(mod) {
        if (!window.confirm(`Retirer l’accès de ${mod.displayname} ? Son compte est supprimé et sa session fermée.`)) {
            return;
        }
        await modApi('DELETE', `/api/admin/moderators/${encodeURIComponent(mod.id)}`);
        toast('Accès retiré');
        await loadModerators();
    }

    async function cancelLink(id) {
        await modApi('DELETE', `/api/admin/moderators/invitations/${encodeURIComponent(id)}`);
        await loadModerators();
    }

    function modRow(mod) {
        const items = mod.reset
            ? [
                  ['Envoyer un nouveau lien de mot de passe', () => sendResetLink(mod)],
                  ['Annuler le lien de mot de passe', () => cancelLink(mod.reset.id)],
              ]
            : [['Lien pour changer le mot de passe', () => sendResetLink(mod)]];
        items.push(null, ['Retirer l’accès', () => removeModerator(mod), true]);
        return personRow({
            id: mod.id,
            name: mod.displayname,
            state: mod.reset
                ? `Lien de mot de passe envoyé · ${expires(mod.reset.expiresAt)}`
                : `Compte créé ${shortDay(mod.createdAt)}`,
            pill: mod.reset ? 'Mot de passe' : null,
            menu: rowMenu(`Actions pour ${mod.displayname}`, items),
        });
    }

    function inviteRow(invite) {
        const name = invite.name || 'Invitation';
        return personRow({
            id: invite.id,
            name,
            state: `Invitation envoyée · ${expires(invite.expiresAt)}`,
            pill: 'En attente',
            pending: true,
            menu: rowMenu(`Actions pour ${name}`, [['Annuler l’invitation', () => cancelLink(invite.id), true]]),
        });
    }

    async function loadModerators() {
        const data = await modApi('GET', '/api/admin/moderators');
        const list = $('mods');
        list.textContent = '';
        if (!data.moderators.length && !data.invites.length) {
            list.append(
                el('li', 'tllm-empty', 'Personne pour l’instant. Invitez quelqu’un à organiser ses propres visios.')
            );
        }
        data.invites.forEach((invite) => list.append(inviteRow(invite)));
        data.moderators.forEach((mod) => list.append(modRow(mod)));
    }

    function toggleInviteForm(open) {
        $('modForm').hidden = !open;
        $('modInvite').setAttribute('aria-expanded', String(open));
        $('modInvite').hidden = open;
        $('modError').textContent = '';
        if (open) $('modName').focus();
        else $('modForm').reset();
    }

    $('modInvite').addEventListener('click', () => toggleInviteForm(true));
    $('modCancel').addEventListener('click', () => {
        toggleInviteForm(false);
        $('modInvite').focus();
    });

    $('modForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const button = $('modCreate');
        $('modError').textContent = '';
        button.disabled = true;
        const name = $('modName').value.trim();
        try {
            const data = await modApi('POST', '/api/admin/moderators/invitations', { name });
            toggleInviteForm(false);
            await loadModerators();
            $('mods')
                .querySelector(`[data-id="${data.id}"]`)
                ?.append(
                    linkBox(
                        data.url,
                        `Envoyez ce lien à ${name || 'la personne'}.`,
                        'Elle y choisira son identifiant et son mot de passe. Il sert une fois, pendant 7 jours.'
                    )
                );
        } catch (err) {
            $('modError').textContent = err.message;
        } finally {
            button.disabled = false;
        }
    });

    function showAdmin(session) {
        $('adminName').textContent = session.role === 'moderator' ? `${session.name} (modérateur)` : session.name || '';
        $('adminWho').hidden = false;
        $('logoutLink').hidden = false;
        $('loginLink').hidden = true;
        $('guestView').hidden = true;
        $('adminView').hidden = false;
        document.title = 'Salles · TLLM*meet';
        tick();
        updatePreview();
        loadOverview();
        if (session.role === 'admin') {
            $('modBlock').hidden = false;
            loadModerators().catch(() => {});
            window.tllmServer?.start({ timeZone: state.timeZone }); // the "Serveur" block (TllmServer.js)
        }
        setInterval(tick, 15000);
        setInterval(() => !document.hidden && loadOverview(), 30000);
        document.addEventListener('visibilitychange', () => !document.hidden && loadOverview());
    }

    $('roomName').addEventListener('input', updatePreview);

    $('newRoomForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const error = $('createRoomError');
        const button = $('createRoomButton');
        error.textContent = '';
        button.disabled = true;
        try {
            const res = await fetch('/admin/rooms', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: $('roomName').value.trim() }),
            });
            if (res.status === 401) {
                window.location.href = '/login';
                return;
            }
            if (!res.ok) throw new Error(String(res.status));
            const data = await res.json();
            window.location.href = data.url;
        } catch {
            error.textContent = 'La salle n’a pas pu être créée. Réessayez.';
            button.disabled = false;
        }
    });

    fetch('/admin/session', { credentials: 'same-origin' })
        .then((res) => res.json())
        .then((session) => {
            if (session && session.admin) showAdmin(session);
            else $('goInput').focus();
        })
        .catch(() => {});
})();
