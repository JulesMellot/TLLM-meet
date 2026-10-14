'use strict';

// TLLM*meet: organiser page of the date polls (list and creation). Server: app/src/DatePolls.js

(function () {
    const $ = (id) => document.getElementById(id);
    const MONTHS = [
        'janvier',
        'février',
        'mars',
        'avril',
        'mai',
        'juin',
        'juillet',
        'août',
        'septembre',
        'octobre',
        'novembre',
        'décembre',
    ];
    const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
    const DURATIONS = [
        [30, '30 min'],
        [45, '45 min'],
        [60, '1 h'],
        [90, '1 h 30'],
        [120, '2 h'],
    ];

    const pad = (n) => String(n).padStart(2, '0');
    const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const parse = (s) => {
        const [y, m, d] = s.split('-').map(Number);
        return new Date(y, m - 1, d);
    };
    const addMin = (time, min) => {
        const [h, m] = time.split(':').map(Number);
        const t = h * 60 + m + min;
        return `${pad(Math.floor(t / 60) % 24)}:${pad(t % 60)}`;
    };
    const zoneLabel = (zone) => (zone === 'Europe/Paris' ? 'heure de Paris' : zone);

    const today = new Date();
    const state = {
        timeZone: 'Europe/Paris',
        month: [today.getFullYear(), today.getMonth()],
        duration: 60,
        slots: [], // { date, time }
        lastTime: '10:00',
    };

    function toast(text) {
        const t = $('toast');
        t.textContent = text;
        t.hidden = false;
        clearTimeout(toast.timer);
        toast.timer = setTimeout(() => (t.hidden = true), 2600);
    }

    function show(view) {
        ['loading', 'listView', 'createView', 'doneView'].forEach((id) => ($(id).hidden = id !== view));
        window.scrollTo(0, 0);
    }

    async function api(url, options = {}) {
        const res = await fetch(url, {
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            ...options,
        });
        if (res.status === 401) {
            window.location.href = '/login';
            throw new Error('unauthorized');
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Erreur du serveur.');
        return data;
    }

    // ---------- list ----------

    const formatDate = (ms) =>
        new Intl.DateTimeFormat('fr-FR', {
            timeZone: state.timeZone,
            weekday: 'short',
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
        }).format(new Date(ms));

    async function loadList() {
        const data = await api('/api/rdv');
        state.timeZone = data.timeZone || state.timeZone;
        const list = $('pollList');
        list.textContent = '';
        if (!data.polls.length) {
            const p = document.createElement('p');
            p.className = 'rdv-empty';
            p.textContent = 'Aucun sondage pour l’instant.';
            list.append(p);
        }
        for (const poll of data.polls) {
            const a = document.createElement('a');
            a.className = 'rdv-item';
            a.href = `/rdv/${poll.id}`;
            const title = document.createElement('div');
            const t = document.createElement('div');
            t.className = 'rdv-item-title';
            t.textContent = poll.title;
            const meta = document.createElement('div');
            meta.className = 'tllm-muted';
            const answers = `${poll.answers} réponse${poll.answers > 1 ? 's' : ''}${poll.expected ? ` sur ${poll.expected}` : ''}`;
            meta.textContent =
                poll.status === 'fixed' && poll.fixed
                    ? `Fixé : ${formatDate(poll.fixed.start)} · ${answers}`
                    : `${poll.slots} créneaux · ${answers}`;
            title.append(t, meta);
            const pill = document.createElement('span');
            pill.className = `rdv-pill is-${poll.status}`;
            pill.textContent = { open: 'En cours', fixed: 'Date fixée', closed: 'Fermé' }[poll.status];
            a.append(title, pill);
            list.append(a);
        }
        show('listView');
    }

    // ---------- create ----------

    function renderDurations() {
        const box = $('pDuration');
        box.textContent = '';
        for (const [value, label] of DURATIONS) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'rdv-chip';
            b.textContent = label;
            b.setAttribute('aria-pressed', String(value === state.duration));
            b.onclick = () => {
                state.duration = value;
                renderDurations();
                renderSlots();
            };
            box.append(b);
        }
    }

    function renderCal() {
        const [y, m] = state.month;
        $('calTitle').textContent = `${MONTHS[m]} ${y}`;
        const offset = (new Date(y, m, 1).getDay() + 6) % 7; // weeks start on Monday
        const days = new Date(y, m + 1, 0).getDate();
        const todayIso = iso(today);
        const counts = {};
        state.slots.forEach((s) => (counts[s.date] = (counts[s.date] || 0) + 1));
        const cal = $('cal');
        cal.textContent = '';
        for (const d of ['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim']) {
            const el = document.createElement('div');
            el.className = 'rdv-dow';
            el.textContent = d;
            cal.append(el);
        }
        for (let i = 0; i < offset; i++) cal.append(document.createElement('div'));
        for (let d = 1; d <= days; d++) {
            const key = iso(new Date(y, m, d));
            const n = counts[key] || 0;
            const b = document.createElement('button');
            b.type = 'button';
            b.dataset.day = key;
            b.disabled = key < todayIso;
            if (key === todayIso) b.classList.add('is-today');
            b.setAttribute('aria-pressed', String(n > 0));
            b.setAttribute('aria-label', `${d} ${MONTHS[m]}${n ? `, ${n} horaire${n > 1 ? 's' : ''}` : ''}`);
            b.textContent = d;
            if (n) {
                const badge = document.createElement('span');
                badge.className = 'rdv-n';
                badge.textContent = n;
                b.append(badge);
            }
            cal.append(b);
        }
        $('calPrev').disabled = y === today.getFullYear() && m <= today.getMonth();
    }

    function sortSlots() {
        state.slots.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    }

    function renderSlots() {
        const byDay = {};
        state.slots.forEach((s) => (byDay[s.date] ||= []).push(s.time));
        const keys = Object.keys(byDay).sort();
        $('slotCount').textContent = state.slots.length ? `(${state.slots.length})` : '';
        const box = $('slotDays');
        box.textContent = '';
        if (!keys.length) {
            const empty = document.createElement('div');
            empty.className = 'rdv-empty';
            empty.textContent = 'Cliquez sur des jours dans le calendrier.';
            box.append(empty);
            return;
        }
        for (const day of keys) {
            const d = parse(day);
            const wrap = document.createElement('div');
            wrap.className = 'rdv-day';
            const head = document.createElement('header');
            const label = document.createElement('span');
            label.textContent = `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
            const drop = document.createElement('button');
            drop.type = 'button';
            drop.textContent = 'Retirer le jour';
            drop.onclick = () => {
                state.slots = state.slots.filter((s) => s.date !== day);
                renderCal();
                renderSlots();
            };
            head.append(label, drop);
            const row = document.createElement('div');
            row.className = 'rdv-row';
            for (const time of byDay[day].sort()) {
                const chip = document.createElement('span');
                chip.className = 'rdv-time';
                chip.append(`${time} – ${addMin(time, state.duration)}`);
                const x = document.createElement('button');
                x.type = 'button';
                x.textContent = '×';
                x.setAttribute('aria-label', `Retirer ${time}`);
                x.onclick = () => {
                    state.slots = state.slots.filter((s) => !(s.date === day && s.time === time));
                    renderCal();
                    renderSlots();
                };
                chip.append(x);
                row.append(chip);
            }
            const add = document.createElement('span');
            add.className = 'rdv-add-time';
            const input = document.createElement('input');
            input.type = 'time';
            input.className = 'tllm-input';
            input.step = 900;
            input.value = state.lastTime === byDay[day][0] ? addMin(state.lastTime, 240) : state.lastTime;
            input.setAttribute('aria-label', `Horaire à ajouter le ${d.getDate()} ${MONTHS[d.getMonth()]}`);
            const addBtn = document.createElement('button');
            addBtn.type = 'button';
            addBtn.className = 'tllm-button rdv-secondary rdv-small';
            addBtn.textContent = 'Ajouter';
            addBtn.onclick = () => {
                const time = input.value;
                if (!/^\d{2}:\d{2}$/.test(time)) return;
                if (!state.slots.some((s) => s.date === day && s.time === time)) state.slots.push({ date: day, time });
                state.lastTime = time;
                sortSlots();
                renderCal();
                renderSlots();
            };
            add.append(input, addBtn);
            row.append(add);
            wrap.append(head, row);
            box.append(wrap);
        }
    }

    function openCreate() {
        state.slots = [];
        state.duration = 60;
        $('createView').reset();
        $('createError').textContent = '';
        $('tzNote').textContent =
            `Horaires en ${zoneLabel(state.timeZone)}. Les changements d’heure sont pris en compte.`;
        renderDurations();
        renderCal();
        renderSlots();
        show('createView');
        $('pTitle').focus();
    }

    $('cal').addEventListener('click', (e) => {
        const b = e.target.closest('[data-day]');
        if (!b || b.disabled) return;
        const day = b.dataset.day;
        if (state.slots.some((s) => s.date === day)) state.slots = state.slots.filter((s) => s.date !== day);
        else state.slots.push({ date: day, time: state.lastTime });
        sortSlots();
        renderCal();
        renderSlots();
    });
    $('calPrev').onclick = () => {
        const [y, m] = state.month;
        state.month = m === 0 ? [y - 1, 11] : [y, m - 1];
        renderCal();
    };
    $('calNext').onclick = () => {
        const [y, m] = state.month;
        state.month = m === 11 ? [y + 1, 0] : [y, m + 1];
        renderCal();
    };

    $('createView').addEventListener('submit', async (e) => {
        e.preventDefault();
        const error = $('createError');
        error.textContent = '';
        const title = $('pTitle').value.trim();
        if (!title) {
            error.textContent = 'Donnez un titre.';
            return $('pTitle').focus();
        }
        if (state.slots.length < 2) {
            error.textContent = 'Proposez au moins deux créneaux.';
            return;
        }
        const button = $('createBtn');
        button.disabled = true;
        try {
            const data = await api('/api/rdv', {
                method: 'POST',
                body: JSON.stringify({
                    title,
                    description: $('pDesc').value.trim(),
                    duration: state.duration,
                    slots: state.slots,
                    expected: $('pExpected').value ? Number($('pExpected').value) : null,
                    deadline: $('pDeadline').value || null,
                    allowMaybe: $('pMaybe').checked,
                }),
            });
            const url = `${window.location.origin}${data.url}`;
            $('doneUrl').textContent = url;
            $('openDone').href = data.url;
            show('doneView');
        } catch (err) {
            error.textContent = err.message;
        } finally {
            button.disabled = false;
        }
    });

    $('newPollBtn').onclick = openCreate;
    $('cancelBtn').onclick = () => show('listView');
    $('backToList').onclick = () => loadList().catch(() => {});
    $('copyDone').onclick = () => {
        const text = $('doneUrl').textContent;
        navigator.clipboard?.writeText(text).then(
            () => toast('Lien copié'),
            () => toast(text)
        );
    };

    fetch('/admin/session', { credentials: 'same-origin' })
        .then((res) => res.json())
        .then((session) => {
            if (!session?.admin) {
                window.location.href = '/login';
                return;
            }
            return loadList();
        })
        .catch(() => {
            $('loading').textContent = 'Impossible de charger la page. Réessayez.';
        });
})();
