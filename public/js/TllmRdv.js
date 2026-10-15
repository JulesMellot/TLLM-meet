'use strict';

// TLLM*meet: public page of a date poll. Guests answer without an account (their answer token
// stays in this browser); the organiser sees extra controls. Server: app/src/DatePolls.js

(function () {
    const $ = (id) => document.getElementById(id);
    const id = (window.location.pathname.match(/^\/rdv\/([a-z0-9]{10})/) || [])[1];
    const KEY = `tllm-rdv:${id}`;
    const COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];
    const LABEL = { yes: 'Oui', maybe: 'Si besoin', no: 'Non' };
    const SVG = {
        yes: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        maybe: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="3 2"/></svg>',
        no: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8h8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    };

    const esc = (s) =>
        String(s ?? '').replace(
            /[&<>"']/g,
            (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
        );
    const colorFor = (name) => {
        let h = 0;
        for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
        return COLORS[h % COLORS.length];
    };
    const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

    const state = { view: null, me: null, draft: null, name: '', dirty: false, confirm: null };

    function readMe() {
        try {
            return JSON.parse(localStorage.getItem(KEY)) || null;
        } catch {
            return null;
        }
    }
    function writeMe(me) {
        try {
            localStorage.setItem(KEY, JSON.stringify(me));
        } catch {
            /* private browsing: the answer can no longer be changed from here */
        }
    }

    function toast(text) {
        const t = $('toast');
        t.textContent = text;
        t.hidden = false;
        clearTimeout(toast.timer);
        toast.timer = setTimeout(() => (t.hidden = true), 2800);
    }

    async function api(url, options = {}) {
        const res = await fetch(url, {
            ...options,
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const err = new Error(data.error || data.message || 'Erreur du serveur.');
            err.status = res.status;
            throw err;
        }
        return data;
    }

    // ---------- dates, in the time zone of the poll ----------

    const fmt = (ms, opts) =>
        new Intl.DateTimeFormat('fr-FR', { timeZone: state.view.timeZone, ...opts }).format(new Date(ms));
    const hour = (ms) => fmt(ms, { hour: '2-digit', minute: '2-digit' });
    const longDay = (ms) => cap(fmt(ms, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
    const slotLabel = (ms) => `${fmt(ms, { weekday: 'long', day: 'numeric', month: 'long' })} à ${hour(ms)}`;
    const zoneLabel = () => (state.view.timeZone === 'Europe/Paris' ? 'heure de Paris' : state.view.timeZone);
    const durationLabel = (min) =>
        min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60}` : ''}`;

    // ---------- load ----------

    async function load(first = false) {
        try {
            state.view = await api(`/api/rdv/${id}`);
        } catch (err) {
            if (first) {
                $('loading').textContent =
                    err.status === 404
                        ? 'Ce sondage n’existe pas ou a été supprimé.'
                        : 'Impossible de charger le sondage. Réessayez.';
            }
            return;
        }
        const stored = readMe();
        const mine = stored && state.view.participants.find((p) => p.id === stored.pid);
        state.me = mine ? stored : null;
        if (!state.dirty) {
            state.draft = mine ? [...mine.answers] : state.view.slots.map(() => 'no');
            state.name = mine ? mine.name : state.name || stored?.name || '';
        }
        document.title = `${state.view.title} · TLLM*meet`;
        $('loading').hidden = true;
        $('poll').hidden = false;
        render();
    }

    // Refresh while the page is open, without disturbing someone who is typing
    setInterval(() => {
        if (document.hidden || !state.view || state.confirm) return;
        if (
            document.activeElement &&
            $('poll').contains(document.activeElement) &&
            document.activeElement.tagName === 'INPUT'
        )
            return;
        load();
    }, 20000);

    // ---------- render ----------

    function scores() {
        const v = state.view;
        return v.slots.map((_, i) => {
            let yes = 0;
            let maybe = 0;
            for (const p of others()) {
                if (p.answers[i] === 'yes') yes++;
                else if (p.answers[i] === 'maybe') maybe++;
            }
            if (state.me || state.dirty) {
                if (state.draft[i] === 'yes') yes++;
                else if (state.draft[i] === 'maybe') maybe++;
            }
            return { yes, maybe };
        });
    }
    const others = () => state.view.participants.filter((p) => p.id !== state.me?.pid);

    function bestIndex(sc) {
        let best = -1;
        sc.forEach((s, i) => {
            if (s.yes + s.maybe === 0) return;
            if (best < 0 || s.yes > sc[best].yes || (s.yes === sc[best].yes && s.maybe > sc[best].maybe)) best = i;
        });
        return best;
    }

    const person = (name, extra = '') =>
        `<div class="rdv-person"><span class="rdv-avatar" style="background:${colorFor(name)}">${esc(String(name).trim().charAt(0).toUpperCase() || '?')}</span><span>${esc(name)}</span>${extra}</div>`;
    const answerMark = (v) => `<span class="rdv-ans ${v}" role="img" aria-label="${LABEL[v]}">${SVG[v]}</span>`;

    function render() {
        const v = state.view;
        const open = v.status === 'open';
        const sc = scores();
        const best = v.status === 'fixed' ? v.fixed.slot : bestIndex(sc);
        let html = '';

        // The sign of the poll: band with its state and progress, title, facts, the rule
        const n = v.participants.length;
        const band = { open: 'is-soon', fixed: 'is-free', closed: 'is-done' }[v.status];
        const bandText = { open: 'Date à trouver', fixed: 'Date fixée', closed: 'Sondage fermé' }[v.status];
        const progress = v.expected ? `${n} sur ${v.expected}` : `${n} réponse${n > 1 ? 's' : ''}`;
        html += `<section class="rdv-sign">
            <div class="tllm-band ${band}"><span>${bandText}</span><span class="tllm-band-clock">${progress}</span></div>
            <div class="rdv-sign-body">
                <h1 class="tllm-room-name">${esc(v.title)}</h1>
                <dl class="tllm-facts">
                    <dt>Durée</dt><dd>${durationLabel(v.duration)}, en visio</dd>
                    <dt>Proposé par</dt><dd>${esc(v.organizer)}</dd>
                    <dt>Horaires</dt><dd>${zoneLabel()}</dd>
                    ${v.deadline && open ? `<dt>Réponses</dt><dd>jusqu’au ${esc(fmt(v.deadline, { weekday: 'long', day: 'numeric', month: 'long' }))}</dd>` : ''}
                </dl>
                ${v.description ? `<p class="rdv-lead">${esc(v.description)}</p>` : ''}
                ${open ? progressLine(v) : ''}
            </div>
        </section>`;

        if (v.admin) html += adminCard(v);
        if (v.status === 'fixed') html += fixedCard(v);
        if (v.status === 'closed') {
            html += `<div class="rdv-callout"><h2>Ce sondage est fermé</h2><p>Aucune date n’a été retenue.</p></div>`;
        }

        if (state.confirm) {
            html += `<div class="rdv-callout is-accent" id="confirmBox"><h2>${esc(state.confirm.title)}</h2><p>${esc(state.confirm.text)}</p>
                <div class="rdv-row"><button type="button" class="tllm-button" data-act="confirm-yes">${esc(state.confirm.yes)}</button>
                <button type="button" class="tllm-button rdv-secondary" data-act="confirm-no">Annuler</button></div></div>`;
        }

        if (open && v.admin) {
            html += `<div class="rdv-legend">
                <span>${answerMark('yes')} Oui</span>
                ${v.allowMaybe ? `<span>${answerMark('maybe')} Si besoin</span>` : ''}
                <span>${answerMark('no')} Non</span>
                <span>Touchez une case pour changer votre réponse.</span>
            </div>`;
        }
        const table = tableHtml(v, sc, best, open);
        html += open
            ? table
            : `<details class="rdv-card"><summary>Voir les réponses (${v.participants.length})</summary><div style="margin-top:12px">${table}</div></details>`;

        if (open) {
            html += `<div class="rdv-row">
                <button type="button" class="tllm-button" data-act="send">${state.me ? 'Enregistrer mes changements' : 'Envoyer mes disponibilités'}</button>
                <span class="tllm-muted">${state.me ? 'Vous avez déjà répondu. Vous pouvez changer vos réponses.' : 'Vous pourrez modifier vos réponses depuis ce navigateur.'}</span>
            </div>`;
            if (state.me || v.admin) html += subscribeCard(v);
        }

        $('poll').innerHTML = html;
        document.body.classList.toggle('is-admin', !!v.admin);
    }

    function progressLine(v) {
        const n = v.participants.length;
        let text;
        if (v.expected) {
            text = `La date se fixe toute seule à la ${v.expected}${v.expected === 1 ? 're' : 'e'} réponse : le créneau qui a le plus de oui.`;
            if (v.deadline) text += ' À la date limite, avec les réponses reçues.';
        } else text = `${v.organizer} choisira la date avec vos réponses.`;
        if (n === 0) text += ' Personne n’a encore répondu.';
        return `<p class="tllm-sign-foot">${esc(text)}</p>`;
    }

    function tableHtml(v, sc, best, open) {
        const canChoose = v.admin && v.status !== 'closed';
        const people = open ? others() : v.participants;
        const n = v.participants.length;
        let head = `<th scope="col"><span class="tllm-muted">${n} réponse${n > 1 ? 's' : ''}</span></th>`;
        v.slots.forEach((ms, i) => {
            const tag =
                i === best ? `<span class="rdv-tag">${v.status === 'fixed' ? 'Retenu' : 'Le plus de oui'}</span>` : '';
            head += `<th scope="col" class="${i === best ? 'is-best' : ''}"><div class="rdv-slot-h"><span class="d">${esc(fmt(ms, { weekday: 'short' }))}</span><span class="n">${esc(fmt(ms, { day: 'numeric' }))}</span><span class="m">${esc(fmt(ms, { month: 'short' }))}</span><span class="h">${hour(ms)}</span>${tag}</div></th>`;
        });
        let body = '';
        for (const p of people) {
            const remove = v.admin
                ? `<button type="button" class="rdv-remove" data-act="remove" data-pid="${esc(p.id)}" aria-label="Retirer la réponse de ${esc(p.name)}">×</button>`
                : '';
            body += `<tr><td>${person(p.name, remove)}</td>${p.answers.map((a, i) => `<td class="${i === best ? 'is-best' : ''}">${answerMark(a)}</td>`).join('')}</tr>`;
        }
        if (open) {
            body += `<tr class="rdv-mine"><td><input class="tllm-input" id="myName" maxlength="60" autocomplete="name" placeholder="Votre nom" aria-label="Votre nom" value="${esc(state.name)}"></td>`;
            body += state.draft
                .map(
                    (a, i) =>
                        `<td><button type="button" class="rdv-toggle" data-act="toggle" data-i="${i}" data-v="${a}" aria-label="${esc(slotLabel(v.slots[i]))} : ${LABEL[a]}">${SVG[a]}</button></td>`
                )
                .join('');
            body += '</tr>';
        }
        body += `<tr><td class="tllm-muted">Total</td>${sc.map((s, i) => `<td class="rdv-count ${i === best ? 'is-best' : ''}"><b>${s.yes}</b>${s.maybe ? ` <span class="tllm-muted">+${s.maybe}</span>` : ''}</td>`).join('')}</tr>`;
        if (canChoose) {
            body += `<tr><td class="tllm-muted">Organisateur</td>${v.slots
                .map((_, i) => {
                    const chosen = v.status === 'fixed' && v.fixed.slot === i;
                    return `<td>${chosen ? '<span class="rdv-tag">Retenu</span>' : `<button type="button" class="tllm-button rdv-small ${i === best ? '' : 'rdv-secondary'}" data-act="fix" data-i="${i}">Choisir</button>`}</td>`;
                })
                .join('')}</tr>`;
        }
        let html = `<div class="rdv-scroll ${open ? 'rdv-answer' : ''}"><table class="rdv-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;

        // Phone: one line per slot, with the three answers side by side
        if (open) {
            const opts = ['yes'].concat(v.allowMaybe ? ['maybe'] : [], ['no']);
            html += `<div class="rdv-slots"><label class="rdv-field" for="myNamePhone">Votre nom<input class="tllm-input" id="myNamePhone" maxlength="60" autocomplete="name" value="${esc(state.name)}"></label>`;
            v.slots.forEach((ms, i) => {
                const s = sc[i];
                html += `<div class="rdv-slot ${i === best ? 'is-best' : ''}">
                    <span class="when">${esc(cap(slotLabel(ms)))}</span>
                    <span class="rdv-seg" role="group" aria-label="${esc(slotLabel(ms))}">${opts
                        .map(
                            (o) =>
                                `<button type="button" data-act="set" data-i="${i}" data-v="${o}" aria-pressed="${state.draft[i] === o}">${LABEL[o]}</button>`
                        )
                        .join('')}</span>
                    <span class="who">${s.yes} oui${s.maybe ? `, ${s.maybe} si besoin` : ''}${i === best ? ' · le plus de oui' : ''}</span>
                    ${canChoose ? `<span class="who"><button type="button" class="tllm-button rdv-small rdv-secondary" data-act="fix" data-i="${i}">Choisir ce créneau</button></span>` : ''}
                </div>`;
            });
            html += '</div>';
        }
        return html;
    }

    function feedUrls(v) {
        const https = `${window.location.origin}/rdv/${v.id}/agenda.ics`;
        const webcal = https.replace(/^https?:/, 'webcal:');
        return {
            https,
            webcal,
            google: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`,
            outlook: `https://outlook.live.com/calendar/0/addfromweb?url=${encodeURIComponent(https)}&name=${encodeURIComponent(v.title)}`,
        };
    }

    function subscribeCard(v) {
        const u = feedUrls(v);
        return `<div class="rdv-callout" id="subscribe">
            <h2>Recevoir la date dans votre agenda</h2>
            <p>Ajoutez ce sondage à votre agenda. Rien ne s’affiche tant que la date n’est pas fixée, puis le rendez-vous apparaît tout seul, avec le lien de la visio. Selon l’application, la mise à jour prend de quelques minutes à quelques heures.</p>
            <div class="rdv-row">
                <a class="tllm-button rdv-secondary rdv-small" href="${esc(u.google)}" target="_blank" rel="noopener noreferrer">Google Agenda</a>
                <a class="tllm-button rdv-secondary rdv-small" href="${esc(u.webcal)}">iPhone, iPad, Mac</a>
                <a class="tllm-button rdv-secondary rdv-small" href="${esc(u.outlook)}" target="_blank" rel="noopener noreferrer">Outlook</a>
                <button type="button" class="tllm-button rdv-secondary rdv-small" data-act="copy" data-text="${esc(u.https)}">Copier le lien d’abonnement</button>
            </div>
        </div>`;
    }

    function fixedCard(v) {
        const f = v.fixed;
        const join = `/join/${encodeURIComponent(f.room)}`;
        const soon = Date.now() >= f.start - 15 * 60000;
        const stamp = (ms) =>
            new Date(ms)
                .toISOString()
                .replace(/[-:]/g, '')
                .replace(/\.\d{3}/, '');
        const details = `${v.description ? v.description + '\n\n' : ''}Lien de la visio : ${window.location.origin}${join}`;
        const google = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(v.title)}&dates=${stamp(f.start)}/${stamp(f.end)}&details=${encodeURIComponent(details)}&location=${encodeURIComponent(window.location.origin + join)}`;
        const outlook = `https://outlook.live.com/calendar/0/deeplink/compose?path=/calendar/action/compose&rru=addevent&subject=${encodeURIComponent(v.title)}&startdt=${encodeURIComponent(new Date(f.start).toISOString())}&enddt=${encodeURIComponent(new Date(f.end).toISOString())}&body=${encodeURIComponent(details)}&location=${encodeURIComponent(window.location.origin + join)}`;
        const going = v.participants.filter((p) => p.answers[f.slot] !== 'no');
        return `<div class="rdv-fixed">
            <div class="rdv-leaf" aria-hidden="true"><div class="m">${esc(fmt(f.start, { month: 'short' }))}</div><div class="n">${esc(fmt(f.start, { day: 'numeric' }))}</div><div class="d">${esc(fmt(f.start, { weekday: 'long' }))}</div></div>
            <div class="rdv-stack" style="gap:10px">
                <div><h2>${esc(longDay(f.start))}</h2><div class="rdv-when">${hour(f.start)} – ${hour(f.end)}, ${zoneLabel()}</div></div>
                <div class="rdv-row">
                    ${
                        soon || v.admin
                            ? `<a class="tllm-button" href="${esc(join)}">Rejoindre la visio</a>`
                            : `<button class="tllm-button" type="button" disabled>Rejoindre la visio</button>`
                    }
                </div>
                <details><summary class="tllm-button rdv-secondary rdv-small" style="list-style:none">Ajouter à mon agenda</summary>
                    <div class="rdv-menu" style="margin-top:8px">
                        <a href="/rdv/${esc(v.id)}/rendez-vous.ics">Fichier agenda (.ics)<small>iPhone, Mac, Outlook, Thunderbird</small></a>
                        <a href="${esc(google)}" target="_blank" rel="noopener noreferrer">Google Agenda</a>
                        <a href="${esc(outlook)}" target="_blank" rel="noopener noreferrer">Outlook.com</a>
                    </div>
                </details>
                <p class="tllm-muted" style="margin:0">Lien de la visio : ${esc(window.location.host + join)}${soon ? '' : '. Le bouton s’active 15 minutes avant le début.'} Si vous vous êtes abonné au sondage, le rendez-vous est déjà dans votre agenda, ou y sera à la prochaine mise à jour.</p>
            </div>
        </div>
        <div class="rdv-card"><h2>Disponibles (${going.length})</h2><div class="rdv-going">${going.map((p) => person(p.answers[f.slot] === 'maybe' ? `${p.name} (si besoin)` : p.name)).join('') || '<span class="tllm-muted">Personne pour l’instant.</span>'}</div></div>`;
    }

    function adminCard(v) {
        const url = `${window.location.origin}/rdv/${v.id}`;
        return `<div class="rdv-card rdv-stack">
            <h2 style="margin:0">Organisateur</h2>
            <div class="rdv-link-box"><code>${esc(url)}</code><button type="button" class="tllm-button rdv-small" data-act="copy" data-text="${esc(url)}">Copier le lien</button></div>
            <div class="rdv-row">
                <button type="button" class="tllm-button rdv-secondary rdv-small" data-act="csv">Exporter (tableur)</button>
                ${v.status === 'open' ? '<button type="button" class="tllm-button rdv-secondary rdv-small" data-act="close">Fermer sans fixer</button>' : ''}
                <button type="button" class="tllm-button rdv-danger rdv-small" data-act="delete">Supprimer</button>
                <a class="tllm-muted" href="/rdv">Mes sondages</a>
            </div>
        </div>`;
    }

    // ---------- actions ----------

    async function send() {
        const name = state.name.trim();
        if (!name) {
            toast('Indiquez votre nom pour que l’organisateur vous reconnaisse.');
            ($('myName')?.offsetParent ? $('myName') : $('myNamePhone'))?.focus();
            return;
        }
        const body = JSON.stringify({ name, answers: state.draft });
        try {
            if (state.me) {
                await api(`/api/rdv/${id}/answers/${state.me.pid}`, {
                    method: 'PUT',
                    headers: { 'X-Answer-Token': state.me.token },
                    body,
                });
                toast('Vos changements sont enregistrés.');
            } else {
                const r = await api(`/api/rdv/${id}/answers`, { method: 'POST', body });
                writeMe({ pid: r.participantId, token: r.token, name });
                toast('C’est noté. Merci !');
            }
            state.dirty = false;
            await load();
            $('subscribe')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } catch (err) {
            toast(err.message);
            if (err.status === 409) load();
        }
    }

    function ask(confirm) {
        state.confirm = confirm;
        render();
        $('confirmBox')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    async function adminAction(url, method, okText, after) {
        try {
            await api(url, { method, body: method === 'DELETE' ? undefined : JSON.stringify(after?.body || {}) });
            if (okText) toast(okText);
            if (after?.leave) return (window.location.href = '/rdv');
            await load();
        } catch (err) {
            toast(err.message);
        }
    }

    function exportCsv() {
        const v = state.view;
        const cell = (value) => {
            let text = String(value ?? '');
            if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
            return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        };
        const row = (...cells) => cells.map(cell).join(';');
        const lines = [
            row('Sondage', v.title),
            '',
            row(
                'Participant',
                ...v.slots.map((ms) => `${fmt(ms, { weekday: 'short', day: 'numeric', month: 'short' })} ${hour(ms)}`)
            ),
            ...v.participants.map((p) => row(p.name, ...p.answers.map((a) => LABEL[a]))),
            row('Oui', ...v.slots.map((_, i) => v.participants.filter((p) => p.answers[i] === 'yes').length)),
            row('Si besoin', ...v.slots.map((_, i) => v.participants.filter((p) => p.answers[i] === 'maybe').length)),
        ];
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
        a.download = `rendez-vous-${v.id}.csv`;
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    const nextAnswer = (a) => (a === 'no' ? 'yes' : a === 'yes' ? (state.view.allowMaybe ? 'maybe' : 'no') : 'no');

    $('poll').addEventListener('click', (e) => {
        const el = e.target.closest('[data-act]');
        if (!el) return;
        const act = el.dataset.act;
        const i = Number(el.dataset.i);
        const v = state.view;
        if (act === 'toggle') {
            state.draft[i] = nextAnswer(state.draft[i]);
            state.dirty = true;
            el.dataset.v = state.draft[i];
            el.innerHTML = SVG[state.draft[i]];
            el.setAttribute('aria-label', `${slotLabel(v.slots[i])} : ${LABEL[state.draft[i]]}`);
        } else if (act === 'set') {
            state.draft[i] = el.dataset.v;
            state.dirty = true;
            el.parentElement
                .querySelectorAll('button')
                .forEach((b) => b.setAttribute('aria-pressed', String(b === el)));
        } else if (act === 'send') send();
        else if (act === 'copy') {
            const text = el.dataset.text;
            navigator.clipboard?.writeText(text).then(
                () => toast('Lien copié'),
                () => toast(text)
            );
        } else if (act === 'csv') exportCsv();
        else if (act === 'fix') {
            const ms = v.slots[i];
            ask({
                title: `Fixer la réunion au ${slotLabel(ms)} ?`,
                text:
                    v.status === 'fixed'
                        ? 'La date change pour tout le monde. Le lien de la visio reste le même, et les agendas abonnés se mettent à jour.'
                        : 'Une visio est réservée pour ce créneau. La page affiche la date et le lien, et les agendas abonnés se mettent à jour.',
                yes: 'Fixer cette date',
                run: () => adminAction(`/api/rdv/${id}/fix`, 'POST', 'Date fixée.', { body: { slot: i } }),
            });
        } else if (act === 'close') {
            ask({
                title: 'Fermer le sondage sans fixer de date ?',
                text: 'Plus personne ne pourra répondre.',
                yes: 'Fermer',
                run: () => adminAction(`/api/rdv/${id}/close`, 'POST', 'Sondage fermé.'),
            });
        } else if (act === 'delete') {
            ask({
                title: 'Supprimer ce sondage ?',
                text: 'Le lien ne fonctionnera plus et les réponses seront perdues. Les agendas abonnés gardent la dernière version.',
                yes: 'Supprimer',
                run: () => adminAction(`/api/rdv/${id}`, 'DELETE', 'Sondage supprimé.', { leave: true }),
            });
        } else if (act === 'remove') {
            const p = v.participants.find((x) => x.id === el.dataset.pid);
            if (!p) return;
            ask({
                title: `Retirer la réponse de ${p.name} ?`,
                text: 'Cette personne pourra répondre à nouveau.',
                yes: 'Retirer',
                run: () => adminAction(`/api/rdv/${id}/answers/${p.id}`, 'DELETE', 'Réponse retirée.'),
            });
        } else if (act === 'confirm-yes') {
            const run = state.confirm?.run;
            state.confirm = null;
            run?.();
        } else if (act === 'confirm-no') {
            state.confirm = null;
            render();
        }
    });

    $('poll').addEventListener('input', (e) => {
        if (e.target.id === 'myName' || e.target.id === 'myNamePhone') {
            state.name = e.target.value;
            state.dirty = true;
        }
    });

    if (!id) {
        $('loading').textContent = 'Ce sondage n’existe pas.';
        return;
    }
    load(true);
})();
