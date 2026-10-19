'use strict';

// TLLM*meet: the log of each meeting, for the admin when something went wrong ("Serveur" block).
// Who came and left (and why), whose network dropped or came back, screen shares, errors from the
// browsers and from the transcription, and the server's own warnings while it handled someone's
// request. One file per meeting, DATA_DIR/journaux/<room>--<start>.jsonl, one line per event:
// { t, level: 'info' | 'warn' | 'error', text, who?, tech?, detail? }. Files older than the retention
// period are deleted. A meeting keeps at most MAX_LINES lines: a flood does not fill the disk.

const fs = require('fs');
const path = require('path');

const ROOM_ID = /^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/; // breakout rooms included
const SESSION_ID = /^[0-9]{10,16}$/;
const MAX_LINES = 3000;
const MAX_TEXT = 500;
const LEVELS = new Set(['info', 'warn', 'error']);

const isRoomId = (id) => typeof id === 'string' && id.length <= 120 && ROOM_ID.test(id);
const clip = (s, n) => {
    const str = String(s ?? '')
        .replace(/\s+/g, ' ')
        .trim();
    return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};

class MeetingLog {
    constructor({ dir, now = () => Date.now(), log = console, retentionDays = 30 } = {}) {
        this.dir = dir;
        this.now = now;
        this.log = log;
        this.retentionMs = Math.max(1, Number(retentionDays) || 30) * 86400000;
        this.live = new Map(); // room id -> { id, file, lines, warnings, errors, dropped }
    }

    file(room, id) {
        return path.join(this.dir, `${room}--${id}.jsonl`);
    }

    // A meeting starts; startedAt is the one of its usage record (Usage.js), which links the two
    start(room, startedAt) {
        if (!isRoomId(room) || this.live.has(room)) return this.live.get(room) || null;
        const session = { id: String(startedAt), lines: 0, warnings: 0, errors: 0, dropped: 0 };
        this.live.set(room, session);
        return session;
    }

    // level: info, warn or error. who: the person concerned. tech: a server message as it is
    add(room, level, text, { who, tech, detail } = {}) {
        const session = this.live.get(room);
        if (!session || !this.dir) return false;
        const lvl = LEVELS.has(level) ? level : 'info';
        if (lvl === 'warn') session.warnings++;
        if (lvl === 'error') session.errors++;
        if (session.lines >= MAX_LINES) {
            session.dropped++;
            return false;
        }
        const entry = { t: this.now(), level: lvl, text: clip(text, MAX_TEXT) };
        if (who) entry.who = clip(who, 60);
        if (tech) entry.tech = true;
        if (detail !== undefined && detail !== null && detail !== '') entry.detail = clip(detail, MAX_TEXT);
        try {
            fs.mkdirSync(this.dir, { recursive: true });
            fs.appendFileSync(this.file(room, session.id), JSON.stringify(entry) + '\n');
            session.lines++;
            return true;
        } catch (err) {
            this.log.error('MeetingLog: cannot write (is DATA_DIR writable?)', { error: err.message });
            return false;
        }
    }

    // Every meeting under way (a server problem concerns them all)
    addAll(level, text, options) {
        for (const room of this.live.keys()) this.add(room, level, text, options);
    }

    counts(room) {
        const s = this.live.get(room);
        return s ? { lines: s.lines, warnings: s.warnings, errors: s.errors, dropped: s.dropped } : null;
    }

    // The meeting ended: its counts go into its usage record
    end(room) {
        const counts = this.counts(room);
        if (!counts) return null;
        if (counts.dropped) {
            const session = this.live.get(room);
            const line = { t: this.now(), level: 'warn', text: `${counts.dropped} événements de plus non gardés` };
            try {
                fs.appendFileSync(this.file(room, session.id), JSON.stringify(line) + '\n');
            } catch {
                /* the counts still say it */
            }
        }
        this.live.delete(room);
        return counts;
    }

    read(room, id) {
        if (!isRoomId(room) || !SESSION_ID.test(String(id)) || !this.dir) return null;
        let raw;
        try {
            raw = fs.readFileSync(this.file(room, id), 'utf8');
        } catch {
            return [];
        }
        const entries = [];
        for (const line of raw.split('\n')) {
            if (!line.trim()) continue;
            try {
                entries.push(JSON.parse(line));
            } catch {
                /* a line cut by a crash */
            }
        }
        return entries;
    }

    // Plain text, for a download: "14:02:31  ERREUR  Marie : …"
    toText(entries, { name, timeZone = 'Europe/Paris' } = {}) {
        const time = (ms) =>
            new Intl.DateTimeFormat('fr-FR', {
                timeZone,
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
            }).format(new Date(ms));
        const label = { info: '       ', warn: 'ALERTE ', error: 'ERREUR ' };
        const head = name ? [`Journal de la visio « ${name} »`, ''] : [];
        const lines = entries.map((e) => {
            const who = e.who ? `${e.who} : ` : '';
            const detail = e.detail ? ` (${e.detail})` : '';
            return `${time(e.t)}  ${label[e.level] || label.info}${e.tech ? '[technique] ' : ''}${who}${e.text}${detail}`;
        });
        return [...head, ...lines].join('\n') + '\n';
    }

    purge() {
        if (!this.dir) return 0;
        let names = [];
        try {
            names = fs.readdirSync(this.dir);
        } catch {
            return 0;
        }
        const limit = this.now() - this.retentionMs;
        let removed = 0;
        for (const f of names) {
            const m = /--([0-9]{10,16})\.jsonl$/.exec(f);
            if (!m || Number(m[1]) >= limit) continue;
            try {
                fs.unlinkSync(path.join(this.dir, f));
                removed++;
            } catch {
                /* tried again later */
            }
        }
        return removed;
    }
}

module.exports = { MeetingLog, isRoomId };
