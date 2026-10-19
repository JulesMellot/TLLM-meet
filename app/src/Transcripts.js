'use strict';

// TLLM*meet: meeting transcription. A presenter starts it for the whole room; every browser then
// sends its own microphone, cut on pauses, to the speech-to-text server (see TllmTranscript.js).
// Each recognised sentence is kept here with the speaker's name (taken from the server-side peer)
// and the moment it was said. One file per meeting, DATA_DIR/transcriptions/<room>--<start>.jsonl:
// a header line, then one line per sentence and the start/pause/end marks.
// The organiser downloads it as plain text once the meeting is over.

const fs = require('fs');
const path = require('path');

const ROOM_ID = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/; // ids made by makeRoomId; no breakout rooms
const SESSION_ID = /^[0-9]{10,16}$/;
const LATE_MS = 60 * 1000; // sentences still being recognised when the room closes
const GRACE_MS = 30 * 1000; // sentences sent just before a pause
const MAX_TEXT = 2000;
const MAX_NAME = 60;

const isRoomId = (id) => typeof id === 'string' && id.length <= 80 && ROOM_ID.test(id);

function pad(n) {
    return String(n).padStart(2, '0');
}

// 754000 -> "00:12:34"
function timecode(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

class Transcripts {
    constructor({ dir, now = () => Date.now(), log = console, retentionDays = 30, timeZone = 'Europe/Paris' } = {}) {
        this.dir = dir;
        this.now = now;
        this.log = log;
        this.retentionMs = Math.max(1, Number(retentionDays) || 30) * 86400000;
        this.timeZone = timeZone;
        this.live = new Map(); // room id -> session of the meeting under way
        this.summaries = new Map(); // file -> { mtimeMs, size, summary }: the home asks every 30 s
        this.dirReady = false;
    }

    file(room, id) {
        return path.join(this.dir, `${room}--${id}.jsonl`);
    }

    write(session, entry) {
        if (!this.dir) return;
        const line = JSON.stringify(entry) + '\n';
        try {
            if (!this.dirReady) fs.mkdirSync(this.dir, { recursive: true });
            this.dirReady = true;
            try {
                fs.appendFileSync(this.file(session.room, session.id), line);
            } catch (err) {
                if (err.code !== 'ENOENT') throw err;
                fs.mkdirSync(this.dir, { recursive: true }); // the folder was removed meanwhile
                fs.appendFileSync(this.file(session.room, session.id), line);
            }
        } catch (err) {
            this.dirReady = false;
            this.log.error('Transcripts: cannot write (is DATA_DIR writable?)', { error: err.message });
        }
    }

    eligible(room) {
        return isRoomId(room);
    }

    isActive(room) {
        return !!this.live.get(room)?.active;
    }

    anyActive() {
        for (const session of this.live.values()) if (session.active) return true;
        return false;
    }

    // Start, or resume after a pause: a meeting keeps one file until its room closes
    start(room, { name, by } = {}) {
        if (!isRoomId(room)) return null;
        const now = this.now();
        let session = this.live.get(room);
        if (!session || session.closedAt) {
            session = { room, id: String(now), startedAt: now, active: false, pending: 0, closedAt: null };
            this.live.set(room, session);
            this.write(session, { v: 1, room, name: String(name || room).slice(0, 120), startedAt: now });
        }
        if (!session.active) {
            session.active = true;
            session.stoppedAt = null;
            this.write(session, { ev: 'start', at: now, by: by ? String(by).slice(0, MAX_NAME) : undefined });
        }
        return session;
    }

    stop(room, { by } = {}) {
        const session = this.live.get(room);
        if (!session?.active) return null;
        session.active = false;
        session.stoppedAt = this.now();
        this.write(session, { ev: 'stop', at: session.stoppedAt, by: by ? String(by).slice(0, MAX_NAME) : undefined });
        return session;
    }

    // The room closed: the file is final once the last sentences are recognised
    close(room) {
        const session = this.live.get(room);
        if (!session || session.closedAt) return;
        if (session.active) this.stop(room);
        session.closedAt = this.now();
        this.write(session, { ev: 'end', at: session.closedAt });
        const timer = setTimeout(() => {
            if (this.live.get(room) === session) this.live.delete(room);
        }, LATE_MS);
        timer.unref?.();
    }

    // A sentence is being recognised: the file is not ready until it comes back.
    // The last one said before a pause or the end of the meeting still counts.
    begin(room) {
        const session = this.live.get(room);
        const recent = session?.stoppedAt && this.now() - session.stoppedAt < GRACE_MS;
        if (!session || !(session.active || recent)) return null;
        session.pending++;
        return session;
    }

    // Keep a recognised sentence. at: when the speaker started saying it
    add(session, { name, text, at }) {
        if (!session) return false;
        session.pending = Math.max(0, session.pending - 1);
        const clean = String(text || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, MAX_TEXT);
        if (!clean) return false;
        const who =
            String(name || '')
                .trim()
                .slice(0, MAX_NAME) || 'Participant';
        const when = Number.isFinite(at) ? Math.round(at) : this.now();
        this.write(session, { t: Math.max(session.startedAt, when), who, text: clean });
        return true;
    }

    // The recognition failed: forget the sentence
    abandon(session) {
        if (session) session.pending = Math.max(0, session.pending - 1);
    }

    read(room, id) {
        if (!isRoomId(room) || !SESSION_ID.test(String(id)) || !this.dir) return null;
        let raw;
        try {
            raw = fs.readFileSync(this.file(room, id), 'utf8');
        } catch {
            return null;
        }
        const out = { id: String(id), room, name: room, startedAt: Number(id), endedAt: null, lines: [], marks: [] };
        for (const line of raw.split('\n')) {
            if (!line.trim()) continue;
            let entry;
            try {
                entry = JSON.parse(line);
            } catch {
                continue; // a line cut by a crash
            }
            if (entry.v) {
                out.name = entry.name || room;
                out.startedAt = entry.startedAt || out.startedAt;
            } else if (entry.ev) {
                out.marks.push(entry);
                if (entry.ev === 'end') out.endedAt = entry.at;
            } else if (typeof entry.text === 'string') {
                out.lines.push(entry);
            }
        }
        out.lines.sort((a, b) => a.t - b.t);
        return out;
    }

    status(room, id) {
        const session = this.live.get(room);
        if (session && session.id === String(id)) {
            if (session.active) return 'active';
            if (session.pending > 0) return 'finishing';
            return session.closedAt ? 'ready' : 'paused';
        }
        return 'ready';
    }

    // What the lists show of a meeting, read again only when its file changed
    summary(room, id) {
        const file = this.file(room, id);
        let stat;
        try {
            stat = fs.statSync(file);
        } catch {
            this.summaries.delete(file);
            return null;
        }
        const cached = this.summaries.get(file);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.summary;
        const t = this.read(room, id);
        if (!t) return null;
        const last = t.lines.length ? t.lines[t.lines.length - 1].t : t.startedAt;
        const summary = {
            id,
            startedAt: t.startedAt,
            endedAt: t.endedAt || Math.max(last, ...t.marks.map((m) => m.at || 0)),
            lines: t.lines.length,
            speakers: [...new Set(t.lines.map((l) => l.who))],
        };
        this.summaries.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, summary });
        return summary;
    }

    // Session ids of a room, newest first (an id is the start time)
    ids(room) {
        if (!isRoomId(room) || !this.dir) return [];
        let names = [];
        try {
            names = fs.readdirSync(this.dir);
        } catch {
            return [];
        }
        const prefix = `${room}--`;
        return names
            .filter((f) => f.startsWith(prefix) && f.endsWith('.jsonl'))
            .map((f) => f.slice(prefix.length, -'.jsonl'.length))
            .filter((id) => SESSION_ID.test(id))
            .sort((a, b) => Number(b) - Number(a));
    }

    // The meetings of a room, newest first
    list(room) {
        return this.ids(room)
            .map((id) => {
                const summary = this.summary(room, id);
                return summary && { ...summary, status: this.status(room, id) };
            })
            .filter(Boolean)
            .sort((a, b) => b.startedAt - a.startedAt);
    }

    // Only the newest file is read
    latest(room) {
        for (const id of this.ids(room)) {
            const summary = this.summary(room, id);
            if (summary) return { ...summary, status: this.status(room, id) };
        }
        return null;
    }

    // The newest meeting of each room, for the organiser's home: one directory read for all rooms
    latestByRoom() {
        const out = new Map();
        if (!this.dir) return out;
        let names = [];
        try {
            names = fs.readdirSync(this.dir);
        } catch {
            return out;
        }
        const newest = new Map(); // room -> newest session id
        for (const f of names) {
            const m = /^(.+)--([0-9]{10,16})\.jsonl$/.exec(f);
            if (!m || !isRoomId(m[1])) continue;
            if (!newest.has(m[1]) || Number(m[2]) > Number(newest.get(m[1]))) newest.set(m[1], m[2]);
        }
        for (const [room, id] of newest) {
            const summary = this.summary(room, id);
            if (summary) out.set(room, { ...summary, status: this.status(room, id) });
        }
        return out;
    }

    remove(room, id) {
        if (!isRoomId(room) || !SESSION_ID.test(String(id)) || !this.dir) return false;
        if (this.live.get(room)?.id === String(id)) return false; // still being written
        try {
            fs.unlinkSync(this.file(room, id));
            this.summaries.delete(this.file(room, id));
            return true;
        } catch {
            return false;
        }
    }

    // Plain text: a header, then "[00:12:34] Name : sentence", timecode from the start of the transcription
    toText(t) {
        const fmt = (ms, opts) =>
            new Intl.DateTimeFormat('fr-FR', { timeZone: this.timeZone, ...opts }).format(new Date(ms));
        const clock = (ms) => fmt(ms, { hour: '2-digit', minute: '2-digit' });
        const day = fmt(t.startedAt, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        const stops = t.marks.filter((m) => m.ev === 'stop').map((m) => m.at);
        const lastLine = t.lines.length ? t.lines[t.lines.length - 1].t : t.startedAt;
        const end = Math.max(lastLine, ...stops);
        const speakers = [...new Set(t.lines.map((l) => l.who))];

        const out = [
            t.name,
            `Transcription du ${day}, de ${clock(t.startedAt)} à ${clock(end)}`,
            `Participants : ${speakers.length ? speakers.join(', ') : 'aucune parole transcrite'}`,
            'Transcription automatique : elle peut contenir des erreurs.',
            '',
        ];
        // Pauses, in their place among the sentences: a stop followed by a start
        const marks = t.marks.filter((m) => m.ev === 'stop' || m.ev === 'start');
        const pauses = [];
        marks.forEach((m, i) => {
            const next = marks[i + 1];
            if (m.ev === 'stop' && next?.ev === 'start') pauses.push({ from: m.at, to: next.at });
        });
        const mark = (at, text) => ({ at, line: `[${timecode(at - t.startedAt)}] — ${text} —` });
        const events = [
            ...t.lines.map((l) => ({ at: l.t, line: `[${timecode(l.t - t.startedAt)}] ${l.who} : ${l.text}` })),
            ...pauses.flatMap((p) => [
                mark(p.from, `Transcription en pause à ${clock(p.from)}`),
                mark(p.to, `Transcription reprise à ${clock(p.to)}`),
            ]),
        ].sort((a, b) => a.at - b.at);
        for (const e of events) out.push(e.line);
        return out.join('\n') + '\n';
    }

    // Files older than the retention period are deleted
    purge() {
        if (!this.dir) return 0;
        let removed = 0;
        let names = [];
        try {
            names = fs.readdirSync(this.dir);
        } catch {
            return 0;
        }
        const limit = this.now() - this.retentionMs;
        for (const f of names) {
            const m = /--([0-9]{10,16})\.jsonl$/.exec(f);
            if (!m || Number(m[1]) >= limit) continue;
            try {
                fs.unlinkSync(path.join(this.dir, f));
                this.summaries.delete(path.join(this.dir, f));
                removed++;
            } catch {
                /* tried again tomorrow */
            }
        }
        return removed;
    }
}

module.exports = { Transcripts, timecode, isRoomId };
