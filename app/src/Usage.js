'use strict';

// TLLM*meet: what each meeting costs the server in CPU and memory, and the app's own figures in
// real time (admin home).
//
// Every 5 s the server reads its mediasoup transports (bytes in and out), its mediasoup workers
// (CPU time, memory) and its own Node process. Each meeting under way adds up its share:
// - its traffic, exactly (the bytes of its transports);
// - its CPU, estimated: a worker's CPU time is shared between the rooms it runs by their traffic,
//   the Node process's CPU time between all the meetings by their number of people;
// - its memory, estimated: what the app uses above its memory with no meeting, shared by people;
// - the speech-to-text time of its transcription, as the transcription server reports it.
// When a meeting ends, one line goes to DATA_DIR/usage.jsonl.
//
// The live figures compare the app (Node + mediasoup workers) with the whole server (os module).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { monitorEventLoopDelay } = require('perf_hooks');

const SAMPLE_MS = 5000;
const HISTORY = 60; // live points kept: 5 minutes
const MAX_RECORDS = 2000; // meetings kept in memory and in the file

// Resident memory of another process of this machine (the mediasoup workers), in bytes
function processRss(pid) {
    try {
        const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
        const kb = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
        return kb ? Number(kb[1]) * 1024 : null;
    } catch {
        return null; // not Linux, or the process is gone
    }
}

function hostCpuTimes() {
    let busy = 0;
    let total = 0;
    for (const { times } of os.cpus()) {
        const all = times.user + times.nice + times.sys + times.irq + times.idle;
        total += all;
        busy += all - times.idle;
    }
    return { busy, total };
}

class Usage {
    constructor({
        file,
        now = () => Date.now(),
        log = console,
        hostCpus = os.cpus().length || 1,
        describe = () => ({}),
    } = {}) {
        this.file = file;
        this.now = now;
        this.log = log;
        this.hostCpus = Math.max(1, hostCpus);
        this.describe = describe; // room id -> { name, owner }
        this.live = new Map(); // room id -> meeting under way
        this.records = []; // finished meetings, oldest first
        this.history = []; // live points
        this.last = null; // the last live figures
        this.prev = { at: null, workers: new Map(), nodeCpuMs: null, host: null };
        this.idleMemory = null; // the app's memory at the last sample without any meeting
        this.loopDelay = null;
        this.timer = null;
        this.load();
    }

    // ---------- finished meetings ----------

    load() {
        if (!this.file) return;
        let raw = '';
        try {
            raw = fs.readFileSync(this.file, 'utf8');
        } catch (err) {
            if (err.code !== 'ENOENT') this.log.error('Usage: cannot read the data file', { error: err.message });
            return;
        }
        for (const line of raw.split('\n')) {
            if (!line.trim()) continue;
            try {
                const record = JSON.parse(line);
                if (record?.room && record.startedAt) this.records.push(record);
            } catch {
                /* a line cut by a crash */
            }
        }
        this.records = this.records.slice(-MAX_RECORDS);
    }

    write(record) {
        if (!this.file) return;
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.appendFileSync(this.file, JSON.stringify(record) + '\n');
            this.lines = (this.lines ?? this.records.length) + 1;
            if (this.lines > MAX_RECORDS * 2) {
                // Keep the file as long as the list in memory
                const tmp = `${this.file}.${process.pid}.tmp`;
                fs.writeFileSync(tmp, this.records.map((r) => JSON.stringify(r)).join('\n') + '\n');
                fs.renameSync(tmp, this.file);
                this.lines = this.records.length;
            }
        } catch (err) {
            this.log.error('Usage: cannot write the data file (is DATA_DIR writable?)', { error: err.message });
        }
    }

    // ---------- meetings under way ----------

    open(roomId) {
        if (this.live.has(roomId)) return this.live.get(roomId);
        const { name, owner } = this.describe(roomId) || {};
        const meeting = {
            room: roomId,
            name: name || roomId,
            owner: owner || null,
            startedAt: this.now(),
            peers: 0,
            peakPeers: 0,
            peerMs: 0,
            bytesIn: 0,
            bytesOut: 0,
            cpuMs: 0,
            cpuPeak: 0, // largest share of the processor over one sample
            memByteMs: 0, // memory x time, for the average
            memMs: 0,
            memPeak: 0,
            asrMs: 0,
            asrAudioMs: 0,
            asrRequests: 0,
            transports: new Map(), // transport id -> { in, out } at the last sample
        };
        this.live.set(roomId, meeting);
        return meeting;
    }

    close(roomId) {
        const meeting = this.live.get(roomId);
        if (!meeting) return null;
        this.live.delete(roomId);
        const { name, owner } = this.describe(roomId) || {};
        const record = this.summary({ ...meeting, name: name || meeting.name, owner: owner || meeting.owner });
        record.endedAt = this.now();
        record.durationMs = record.endedAt - record.startedAt;
        delete record.live;
        delete record.peers;
        this.records.push(record);
        if (this.records.length > MAX_RECORDS) this.records.splice(0, this.records.length - MAX_RECORDS);
        this.write(record);
        return record;
    }

    // Someone came in: a meeting shorter than one sample still counts its people
    joined(roomId, peers) {
        const meeting = this.open(roomId);
        meeting.peakPeers = Math.max(meeting.peakPeers, peers || 0);
    }

    // Speech-to-text work done for a meeting. ms: computing time reported by the server
    asr(roomId, { ms = 0, audioMs = 0 } = {}) {
        const meeting = this.live.get(roomId);
        if (!meeting) return;
        meeting.asrRequests++;
        if (Number.isFinite(ms) && ms > 0) meeting.asrMs += ms;
        if (Number.isFinite(audioMs) && audioMs > 0) meeting.asrAudioMs += audioMs;
    }

    summary(meeting) {
        const { transports, memByteMs, memMs, ...rest } = meeting;
        const durationMs = (meeting.endedAt || this.now()) - meeting.startedAt;
        return {
            ...rest,
            live: !meeting.endedAt,
            durationMs,
            cpuMs: Math.round(meeting.cpuMs),
            // Average share of the server's processor while the meeting lasted
            cpuShare: durationMs > 0 ? meeting.cpuMs / (durationMs * this.hostCpus) : 0,
            memAvg: memMs > 0 ? Math.round(memByteMs / memMs) : 0,
            memPeak: Math.round(meeting.memPeak),
        };
    }

    // The meetings under way, then the finished ones started since `since`, newest first.
    // owner null: every organiser's meetings (admin)
    list({ owner = null, since = 0 } = {}) {
        const keep = (m) => (owner === null || m.owner === owner) && m.startedAt >= since;
        const live = Array.from(this.live.values())
            .filter((m) => owner === null || m.owner === owner)
            .map((m) => this.summary(m))
            .sort((a, b) => b.startedAt - a.startedAt);
        const done = this.records
            .filter(keep)
            .reverse()
            .map((r) => ({ ...r, live: false }));
        return [...live, ...done];
    }

    // ---------- accounting ----------

    // One sample. rooms: [{ id, peers, worker: pid, transports: [{ id, in, out }] }] (cumulative bytes);
    // workers: [{ pid, cpuMs }] and nodeCpuMs: cumulative CPU times. Returns what this interval used.
    // appMemory: what the app (Node + workers) uses now, in bytes.
    account({ at = this.now(), rooms = [], workers = [], nodeCpuMs = null, appMemory = null }) {
        const intervalMs = this.prev.at === null ? 0 : Math.max(0, at - this.prev.at);
        const usage = { intervalMs, bytesIn: 0, bytesOut: 0, appCpuMs: 0 };
        const cpuBefore = new Map(rooms.map((r) => [r.id, this.live.get(r.id)?.cpuMs || 0]));

        // Traffic of each meeting, from its transports
        const traffic = new Map(); // room id -> bytes this interval
        for (const room of rooms) {
            const meeting = this.open(room.id);
            const seen = new Map();
            let bytesIn = 0;
            let bytesOut = 0;
            for (const t of room.transports) {
                const before = meeting.transports.get(t.id) || { in: 0, out: 0 };
                bytesIn += Math.max(0, t.in - before.in);
                bytesOut += Math.max(0, t.out - before.out);
                seen.set(t.id, { in: t.in, out: t.out });
            }
            meeting.transports = seen;
            meeting.bytesIn += bytesIn;
            meeting.bytesOut += bytesOut;
            meeting.peers = room.peers;
            meeting.peakPeers = Math.max(meeting.peakPeers, room.peers);
            meeting.peerMs += room.peers * intervalMs;
            usage.bytesIn += bytesIn;
            usage.bytesOut += bytesOut;
            traffic.set(room.id, bytesIn + bytesOut);
        }

        // CPU of each worker since the last sample, shared between its rooms by their traffic
        // (by their number of people when nothing flowed)
        for (const w of workers) {
            const before = this.prev.workers.get(w.pid);
            this.prev.workers.set(w.pid, w.cpuMs);
            if (before === undefined) continue;
            const spent = Math.max(0, w.cpuMs - before);
            usage.appCpuMs += spent;
            const mine = rooms.filter((r) => r.worker === w.pid);
            this.share(spent, mine, (r) => traffic.get(r.id) || 0);
        }

        // Node's CPU: signalling, notes, whiteboard, transcription relay. Shared by number of people
        if (nodeCpuMs !== null) {
            if (this.prev.nodeCpuMs !== null) {
                const spent = Math.max(0, nodeCpuMs - this.prev.nodeCpuMs);
                usage.appCpuMs += spent;
                this.share(spent, rooms, () => 0);
            }
            this.prev.nodeCpuMs = nodeCpuMs;
        }

        // Peak CPU of each meeting over this interval
        if (intervalMs) {
            for (const r of rooms) {
                const meeting = this.live.get(r.id);
                const share = (meeting.cpuMs - cpuBefore.get(r.id)) / (intervalMs * this.hostCpus);
                meeting.cpuPeak = Math.max(meeting.cpuPeak, share);
            }
        }

        // Memory: what the app uses above its memory with no meeting, shared by number of people
        if (appMemory !== null) {
            if (!rooms.length) this.idleMemory = appMemory;
            else if (this.idleMemory !== null && intervalMs) {
                const extra = Math.max(0, appMemory - this.idleMemory);
                const people = rooms.reduce((total, r) => total + (r.peers || 0), 0);
                for (const r of rooms) {
                    const meeting = this.live.get(r.id);
                    const mine = people ? (extra * (r.peers || 0)) / people : extra / rooms.length;
                    meeting.memByteMs += mine * intervalMs;
                    meeting.memMs += intervalMs;
                    meeting.memPeak = Math.max(meeting.memPeak, mine);
                }
            }
        }

        this.prev.at = at;
        return usage;
    }

    share(spent, rooms, weightOf) {
        if (!spent || !rooms.length) return;
        let weights = rooms.map(weightOf);
        if (!weights.some((w) => w > 0)) weights = rooms.map((r) => r.peers || 0);
        if (!weights.some((w) => w > 0)) weights = rooms.map(() => 1);
        const total = weights.reduce((a, b) => a + b, 0);
        rooms.forEach((r, i) => {
            const meeting = this.live.get(r.id);
            if (meeting) meeting.cpuMs += (spent * weights[i]) / total;
        });
    }

    // ---------- live figures ----------

    start(getRooms, getWorkers) {
        try {
            this.loopDelay = monitorEventLoopDelay({ resolution: 20 });
            this.loopDelay.enable();
        } catch {
            this.loopDelay = null;
        }
        const run = () =>
            this.collect(getRooms(), getWorkers()).catch((err) =>
                this.log.debug('Usage: sample failed', { error: err.message })
            );
        run();
        this.timer = setInterval(run, SAMPLE_MS);
        this.timer.unref?.();
    }

    stop() {
        clearInterval(this.timer);
        this.loopDelay?.disable();
    }

    // Reads the mediasoup objects (Room.js, Peer.js) and the process, then accounts for the interval
    async collect(roomList, workers) {
        const at = this.now();
        const counts = { rooms: 0, peers: 0, transports: 0, producers: 0, consumers: 0 };
        const rooms = await Promise.all(
            Array.from(roomList.values()).map(async (room) => {
                const stats = [];
                counts.rooms++;
                counts.peers += room.peers.size;
                for (const peer of room.peers.values()) {
                    counts.producers += peer.producers?.size || 0;
                    counts.consumers += peer.consumers?.size || 0;
                    for (const t of peer.transports?.values() || []) {
                        counts.transports++;
                        stats.push(
                            t
                                .getStats()
                                .then(([s]) => s && { id: t.id, in: s.bytesReceived || 0, out: s.bytesSent || 0 })
                                .catch(() => null)
                        );
                    }
                }
                const transports = (await Promise.all(stats)).filter(Boolean);
                return { id: room.id, peers: room.peers.size, worker: room.worker?.pid, transports };
            })
        );
        const ws = (
            await Promise.all(
                workers.map((w) =>
                    w
                        .getResourceUsage()
                        .then((u) => ({ pid: w.pid, cpuMs: u.ru_utime + u.ru_stime }))
                        .catch(() => null)
                )
            )
        ).filter(Boolean);
        const cpu = process.cpuUsage();
        const nodeRss = process.memoryUsage().rss;
        const workersRss = workers.reduce((total, w) => total + (processRss(w.pid) || 0), 0);
        const usage = this.account({
            at,
            rooms,
            workers: ws,
            nodeCpuMs: (cpu.user + cpu.system) / 1000,
            appMemory: nodeRss + workersRss,
        });

        // The whole machine, for comparison
        const host = hostCpuTimes();
        const before = this.prev.host;
        this.prev.host = host;
        const hostCpu =
            before && host.total > before.total ? (host.busy - before.busy) / (host.total - before.total) : null;

        const seconds = usage.intervalMs / 1000;
        const constrained = typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : 0;
        const lag = this.loopDelay;

        this.last = {
            at,
            app: {
                cpu: usage.intervalMs ? usage.appCpuMs / (usage.intervalMs * this.hostCpus) : null,
                memory: { node: nodeRss, workers: workersRss, total: nodeRss + workersRss },
                bitrateIn: seconds ? (usage.bytesIn * 8) / seconds : null,
                bitrateOut: seconds ? (usage.bytesOut * 8) / seconds : null,
                ...counts,
                workers: workers.length,
                lagMs: lag ? lag.percentile(99) / 1e6 : null,
                uptimeMs: Math.round(process.uptime() * 1000),
            },
            server: {
                cpu: hostCpu,
                cpus: this.hostCpus,
                load: os.loadavg(),
                memory: {
                    used: os.totalmem() - os.freemem(),
                    total: os.totalmem(),
                    limit: constrained > 0 && constrained < os.totalmem() ? constrained : null,
                },
            },
        };
        lag?.reset();

        if (usage.intervalMs) {
            this.history.push({
                t: at,
                appCpu: this.last.app.cpu,
                serverCpu: hostCpu,
                appMem: this.last.app.memory.total,
                serverMem: this.last.server.memory.used,
                bitrateIn: this.last.app.bitrateIn,
                bitrateOut: this.last.app.bitrateOut,
                peers: counts.peers,
            });
            if (this.history.length > HISTORY) this.history.shift();
        }
        return this.last;
    }

    snapshot() {
        return {
            sampleMs: SAMPLE_MS,
            ...(this.last || { at: this.now(), app: null, server: null }),
            history: this.history,
        };
    }
}

module.exports = { Usage, SAMPLE_MS };
