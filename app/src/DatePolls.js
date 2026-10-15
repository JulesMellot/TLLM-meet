'use strict';

// TLLM*meet: date polls ("caler une réunion").
//
// The admin proposes time slots; guests answer Oui / Si besoin / Non from a link, without an
// account. When the expected number of people have answered (or the deadline passes), the
// slot with the most "Oui" wins, a meeting room is reserved and the calendar feed of the poll
// shows the meeting with its link. Polls are kept in a JSON file (DATA_DIR).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DURATIONS = [15, 30, 45, 60, 90, 120, 180];
const ANSWERS = ['yes', 'maybe', 'no'];
const LIMITS = {
    title: 120,
    description: 1000,
    name: 60,
    slots: 30,
    participants: 200,
    pollsPerOwner: 500,
    expected: 100,
};
const DAY = 24 * 60 * 60 * 1000;

class DatePollError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

// ---------- time zone helpers (wall time in a zone <-> UTC) ----------

function zoneOffsetMs(utcMs, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).formatToParts(new Date(utcMs));
    const get = (type) => Number(parts.find((p) => p.type === type).value);
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - utcMs;
}

// "2026-10-27" + "14:00" in Europe/Paris -> UTC milliseconds (the second pass handles DST changes)
function zonedToUtc(date, time, timeZone) {
    const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    const t = /^(\d{2}):(\d{2})$/.exec(time);
    if (!d || !t) return NaN;
    const [y, m, day, h, mi] = [d[1], d[2], d[3], t[1], t[2]].map(Number);
    if (m < 1 || m > 12 || day < 1 || day > 31 || h > 23 || mi > 59) return NaN;
    const guess = Date.UTC(y, m - 1, day, h, mi);
    if (new Date(guess).getUTCDate() !== day) return NaN; // 31 February
    let ts = guess - zoneOffsetMs(guess, timeZone);
    ts = guess - zoneOffsetMs(ts, timeZone);
    return ts;
}

// ---------- iCalendar ----------

const icsDate = (ms) =>
    new Date(ms)
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}/, '');
const icsText = (s) =>
    String(s ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\r?\n/g, '\\n');

// Lines longer than 75 octets are folded (RFC 5545 3.1), without cutting a UTF-8 character
function icsFold(line) {
    const out = [];
    let current = '';
    let bytes = 0;
    for (const ch of line) {
        const size = Buffer.byteLength(ch);
        if (bytes + size > (out.length ? 74 : 75)) {
            out.push(current);
            current = '';
            bytes = 0;
        }
        current += ch;
        bytes += size;
    }
    out.push(current);
    return out.join('\r\n ');
}

class DatePolls {
    constructor({
        file,
        timeZone = 'Europe/Paris',
        now = () => Date.now(),
        makeRoomId,
        onFix = null,
        log = console,
    } = {}) {
        this.file = file;
        this.onFix = onFix; // called with the poll each time its date is set
        this.timeZone = timeZone;
        this.now = now;
        this.makeRoomId = makeRoomId;
        this.log = log;
        this.polls = new Map();
        this.saveTimer = null;
        this.load();
    }

    // ---------- storage ----------

    load() {
        if (!this.file) return;
        try {
            const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            for (const poll of data.polls || []) this.polls.set(poll.id, poll);
        } catch (err) {
            if (err.code !== 'ENOENT') this.log.error('Date polls: cannot read the data file', { error: err.message });
        }
    }

    save() {
        if (!this.file) return;
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.saveNow(), 200);
        this.saveTimer.unref?.();
    }

    saveNow() {
        if (!this.file) return;
        clearTimeout(this.saveTimer);
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            const tmp = `${this.file}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({ version: 1, polls: Array.from(this.polls.values()) }));
            fs.renameSync(tmp, this.file);
        } catch (err) {
            this.log.error('Date polls: cannot write the data file (is DATA_DIR writable?)', { error: err.message });
        }
    }

    // ---------- create ----------

    create(owner, organizer, input) {
        if (!owner) throw new DatePollError('unauthorized', 401);
        if (this.list(owner).length >= LIMITS.pollsPerOwner) throw new DatePollError('Trop de sondages.');
        const title = typeof input?.title === 'string' ? input.title.trim() : '';
        if (!title || title.length > LIMITS.title) throw new DatePollError('Donnez un titre (120 caractères au plus).');
        const description = typeof input.description === 'string' ? input.description.trim() : '';
        if (description.length > LIMITS.description) throw new DatePollError('Le message est trop long.');
        const duration = Number(input.duration);
        if (!DURATIONS.includes(duration)) throw new DatePollError('Durée non valide.');

        if (!Array.isArray(input.slots) || input.slots.length < 2 || input.slots.length > LIMITS.slots) {
            throw new DatePollError('Proposez entre 2 et 30 créneaux.');
        }
        const now = this.now();
        const slots = [];
        for (const slot of input.slots) {
            const start = zonedToUtc(String(slot?.date), String(slot?.time), this.timeZone);
            if (!Number.isFinite(start)) throw new DatePollError('Créneau non valide.');
            if (start <= now) throw new DatePollError('Un créneau est déjà passé.');
            if (start > now + 366 * DAY) throw new DatePollError('Un créneau est à plus d’un an.');
            slots.push(start);
        }
        slots.sort((a, b) => a - b);
        if (new Set(slots).size !== slots.length) throw new DatePollError('Deux créneaux sont identiques.');

        let expected = null;
        if (input.expected !== null && input.expected !== undefined && input.expected !== '') {
            expected = Number(input.expected);
            if (!Number.isInteger(expected) || expected < 1 || expected > LIMITS.expected) {
                throw new DatePollError('Nombre de participants attendus non valide (1 à 100).');
            }
        }
        let deadline = null;
        if (input.deadline) {
            deadline = zonedToUtc(String(input.deadline), '23:59', this.timeZone);
            if (!Number.isFinite(deadline) || deadline <= now) throw new DatePollError('Date limite non valide.');
            if (deadline >= slots[0]) throw new DatePollError('La date limite doit précéder le premier créneau.');
        }

        const poll = {
            id: this.newId(),
            owner,
            organizer: String(organizer || owner).slice(0, LIMITS.name),
            title,
            description,
            duration,
            timeZone: this.timeZone,
            slots,
            allowMaybe: input.allowMaybe !== false,
            expected,
            deadline,
            participants: [],
            status: 'open',
            fixed: null,
            createdAt: now,
            updatedAt: now,
            sequence: 0,
        };
        this.polls.set(poll.id, poll);
        this.save();
        return poll;
    }

    newId() {
        let id;
        do id = crypto.randomBytes(8).toString('base64url').replace(/[-_]/g, '').slice(0, 10).toLowerCase();
        while (id.length < 10 || this.polls.has(id));
        return id;
    }

    get(id) {
        return typeof id === 'string' ? this.polls.get(id) || null : null;
    }

    list(owner) {
        return Array.from(this.polls.values())
            .filter((p) => p.owner === owner)
            .sort((a, b) => b.createdAt - a.createdAt);
    }

    owned(id, owner) {
        const poll = this.get(id);
        if (!poll) throw new DatePollError('Sondage introuvable.', 404);
        if (!owner || poll.owner !== owner) throw new DatePollError('unauthorized', 403);
        return poll;
    }

    // ---------- answers ----------

    cleanAnswer(poll, input) {
        const name = typeof input?.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
        if (!name || name.length > LIMITS.name) throw new DatePollError('Indiquez votre nom (60 caractères au plus).');
        const answers = input.answers;
        if (!Array.isArray(answers) || answers.length !== poll.slots.length)
            throw new DatePollError('Réponses non valides.');
        for (const a of answers) {
            if (!ANSWERS.includes(a) || (a === 'maybe' && !poll.allowMaybe))
                throw new DatePollError('Réponses non valides.');
        }
        return { name, answers: [...answers] };
    }

    answer(id, input) {
        const poll = this.get(id);
        if (!poll) throw new DatePollError('Sondage introuvable.', 404);
        if (poll.status !== 'open') throw new DatePollError('Ce sondage est terminé.', 409);
        if (poll.participants.length >= LIMITS.participants) throw new DatePollError('Ce sondage est complet.', 409);
        const { name, answers } = this.cleanAnswer(poll, input);
        const token = crypto.randomBytes(18).toString('base64url');
        const participant = {
            id: crypto.randomBytes(6).toString('hex'),
            name,
            answers,
            tokenHash: hash(token),
            createdAt: this.now(),
            updatedAt: this.now(),
        };
        poll.participants.push(participant);
        this.touch(poll);
        this.autoFix(poll);
        return { participantId: participant.id, token };
    }

    updateAnswer(id, participantId, token, input) {
        const poll = this.get(id);
        if (!poll) throw new DatePollError('Sondage introuvable.', 404);
        const participant = poll.participants.find((p) => p.id === participantId);
        if (!participant || typeof token !== 'string' || !sameHash(participant.tokenHash, hash(token))) {
            throw new DatePollError('Vous ne pouvez pas modifier cette réponse.', 403);
        }
        if (poll.status !== 'open') throw new DatePollError('Ce sondage est terminé.', 409);
        Object.assign(participant, this.cleanAnswer(poll, input), { updatedAt: this.now() });
        this.touch(poll);
        this.autoFix(poll);
        return true;
    }

    removeAnswer(id, owner, participantId) {
        const poll = this.owned(id, owner);
        const before = poll.participants.length;
        poll.participants = poll.participants.filter((p) => p.id !== participantId);
        if (poll.participants.length === before) throw new DatePollError('Réponse introuvable.', 404);
        this.touch(poll);
        return true;
    }

    // ---------- choosing the date ----------

    // Most "Oui", then most "Si besoin", then the earliest. -1 when nobody can come.
    best(poll) {
        let best = -1;
        let bestYes = 0;
        let bestMaybe = 0;
        poll.slots.forEach((_, i) => {
            let yes = 0;
            let maybe = 0;
            for (const p of poll.participants) {
                if (p.answers[i] === 'yes') yes++;
                else if (p.answers[i] === 'maybe') maybe++;
            }
            if (yes + maybe === 0) return;
            if (best < 0 || yes > bestYes || (yes === bestYes && maybe > bestMaybe)) {
                best = i;
                bestYes = yes;
                bestMaybe = maybe;
            }
        });
        return best;
    }

    autoFix(poll) {
        if (poll.status !== 'open' || !poll.expected || poll.participants.length < poll.expected) return;
        const best = this.best(poll);
        if (best >= 0) this.setFixed(poll, best, true);
    }

    fix(id, owner, slot) {
        const poll = this.owned(id, owner);
        if (poll.status === 'closed') throw new DatePollError('Ce sondage est fermé.', 409);
        if (!Number.isInteger(slot) || slot < 0 || slot >= poll.slots.length)
            throw new DatePollError('Créneau non valide.');
        this.setFixed(poll, slot, false);
        return poll;
    }

    setFixed(poll, slot, auto) {
        const start = poll.slots[slot];
        // Changing the date keeps the room, so a link already shared stays valid
        const room = poll.fixed?.room || this.makeRoomId(poll.title, 6);
        poll.fixed = { slot, start, end: start + poll.duration * 60000, room, at: this.now(), auto: !!auto };
        poll.status = 'fixed';
        poll.sequence = (poll.sequence || 0) + 1;
        this.touch(poll);
        this.onFix?.(poll);
    }

    close(id, owner) {
        const poll = this.owned(id, owner);
        if (poll.status === 'open') {
            poll.status = 'closed';
            this.touch(poll);
        }
        return poll;
    }

    remove(id, owner) {
        this.owned(id, owner);
        this.polls.delete(id);
        this.save();
        return true;
    }

    // Deadlines: the date is set from the answers received, or the poll closes if nobody can come
    checkDeadlines() {
        const now = this.now();
        for (const poll of this.polls.values()) {
            if (poll.status !== 'open' || !poll.deadline || poll.deadline > now) continue;
            const best = this.best(poll);
            if (best >= 0) this.setFixed(poll, best, true);
            else {
                poll.status = 'closed';
                this.touch(poll);
            }
        }
    }

    touch(poll) {
        poll.updatedAt = this.now();
        this.save();
    }

    // ---------- views ----------

    view(poll, { admin = false } = {}) {
        return {
            id: poll.id,
            title: poll.title,
            description: poll.description,
            organizer: poll.organizer,
            duration: poll.duration,
            timeZone: poll.timeZone,
            slots: poll.slots,
            allowMaybe: poll.allowMaybe,
            expected: poll.expected,
            deadline: poll.deadline,
            status: poll.status,
            fixed: poll.fixed && {
                slot: poll.fixed.slot,
                start: poll.fixed.start,
                end: poll.fixed.end,
                room: poll.fixed.room,
                auto: poll.fixed.auto,
            },
            best: this.best(poll),
            participants: poll.participants.map((p) => ({ id: p.id, name: p.name, answers: p.answers })),
            createdAt: poll.createdAt,
            admin,
        };
    }

    summary(poll) {
        return {
            id: poll.id,
            title: poll.title,
            status: poll.status,
            slots: poll.slots.length,
            answers: poll.participants.length,
            expected: poll.expected,
            fixed: poll.fixed && { start: poll.fixed.start, room: poll.fixed.room },
            createdAt: poll.createdAt,
        };
    }

    // Subscription feed: empty until the date is set, then the meeting with its link
    feed(poll, host) {
        const lines = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//TLLM*meet//Rendez-vous//FR',
            'CALSCALE:GREGORIAN',
            'METHOD:PUBLISH',
            `X-WR-CALNAME:${icsText(poll.title)}`,
            `X-WR-TIMEZONE:${poll.timeZone}`,
            'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
            'X-PUBLISHED-TTL:PT1H',
        ];
        if (poll.status === 'fixed' && poll.fixed) lines.push(...this.eventLines(poll, host));
        lines.push('END:VCALENDAR');
        return lines.map(icsFold).join('\r\n') + '\r\n';
    }

    eventLines(poll, host) {
        const url = `${host}/join/${encodeURIComponent(poll.fixed.room)}`;
        const description = [poll.description, `Lien de la visio : ${url}`].filter(Boolean).join('\n\n');
        let hostname = 'tllm-meet';
        try {
            hostname = new URL(host).hostname;
        } catch {
            /* keep the default */
        }
        return [
            'BEGIN:VEVENT',
            `UID:rdv-${poll.id}@${hostname}`,
            `DTSTAMP:${icsDate(poll.fixed.at)}`,
            `LAST-MODIFIED:${icsDate(poll.updatedAt)}`,
            `SEQUENCE:${poll.sequence || 0}`,
            `DTSTART:${icsDate(poll.fixed.start)}`,
            `DTEND:${icsDate(poll.fixed.end)}`,
            `SUMMARY:${icsText(poll.title)}`,
            `DESCRIPTION:${icsText(description)}`,
            `LOCATION:${icsText(url)}`,
            `URL:${url}`,
            `ORGANIZER;CN=${icsText(poll.organizer)}:${host}`,
            'STATUS:CONFIRMED',
            'TRANSP:OPAQUE',
            'BEGIN:VALARM',
            'ACTION:DISPLAY',
            `DESCRIPTION:${icsText(poll.title)}`,
            'TRIGGER:-PT15M',
            'END:VALARM',
            'END:VEVENT',
        ];
    }

    // One event, for "Ajouter à mon agenda"
    eventFile(poll, host) {
        if (poll.status !== 'fixed' || !poll.fixed) return null;
        const lines = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//TLLM*meet//Rendez-vous//FR',
            'CALSCALE:GREGORIAN',
            'METHOD:PUBLISH',
            ...this.eventLines(poll, host),
            'END:VCALENDAR',
        ];
        return lines.map(icsFold).join('\r\n') + '\r\n';
    }
}

function hash(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function sameHash(a, b) {
    const x = Buffer.from(String(a), 'hex');
    const y = Buffer.from(String(b), 'hex');
    return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

module.exports = { DatePolls, DatePollError, zonedToUtc, icsFold, DURATIONS };
