'use strict';

// TLLM*meet: the agenda of a meeting, with a timer per point.
//
// A presenter writes the points (a title, minutes planned), then moves from one to the next. Everyone
// sees the point under way and the time left (in the meeting and on the projector, TllmAgenda.js);
// each move is written in the transcription (Transcripts.js, 'section' marks) and the meeting log.
// Kept in memory for the time of the meeting, like the polls.

const MAX_ITEMS = 30;
const TITLE_MAX = 120;
const MAX_MINUTES = 600;

// [{ title, minutes }] -> clean list, or null when it is not a list
function cleanItems(items) {
    if (!Array.isArray(items)) return null;
    return items
        .slice(0, MAX_ITEMS)
        .map((item) => {
            // eslint-disable-next-line no-control-regex
            const title = String(item?.title ?? '')
                .replace(/[\u0000-\u001f\u007f]+/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, TITLE_MAX);
            const minutes = Math.round(Number(item?.minutes));
            return {
                title,
                minutes: Number.isFinite(minutes) ? Math.min(MAX_MINUTES, Math.max(0, minutes)) : 0,
            };
        })
        .filter((item) => item.title);
}

class Agenda {
    // load(roomId): the agenda prepared for the room, read when its meeting starts (RoomRegistry);
    // save(roomId, items): called when presenters change the points, so the room keeps them
    constructor({ now = () => Date.now(), load = () => [], save = () => {} } = {}) {
        this.now = now;
        this.load = load;
        this.store = save;
        this.rooms = new Map(); // room id -> { items, current, since, spent, finished }
    }

    state(roomId) {
        let a = this.rooms.get(roomId);
        if (!a) {
            const items = cleanItems(this.load(roomId)) || [];
            a = { items, current: -1, since: null, spent: items.map(() => 0), finished: false };
            this.rooms.set(roomId, a);
        }
        return a;
    }

    // What everybody sees. elapsedMs: time spent on the point under way, so that the countdown does
    // not depend on each person's clock
    view(roomId) {
        const a = this.state(roomId);
        return {
            items: a.items.map((i) => ({ ...i })),
            current: a.current,
            elapsedMs: a.current >= 0 && a.since ? this.now() - a.since : 0,
            spent: [...a.spent],
            finished: a.finished,
        };
    }

    // New list of points. The point under way keeps its time when it is still there (same title).
    set(roomId, items) {
        const clean = cleanItems(items);
        if (!clean) return false;
        const a = this.state(roomId);
        const running = a.current >= 0 ? a.items[a.current] : null;
        const spentByTitle = new Map(a.items.map((item, i) => [item.title, a.spent[i] || 0]));
        a.items = clean;
        a.spent = clean.map((item) => spentByTitle.get(item.title) || 0);
        if (running) {
            const index = clean.findIndex((item) => item.title === running.title);
            if (index >= 0) a.current = index;
            else {
                a.current = -1;
                a.since = null;
            }
        }
        this.store(
            roomId,
            clean.map((item) => ({ ...item }))
        );
        return true;
    }

    // Move to a point (start, next, back, or any). -> { from, to } (points), or null when nothing moves
    go(roomId, index) {
        const a = this.state(roomId);
        if (!a || !Number.isInteger(index) || index < 0 || index >= a.items.length || index === a.current) return null;
        const now = this.now();
        const from = a.current;
        if (from >= 0 && a.since) a.spent[from] = (a.spent[from] || 0) + (now - a.since);
        a.current = index;
        a.since = now;
        a.finished = false;
        return { from: from >= 0 ? a.items[from] : null, to: { index, ...a.items[index] } };
    }

    // The meeting is over (the agenda stays, for a look back). -> the point that was under way
    finish(roomId) {
        const a = this.state(roomId);
        if (!a || a.current < 0) return null;
        const last = a.items[a.current];
        if (a.since) a.spent[a.current] = (a.spent[a.current] || 0) + (this.now() - a.since);
        a.current = -1;
        a.since = null;
        a.finished = true;
        return last;
    }

    current(roomId) {
        const a = this.rooms.get(roomId);
        return a && a.current >= 0 ? { index: a.current, ...a.items[a.current] } : null;
    }

    close(roomId) {
        this.rooms.delete(roomId);
    }
}

// "Point 2/5 : Budget"
function pointLabel(index, total, title) {
    return `Point ${index + 1}/${total} : ${title}`;
}

module.exports = { Agenda, cleanItems, pointLabel, MAX_ITEMS };
