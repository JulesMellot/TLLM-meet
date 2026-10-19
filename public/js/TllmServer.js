'use strict';

// TLLM*meet admin home, "Serveur" block (admin only, started by TllmHome.js).
// Live: what the app uses (Node + mediasoup workers) next to the whole server, every 5 s
// (/api/admin/metrics). Below, the history: the CPU and memory each meeting used, over a period,
// grouped by room (/api/admin/usage). See Usage.js.

(function () {
    const $ = (id) => document.getElementById(id);
    const SVG = 'http://www.w3.org/2000/svg';
    const state = { timeZone: 'Europe/Paris', metrics: null, hoverX: null };

    function el(tag, cls, text) {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function svg(tag, attrs) {
        const node = document.createElementNS(SVG, tag);
        for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
        return node;
    }

    // ---------- formats ----------

    const num = (n, digits = 0) =>
        new Intl.NumberFormat('fr-FR', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n);

    function pct(share) {
        if (share == null || !Number.isFinite(share)) return '—';
        const p = share * 100;
        return `${num(p, p < 10 ? 1 : 0)} %`;
    }

    function bytes(n) {
        if (n == null) return '—';
        if (n < 1e6) return `${num(n / 1e3)} ko`;
        if (n < 1e9) return `${num(n / 1e6, n < 1e7 ? 1 : 0)} Mo`;
        return `${num(n / 1e9, 1)} Go`;
    }

    function bitrate(n) {
        if (n == null) return '—';
        if (n < 1e6) return `${num(n / 1e3)} kbit/s`;
        return `${num(n / 1e6, n < 1e7 ? 1 : 0)} Mbit/s`;
    }

    function span(ms) {
        const min = Math.round(ms / 60000);
        if (min < 1) return `${Math.max(1, Math.round(ms / 1000))} s`;
        if (min < 60) return `${min} min`;
        return `${Math.floor(min / 60)} h${min % 60 ? ` ${String(min % 60).padStart(2, '0')}` : ''}`;
    }

    const fmt = (ms, opts) =>
        new Intl.DateTimeFormat('fr-FR', { timeZone: state.timeZone, ...opts }).format(new Date(ms));
    const clock = (ms) => fmt(ms, { hour: '2-digit', minute: '2-digit' });
    const clockSec = (ms) => fmt(ms, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const day = (ms) => fmt(ms, { weekday: 'short', day: 'numeric', month: 'short' });

    // ---------- meters: the app, the rest of the server, what is free ----------

    function meter(node, { title, app, used, total, appText, restText }) {
        node.textContent = '';
        const head = el('div', 'tllm-meter-head');
        head.append(el('span', 'tllm-meter-title', title));
        const values = el('span', 'tllm-meter-values');
        values.append(el('b', '', appText), ` · serveur ${restText}`);
        head.append(values);
        const track = el('div', 'tllm-meter-track');
        track.setAttribute('role', 'img');
        track.setAttribute('aria-label', `${title} : TLLM*meet ${appText}, tout le serveur ${restText}`);
        if (total > 0) {
            const appW = Math.min(1, Math.max(0, app / total));
            const restW = Math.min(1 - appW, Math.max(0, (used - app) / total));
            const a = el('i', 'is-app');
            a.style.width = `${appW * 100}%`;
            a.title = `TLLM*meet : ${appText}`;
            const r = el('i', 'is-rest');
            r.style.width = `${restW * 100}%`;
            r.title = `Le reste du serveur : ${pct(restW)}`;
            track.append(a, r);
        }
        node.append(head, track);
    }

    // ---------- line chart: app and server CPU over 5 minutes ----------

    function chart(history) {
        const plot = $('cpuPlot');
        plot.textContent = '';
        const points = history.filter((p) => p.appCpu != null);
        if (points.length < 2) {
            plot.append(el('p', 'tllm-chart-empty', 'La courbe apparaît après quelques mesures.'));
            return;
        }
        // Drawn at its real width: the text keeps its size on a phone
        const W = Math.max(280, Math.round(plot.clientWidth) || 600);
        const H = 150;
        const pad = { l: 38, r: 64, t: 8, b: 20 };
        const top = Math.max(
            0.1,
            Math.ceil(Math.max(...points.map((p) => Math.max(p.appCpu || 0, p.serverCpu || 0))) * 10) / 10
        );
        const t0 = points[0].t;
        const t1 = points[points.length - 1].t;
        const x = (t) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - pad.l - pad.r);
        const y = (v) => pad.t + (1 - Math.min(v, top) / top) * (H - pad.t - pad.b);

        const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'tllm-chart-svg', role: 'img' });
        root.setAttribute(
            'aria-label',
            `Processeur sur 5 minutes : TLLM*meet ${pct(points[points.length - 1].appCpu)}, serveur ${pct(points[points.length - 1].serverCpu)}`
        );
        for (const v of [0, top / 2, top]) {
            root.append(svg('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: 'tllm-chart-grid' }));
            const label = svg('text', { x: pad.l - 6, y: y(v) + 4, class: 'tllm-chart-axis', 'text-anchor': 'end' });
            label.textContent = `${num(v * 100)} %`;
            root.append(label);
        }
        for (const [t, anchor] of [
            [t0, 'start'],
            [t1, 'end'],
        ]) {
            const label = svg('text', { x: x(t), y: H - 4, class: 'tllm-chart-axis', 'text-anchor': anchor });
            label.textContent = clock(t);
            root.append(label);
        }
        const labels = [];
        const line = (key, cls, name) => {
            const d = points
                .filter((p) => p[key] != null)
                .map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p[key]).toFixed(1)}`)
                .join(' ');
            root.append(svg('path', { d, class: `tllm-chart-line ${cls}` }));
            const last = points[points.length - 1][key];
            if (last != null) labels.push({ at: y(last), text: `${name} ${pct(last)}` });
        };
        line('serverCpu', 'is-rest', 'Serveur');
        line('appCpu', 'is-app', 'App');
        // Direct labels at the end of the lines, kept 14 px apart when the lines meet
        labels.sort((a, b) => a.at - b.at);
        if (labels.length === 2 && labels[1].at - labels[0].at < 14) {
            const mid = (labels[0].at + labels[1].at) / 2;
            labels[0].at = Math.max(pad.t, mid - 7);
            labels[1].at = labels[0].at + 14;
        }
        for (const { at, text } of labels) {
            const label = svg('text', { x: W - pad.r + 8, y: at + 4, class: 'tllm-chart-label' });
            label.textContent = text;
            root.append(label);
        }

        // Crosshair and tooltip
        const cross = svg('line', { y1: pad.t, y2: H - pad.b, class: 'tllm-chart-cross', visibility: 'hidden' });
        const dotApp = svg('circle', { r: 4, class: 'tllm-chart-dot is-app', visibility: 'hidden' });
        const dotRest = svg('circle', { r: 4, class: 'tllm-chart-dot is-rest', visibility: 'hidden' });
        root.append(cross, dotRest, dotApp);
        const hit = svg('rect', {
            x: pad.l,
            y: 0,
            width: W - pad.l - pad.r,
            height: H,
            fill: 'transparent',
        });
        root.append(hit);
        const tip = el('div', 'tllm-chart-tip');
        tip.hidden = true;
        const show = (clientX) => {
            const box = root.getBoundingClientRect();
            const vx = ((clientX - box.left) / box.width) * W;
            let best = points[0];
            for (const p of points) if (Math.abs(x(p.t) - vx) < Math.abs(x(best.t) - vx)) best = p;
            const px = x(best.t);
            cross.setAttribute('x1', px);
            cross.setAttribute('x2', px);
            cross.setAttribute('visibility', 'visible');
            for (const [dot, key] of [
                [dotApp, 'appCpu'],
                [dotRest, 'serverCpu'],
            ]) {
                if (best[key] == null) continue;
                dot.setAttribute('cx', px);
                dot.setAttribute('cy', y(best[key]));
                dot.setAttribute('visibility', 'visible');
            }
            tip.textContent = '';
            tip.append(el('b', '', clockSec(best.t)));
            const row = (cls, name, value) => {
                const r = el('div');
                r.append(el('i', cls), `${name} `, el('b', '', value));
                tip.append(r);
            };
            row('is-app', 'TLLM*meet', pct(best.appCpu));
            row('is-rest', 'Serveur', pct(best.serverCpu));
            tip.append(
                el(
                    'div',
                    'tllm-chart-tip-sub',
                    `${best.peers} personne${best.peers > 1 ? 's' : ''} connectée${best.peers > 1 ? 's' : ''}`
                )
            );
            tip.hidden = false;
            const left = (px / W) * box.width;
            tip.style.left = `${Math.min(Math.max(left, 70), box.width - 70)}px`;
        };
        const hide = () => {
            tip.hidden = true;
            for (const n of [cross, dotApp, dotRest]) n.setAttribute('visibility', 'hidden');
        };
        // The chart is drawn again every 5 s: a pointer still on it keeps its tooltip
        const track = (e) => {
            state.hoverX = e.clientX;
            show(e.clientX);
        };
        hit.addEventListener('pointermove', track);
        hit.addEventListener('pointerdown', track);
        hit.addEventListener('pointerleave', () => {
            state.hoverX = null;
            hide();
        });
        plot.append(root, tip);
        if (state.hoverX !== null) show(state.hoverX);
    }

    // ---------- figures ----------

    function stat(label, value, sub, status) {
        const li = el('li', `tllm-stat${status ? ` is-${status}` : ''}`);
        li.append(el('span', 'tllm-stat-label', label));
        li.append(el('span', 'tllm-stat-value', value));
        if (sub) li.append(el('span', 'tllm-stat-sub', sub));
        return li;
    }

    const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

    function transcriptionStat(t) {
        if (!t) return stat('Transcription', 'Désactivée', 'WHISPER_ENABLED');
        if (t.external) return stat('Transcription', 'Service externe', 'pas mesurée ici');
        if (t.state === 'unreachable') return stat('Transcription', 'Injoignable', 'le service ne répond pas', 'bad');
        const labels = { ready: 'Modèle chargé', loading: 'Chargement…', stopped: 'Au repos' };
        return stat(
            'Transcription',
            labels[t.state] || t.state || '—',
            t.memory ? `${bytes(t.memory)} de mémoire` : null,
            t.state === 'ready' || t.state === 'loading' ? 'busy' : null
        );
    }

    function renderMetrics(m) {
        state.metrics = m;
        if (!m.app || !m.server) return;
        const { app, server } = m;
        $('serverSince').textContent = `TLLM*meet tourne depuis ${span(app.uptimeMs)}`;

        meter($('cpuMeter'), {
            title: 'Processeur',
            app: app.cpu || 0,
            used: Math.max(server.cpu || 0, app.cpu || 0),
            total: 1,
            appText: pct(app.cpu),
            restText: `${pct(server.cpu)} de ${plural(server.cpus, 'cœur')}`,
        });
        const memTotal = server.memory.total;
        meter($('memMeter'), {
            title: 'Mémoire',
            app: app.memory.total,
            used: Math.max(server.memory.used, app.memory.total),
            total: memTotal,
            appText: bytes(app.memory.total),
            restText: `${bytes(server.memory.used)} sur ${bytes(memTotal)}`,
        });

        chart(m.history || []);

        const lag = app.lagMs;
        const lagStatus = lag == null ? null : lag < 50 ? 'good' : lag < 200 ? 'warn' : 'bad';
        const lagWord = { good: 'fluide', warn: 'chargé', bad: 'saturé' }[lagStatus] || '';
        const list = $('serverStats');
        list.textContent = '';
        list.append(
            stat(
                'En ce moment',
                plural(app.rooms, 'visio'),
                `${plural(app.peers, 'personne')}, ${plural(app.transports, 'connexion')}`
            ),
            stat('Réseau', `↓ ${bitrate(app.bitrateIn)}`, `↑ ${bitrate(app.bitrateOut)} envoyés`),
            stat(
                'Réactivité',
                lag == null ? '—' : `${num(lag, lag < 10 ? 1 : 0)} ms`,
                lagWord ? `${lagStatus === 'good' ? '✓' : '⚠'} ${lagWord}, pire attente sur 5 s` : null,
                lagStatus
            ),
            stat(
                'Mémoire de l’app',
                bytes(app.memory.node),
                `Node, + ${bytes(app.memory.workers)} pour ${plural(app.workers, 'worker')} média`
            ),
            transcriptionStat(m.transcription),
            stat('Charge du serveur', num(server.load[0], 2), `sur ${plural(server.cpus, 'cœur')} (1 min)`)
        );
    }

    // ---------- history: what each meeting used, grouped by room ----------

    const PAGE = 10; // rooms shown, then "Voir plus"
    const SESSIONS = 10; // meetings shown when a room is opened
    const history = { days: 7, query: '', shown: PAGE, open: new Set(), more: new Set(), data: null };

    const fold = (s) =>
        String(s || '')
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .toLowerCase();

    // Weighted by duration: a long meeting counts more than a short one
    // Meetings recorded before a figure existed have none: they are left out of its average and peak
    function aggregate(list) {
        const total = { count: list.length, durationMs: 0, peerMs: 0, bytes: 0, cpuMs: 0 };
        let memByteMs = 0;
        let memMs = 0;
        total.cpuPeak = null;
        total.memPeak = null;
        for (const m of list) {
            total.durationMs += m.durationMs;
            total.peerMs += m.peerMs || 0;
            total.bytes += (m.bytesIn || 0) + (m.bytesOut || 0);
            total.cpuMs += m.cpuMs || 0;
            if (m.memAvg != null) {
                memByteMs += m.memAvg * m.durationMs;
                memMs += m.durationMs;
            }
            if (m.cpuPeak != null) total.cpuPeak = Math.max(total.cpuPeak || 0, m.cpuPeak);
            if (m.memPeak != null) total.memPeak = Math.max(total.memPeak || 0, m.memPeak);
        }
        const cpus = history.data?.cpus || 1;
        total.cpuShare = total.durationMs ? total.cpuMs / (total.durationMs * cpus) : null;
        total.memAvg = memMs ? memByteMs / memMs : null;
        return total;
    }

    function groups(meetings) {
        const byRoom = new Map();
        for (const m of meetings) {
            if (!byRoom.has(m.room)) byRoom.set(m.room, { room: m.room, name: m.name, meetings: [] });
            byRoom.get(m.room).meetings.push(m); // newest first, as the server sends them
        }
        return Array.from(byRoom.values())
            .map((g) => ({
                ...g,
                live: g.meetings.some((m) => m.live),
                last: g.meetings[0].startedAt,
                total: aggregate(g.meetings),
            }))
            .sort((a, b) => b.live - a.live || b.last - a.last);
    }

    function totalsTiles(meetings) {
        const t = aggregate(meetings);
        const rooms = new Set(meetings.map((m) => m.room)).size;
        const list = $('historyTotals');
        list.textContent = '';
        list.append(
            stat('Visios', String(t.count), plural(rooms, 'salle')),
            stat('Durée cumulée', t.count ? span(t.durationMs) : '—', `${num(t.peerMs / 3600000, 1)} heure-personne`),
            stat('Processeur', pct(t.cpuShare), t.cpuPeak != null ? `en moyenne, pic ${pct(t.cpuPeak)}` : null),
            stat('Mémoire', bytes(t.memAvg), t.memPeak != null ? `en moyenne, pic ${bytes(t.memPeak)}` : null),
            stat('Données', bytes(t.bytes), 'reçues et envoyées')
        );
    }

    const cell = (text, cls = 'is-num', title) => {
        const td = el('td', cls, text);
        if (title) td.title = title;
        return td;
    };

    // The five figures shared by a room row and a meeting row
    const figures = (m) => [
        cell(pct(m.cpuShare), 'is-num', m.cpuMs != null ? `${num(m.cpuMs / 1000)} s de calcul` : undefined),
        cell(pct(m.cpuPeak), 'is-num is-quiet'),
        cell(bytes(m.memAvg)),
        cell(bytes(m.memPeak), 'is-num is-quiet'),
        cell(bytes(m.bytes ?? (m.bytesIn || 0) + (m.bytesOut || 0)), 'is-num is-data'),
    ];

    function groupRow(g) {
        const open = history.open.has(g.room);
        const tr = el('tr', `tllm-group${open ? ' is-open' : ''}`);
        const th = el('th', 'tllm-cost-name');
        th.scope = 'row';
        const button = el('button', 'tllm-group-toggle');
        button.type = 'button';
        button.setAttribute('aria-expanded', String(open));
        button.append(el('span', 'tllm-group-caret', open ? '▾' : '▸'), el('span', '', g.name));
        button.onclick = () => {
            if (history.open.has(g.room)) history.open.delete(g.room);
            else history.open.add(g.room);
            renderHistory();
        };
        th.append(button);
        const when = el('span', 'tllm-cost-when', g.live ? '' : `dernière ${day(g.last)}`);
        if (g.live) when.append(el('span', 'tllm-pill is-live', 'En cours'));
        th.append(when);
        const visios = plural(g.total.count, 'visio');
        th.append(el('span', 'tllm-cost-compact', `${visios} · ${span(g.total.durationMs)}`)); // phone
        tr.append(th, cell(visios, 'is-wide'), cell(span(g.total.durationMs), 'is-wide'), ...figures(g.total));
        return tr;
    }

    function meetingRow(m) {
        const tr = el('tr', `tllm-session${m.live ? ' is-live' : ''}`);
        const th = el('th', 'tllm-cost-name');
        th.scope = 'row';
        const top = el('span', '', `${day(m.startedAt)}, ${clock(m.startedAt)}`);
        if (m.live) top.append(' ', el('span', 'tllm-pill is-live', 'En cours'));
        th.append(top);
        if (m.asrRequests) {
            const asr = m.asrMs ? `transcrite, ${span(m.asrMs)} de calcul` : 'transcrite';
            th.append(el('span', 'tllm-cost-when', asr));
        }
        const people = plural(m.peakPeers || 0, 'personne');
        th.append(el('span', 'tllm-cost-compact', `${people} · ${span(m.durationMs)}`)); // phone
        tr.append(
            th,
            cell(people, 'is-wide', `au plus ; ${num((m.peerMs || 0) / 3600000, 1)} heure-personne`),
            cell(span(m.durationMs), 'is-wide'),
            ...figures(m)
        );
        return tr;
    }

    function renderHistory() {
        const data = history.data;
        if (!data) return;
        const q = fold(history.query.trim());
        const meetings = q ? data.meetings.filter((m) => fold(m.name).includes(q)) : data.meetings;
        totalsTiles(meetings);
        const rows = $('costRows');
        rows.textContent = '';
        const all = groups(meetings);
        if (!all.length) {
            const tr = el('tr');
            const td = el(
                'td',
                'tllm-cost-empty',
                q ? 'Aucune salle de ce nom sur la période.' : 'Aucune visio sur la période.'
            );
            td.colSpan = 8;
            tr.append(td);
            rows.append(tr);
        }
        for (const g of all.slice(0, history.shown)) {
            rows.append(groupRow(g));
            if (!history.open.has(g.room)) continue;
            const many = history.more.has(g.room) ? g.meetings : g.meetings.slice(0, SESSIONS);
            many.forEach((m) => rows.append(meetingRow(m)));
            if (many.length < g.meetings.length) {
                const tr = el('tr', 'tllm-session');
                const td = el('td', 'tllm-session-more');
                td.colSpan = 8;
                const b = el('button', 'tllm-text-button', `Voir les ${g.meetings.length - many.length} autres visios`);
                b.type = 'button';
                b.onclick = () => {
                    history.more.add(g.room);
                    renderHistory();
                };
                td.append(b);
                tr.append(td);
                rows.append(tr);
            }
        }
        const rest = all.length - history.shown;
        $('historyMore').hidden = rest <= 0;
        $('historyMoreButton').textContent = `Voir ${Math.min(rest, PAGE)} salle${rest > 1 ? 's' : ''} de plus`;
    }

    function setupHistory() {
        for (const b of document.querySelectorAll('#historyPeriod button')) {
            b.onclick = () => {
                history.days = Number(b.dataset.days);
                history.shown = PAGE;
                for (const other of document.querySelectorAll('#historyPeriod button')) {
                    other.setAttribute('aria-pressed', String(other === b));
                }
                loadUsage();
            };
        }
        $('historySearch').addEventListener('input', (e) => {
            history.query = e.target.value;
            history.shown = PAGE;
            renderHistory();
        });
        $('historyMoreButton').onclick = () => {
            history.shown += PAGE;
            renderHistory();
        };
    }

    async function get(url) {
        const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        return res.json();
    }

    const loadMetrics = () =>
        get('/api/admin/metrics')
            .then(renderMetrics)
            .catch(() => {});
    const loadUsage = () =>
        get(`/api/admin/usage?days=${history.days}`)
            .then((data) => {
                history.data = data;
                renderHistory();
            })
            .catch(() => {});

    window.tllmServer = {
        start({ timeZone } = {}) {
            if (timeZone) state.timeZone = timeZone;
            $('serverBlock').hidden = false;
            setupHistory();
            loadMetrics();
            loadUsage();
            setInterval(() => !document.hidden && loadMetrics(), 5000);
            setInterval(() => !document.hidden && loadUsage(), 30000);
            let resizing;
            window.addEventListener('resize', () => {
                clearTimeout(resizing);
                resizing = setTimeout(() => state.metrics && chart(state.metrics.history || []), 150);
            });
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) return;
                loadMetrics();
                loadUsage();
            });
        },
    };
})();
