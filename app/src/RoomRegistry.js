'use strict';

// TLLM*meet: the rooms the organiser has opened, with the name typed when creating them
// (room ids lose accents and get a random suffix) and when they were last used. It feeds the
// organiser's home ("Salles") and the door page guests see before entering.
// Kept in DATA_DIR/salles.json next to the date polls.

const fs = require('fs');
const path = require('path');

const MAX_ROOMS = 500;

// "point-mensuel-k7m2xq" -> "Point mensuel", for rooms the registry does not know
function nameFromId(id) {
    const base = String(id || '')
        .replace(/-[a-hj-km-np-z2-9]{6}$/, '')
        .replace(/[-_]+/g, ' ')
        .trim();
    return base ? base.charAt(0).toUpperCase() + base.slice(1) : 'Visio';
}

class RoomRegistry {
    constructor({ file, now = () => Date.now(), log = console } = {}) {
        this.file = file;
        this.now = now;
        this.log = log;
        this.rooms = new Map(); // id -> { id, name, owner, createdAt, lastOpenedAt, lastClosedAt }
        this.live = new Map(); // id -> opened at (this process only)
        this.saveTimer = null;
        this.load();
    }

    load() {
        if (!this.file) return;
        try {
            const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            for (const room of data.rooms || []) if (room?.id) this.rooms.set(room.id, room);
        } catch (err) {
            if (err.code !== 'ENOENT') this.log.error('Rooms: cannot read the data file', { error: err.message });
        }
    }

    save() {
        if (!this.file) return;
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.saveNow(), 500);
        this.saveTimer.unref?.();
    }

    saveNow() {
        if (!this.file) return;
        clearTimeout(this.saveTimer);
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            const tmp = `${this.file}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({ version: 1, rooms: Array.from(this.rooms.values()) }));
            fs.renameSync(tmp, this.file);
        } catch (err) {
            this.log.error('Rooms: cannot write the data file (is DATA_DIR writable?)', { error: err.message });
        }
    }

    // A room created by the organiser (typed name) or reserved by a date poll (its title)
    remember(id, { name, owner } = {}) {
        if (!id) return null;
        const now = this.now();
        const room = this.rooms.get(id) || { id, createdAt: now, lastOpenedAt: null, lastClosedAt: null };
        if (typeof name === 'string' && name.trim()) room.name = name.trim().slice(0, 120);
        if (owner) room.owner = owner;
        this.rooms.set(id, room);
        this.trim();
        this.save();
        return room;
    }

    trim() {
        if (this.rooms.size <= MAX_ROOMS) return;
        const oldest = Array.from(this.rooms.values()).sort((a, b) => this.lastUse(a) - this.lastUse(b));
        for (const room of oldest.slice(0, this.rooms.size - MAX_ROOMS)) this.rooms.delete(room.id);
    }

    lastUse(room) {
        return Math.max(room.lastOpenedAt || 0, room.lastClosedAt || 0, room.createdAt || 0);
    }

    opened(id) {
        const now = this.now();
        this.live.set(id, now);
        const room = this.rooms.get(id);
        if (room) {
            room.lastOpenedAt = now;
            this.save();
        }
    }

    closed(id) {
        this.live.delete(id);
        const room = this.rooms.get(id);
        if (room) {
            room.lastClosedAt = this.now();
            this.save();
        }
    }

    since(id) {
        return this.live.get(id) || null;
    }

    get(id) {
        return this.rooms.get(id) || null;
    }

    name(id) {
        return this.rooms.get(id)?.name || nameFromId(id);
    }

    // owner null: every organiser's rooms (admin view). limit 0: all of them
    recent(owner, limit = 12) {
        return Array.from(this.rooms.values())
            .filter((r) => owner === null || r.owner === owner)
            .sort((a, b) => this.lastUse(b) - this.lastUse(a))
            .slice(0, limit || undefined);
    }
}

module.exports = { RoomRegistry, nameFromId };
