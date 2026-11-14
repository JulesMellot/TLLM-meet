'use strict';

/**
 * TLLM*meet: agenda of the meeting, with a timer per point (server side: app/src/Agenda.js).
 *
 * Presenters write the points (title, minutes) in the "Ordre du jour" panel and move from one to
 * the next; everyone sees the point under way and the time left in the top strip, and the
 * projector shows it too (TllmProjection.js). Each move is written in the transcription.
 */

(function (root) {
    // ####################################################
    // TIME (no browser needed: tested in tests/test-Agenda.js)
    // ####################################################

    const two = (n) => String(n).padStart(2, '0');

    // 754000 -> "12:34", 3723000 -> "1:02:03"
    function clock(ms) {
        const s = Math.floor(Math.abs(ms) / 1000);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        return h ? `${h}:${two(m)}:${two(s % 60)}` : `${two(m)}:${two(s % 60)}`;
    }

    // The timer of a point: time left, or time over (planned minutes passed), or time spent (no limit)
    function timer(minutes, elapsedMs) {
        if (!(minutes > 0)) return { text: clock(elapsedMs), over: false, left: null };
        const left = minutes * 60000 - elapsedMs;
        return { text: left >= 0 ? clock(left) : `+${clock(left)}`, over: left < 0, left };
    }

    const api = { clock, timer };
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
        return;
    }
    if (typeof RoomClient === 'undefined') return;

    // ####################################################
    // IN THE MEETING
    // ####################################################

    const $ = (id) => document.getElementById(id);
    const esc = (value) =>
        String(value ?? '').replace(
            /[&<>"']/g,
            (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
        );
    const icon = (cls) => `<i class="${cls}" aria-hidden="true"></i>`;
    const amPresenter = () => typeof isPresenter !== 'undefined' && !!isPresenter;
    const T = () => root.tllmRoom;

    // items, current, since (this browser's clock), spent, finished
    const A = (root.tllmAgenda = { ...api, items: [], current: -1, since: null, spent: [], finished: false });
    let draft = null; // the list a presenter is writing, sent after a short pause
    let sendTimer = null;

    A.started = () => A.current >= 0;
    A.elapsed = () => (A.current >= 0 && A.since ? Date.now() - A.since : 0);
    A.now = function () {
        if (A.current < 0) return null;
        const item = A.items[A.current];
        return {
            index: A.current,
            total: A.items.length,
            title: item.title,
            next: A.items[A.current + 1]?.title || null,
            ...timer(item.minutes, A.elapsed()),
        };
    };

    function apply(view) {
        if (!view) return;
        A.items = Array.isArray(view.items) ? view.items : [];
        A.current = Number.isInteger(view.current) ? view.current : -1;
        A.since = A.current >= 0 ? Date.now() - (Number(view.elapsedMs) || 0) : null;
        A.spent = Array.isArray(view.spent) ? view.spent : [];
        A.finished = !!view.finished;
        if (!draftFocused()) draft = null;
        renderChip();
        if (T()?.panel === 'agenda' && !draftFocused()) renderPanel();
    }

    function send(data) {
        return new Promise((resolve) =>
            rc.socket.emit('agenda', data, (answer) => {
                if (answer?.error) T()?.bubble?.({ iconCls: 'fas fa-list-check', title: answer.error });
                if (answer?.agenda) apply(answer.agenda);
                resolve(answer);
            })
        );
    }

    A.go = (index) => send({ go: index });
    A.finish = () => send({ finish: true });
    A.setItems = (items) => send({ items });

    function moved(info) {
        if (!info) return;
        const t = T();
        if (info.finished) {
            t?.sys?.('Ordre du jour terminé');
            return;
        }
        const label = `Point ${info.index + 1}/${A.items.length} : ${info.title}`;
        t?.sys?.(label);
        if (info.by !== rc.peer_name)
            t?.bubble?.({ iconCls: 'fas fa-list-check', title: label, text: info.by ? `par ${info.by}` : '' });
    }

    // ---------------- Top strip ----------------

    function renderChip() {
        let chip = $('tllmAgendaChip');
        const now = A.now();
        if (!now) return chip?.remove();
        if (!chip) {
            chip = document.createElement('button');
            chip.type = 'button';
            chip.id = 'tllmAgendaChip';
            chip.className = 'tllm-top-btn tllm-agenda-chip';
            chip.onclick = () => T()?.togglePanel('agenda');
            const anchor = $('tllmProjecting') || $('tllmCopyLink');
            if (anchor) anchor.before(chip);
            else $('tllmTop')?.appendChild(chip);
        }
        chip.classList.toggle('is-over', now.over);
        chip.title = `Point ${now.index + 1}/${now.total} : ${now.title}`;
        chip.innerHTML = `${icon('fas fa-list-check')}<span class="tllm-lbl">${now.index + 1}/${now.total} · ${esc(
            now.title
        )}</span><b>${esc(now.text)}</b>`;
    }

    // ---------------- Panel ----------------

    function draftFocused() {
        return !!document.activeElement?.closest?.('#tllmAgendaList');
    }

    function items() {
        return draft || A.items;
    }

    function rowTime(i) {
        const item = items()[i];
        if (i === A.current) return timer(item.minutes, A.elapsed());
        const spent = A.spent[i] || 0;
        if (spent) return { text: clock(spent), over: item.minutes > 0 && spent > item.minutes * 60000, done: true };
        // Planned minutes: already in their field for a presenter
        return { text: item.minutes && !amPresenter() ? `${item.minutes} min` : '', over: false };
    }

    function renderPanel() {
        const body = $('tllmPanelBody');
        const foot = $('tllmPanelFoot');
        if (!body || T()?.panel !== 'agenda') return;
        const edit = amPresenter();
        const list = items();
        const planned = list.reduce((sum, i) => sum + (i.minutes || 0), 0);

        let html = '';
        if (!list.length && !edit) {
            html = `<p class="tllm-empty">Pas d'ordre du jour pour cette réunion.</p>`;
        } else {
            html += `<p class="tllm-section">${list.length} point${list.length > 1 ? 's' : ''}${planned ? ` · ${planned} min prévues` : ''}</p>`;
            html += `<ol class="tllm-agenda" id="tllmAgendaList">`;
            list.forEach((item, i) => {
                const t = rowTime(i);
                const cls = [i === A.current ? 'is-current' : '', t.done ? 'is-done' : '', t.over ? 'is-over' : '']
                    .filter(Boolean)
                    .join(' ');
                html += `<li class="${cls}" data-index="${i}">
                    <span class="tllm-agenda-num">${i + 1}</span>
                    ${
                        edit
                            ? `<input class="tllm-agenda-title" data-field="title" value="${esc(item.title)}" maxlength="120" aria-label="Point ${i + 1}">
                               <input class="tllm-agenda-min" data-field="minutes" type="number" min="0" max="600" inputmode="numeric" value="${item.minutes || ''}" placeholder="min" aria-label="Minutes prévues pour le point ${i + 1}">`
                            : `<span class="tllm-agenda-title">${esc(item.title)}</span>`
                    }
                    <span class="tllm-agenda-time" data-time="${i}">${esc(t.text)}</span>
                    ${
                        edit
                            ? `<span class="tllm-agenda-acts">${i !== A.current ? `<button type="button" class="tllm-icon-btn" data-go="${i}" aria-label="Passer à ce point" title="Passer à ce point">${icon('fas fa-play')}</button>` : ''}<button type="button" class="tllm-icon-btn" data-remove="${i}" aria-label="Retirer ce point" title="Retirer">${icon('fas fa-xmark')}</button></span>`
                            : ''
                    }
                </li>`;
            });
            html += `</ol>`;
            if (edit) {
                html += `<form class="tllm-agenda-add" id="tllmAgendaAdd">
                    <input id="tllmAgendaNew" maxlength="120" placeholder="Ajouter un point" aria-label="Nouveau point">
                    <input id="tllmAgendaNewMin" type="number" min="0" max="600" inputmode="numeric" placeholder="min" aria-label="Minutes prévues">
                    <button type="submit" class="tllm-icon-btn" aria-label="Ajouter">${icon('fas fa-plus')}</button>
                </form>
                <p class="tllm-foot-note">Chaque passage à un point est noté dans la transcription de la réunion.</p>`;
            }
        }
        body.innerHTML = html;

        let actions = '';
        if (edit && list.length) {
            if (A.current < 0)
                actions = `<button type="button" id="tllmAgendaStart" class="tllm-primary">${icon('fas fa-play')} ${A.finished ? 'Reprendre au début' : 'Démarrer'}</button>`;
            else {
                if (A.current > 0)
                    actions += `<button type="button" id="tllmAgendaPrev">${icon('fas fa-backward-step')} Précédent</button>`;
                actions +=
                    A.current < list.length - 1
                        ? `<button type="button" id="tllmAgendaNext" class="tllm-primary">Point suivant ${icon('fas fa-forward-step')}</button>`
                        : `<button type="button" id="tllmAgendaFinish" class="tllm-primary">${icon('fas fa-flag-checkered')} Terminer</button>`;
            }
        }
        foot.innerHTML = actions ? `<div class="tllm-foot-actions">${actions}</div>` : '';
        if (!edit) return;

        // Sent after a short pause; a point whose title is being retyped is not removed meanwhile
        const flush = () => {
            clearTimeout(sendTimer);
            if (draft && draft.every((item) => item.title.trim())) A.setItems(draft);
        };
        const commit = () => {
            clearTimeout(sendTimer);
            sendTimer = setTimeout(flush, 600);
        };
        body.querySelectorAll('#tllmAgendaList input').forEach((input) => {
            input.oninput = () => {
                const i = Number(input.closest('li').dataset.index);
                draft = draft || A.items.map((item) => ({ ...item }));
                if (input.dataset.field === 'title') draft[i].title = input.value;
                else draft[i].minutes = Math.max(0, Math.min(600, Number(input.value) || 0));
                commit();
            };
            input.onchange = flush;
        });
        body.querySelectorAll('[data-remove]').forEach((btn) => {
            btn.onclick = () => {
                const next = items().filter((_, i) => i !== Number(btn.dataset.remove));
                draft = null;
                A.setItems(next);
            };
        });
        body.querySelectorAll('[data-go]').forEach((btn) => (btn.onclick = () => A.go(Number(btn.dataset.go))));
        const add = $('tllmAgendaAdd');
        if (add)
            add.onsubmit = (e) => {
                e.preventDefault();
                const title = $('tllmAgendaNew').value.trim();
                if (!title) return;
                const minutes = Math.max(0, Math.min(600, Number($('tllmAgendaNewMin').value) || 0));
                draft = null;
                A.setItems([...items(), { title, minutes }]).then(() => $('tllmAgendaNew')?.focus());
            };
        $('tllmAgendaStart') && ($('tllmAgendaStart').onclick = () => A.go(0));
        $('tllmAgendaPrev') && ($('tllmAgendaPrev').onclick = () => A.go(A.current - 1));
        $('tllmAgendaNext') && ($('tllmAgendaNext').onclick = () => A.go(A.current + 1));
        $('tllmAgendaFinish') && ($('tllmAgendaFinish').onclick = () => A.finish());
    }

    // Every second: the timers only, the inputs being typed in stay as they are
    function tick() {
        if (A.current < 0) return;
        renderChip();
        if (T()?.panel !== 'agenda') return;
        document.querySelectorAll('#tllmAgendaList [data-time]').forEach((el) => {
            const i = Number(el.dataset.time);
            if (!items()[i]) return;
            const t = rowTime(i);
            el.textContent = t.text;
            el.closest('li')?.classList.toggle('is-over', !!t.over);
        });
    }

    function start() {
        if (A.startedListening || !rc?.socket) return;
        A.startedListening = true;
        T().panels.agenda = { title: () => 'Ordre du jour', render: () => renderPanel() };
        rc.socket.on('agenda', (data) => {
            apply(data?.agenda);
            moved(data?.moved);
        });
        const ask = () => send({ get: true });
        rc.socket.on('connect', ask); // back after a cut
        ask();
        setInterval(tick, 1000);
    }

    // Once the meeting shell is up (TllmRoom.js)
    const wait = setInterval(() => {
        if (root.tllmRoom?.started && typeof rc !== 'undefined' && rc?.socket) {
            clearInterval(wait);
            start();
        }
    }, 300);
})(typeof window !== 'undefined' ? window : globalThis);
