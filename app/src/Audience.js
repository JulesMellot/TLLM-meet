'use strict';

// TLLM*meet: the people in the meeting room, with their phone, who did not join the video call.
//
// The projector window (public/js/TllmProjection.js) shows a QR code: /salle/<room>#<key>. The key is
// drawn by the server for this meeting only (it changes when the meeting ends): seeing the projector
// is what lets someone in. With it, a phone can vote in the polls, send a reaction and ask a question,
// and nothing else: no picture, no sound, no chat, no list of participants.
//
// A phone keeps the same id (drawn by its page) across network cuts: its vote is not counted twice.

const crypto = require('crypto');

const MAX_PER_ROOM = 300;
const NAME_MAX = 40;
const QUESTION_MAX = 500;
const REACT_EVERY_MS = 700;
const QUESTION_EVERY_MS = 10000;
const REACTIONS = ['👏', '👍', '❤️', '😂', '😮', '🎉'];
const CLIENT_ID = /^[a-z0-9-]{8,64}$/i;

// One line of text: no control characters, spaces collapsed
function cleanLine(value, max) {
    if (typeof value !== 'string') return '';
    // eslint-disable-next-line no-control-regex
    return value
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

// Several lines allowed (a question), control characters removed
function cleanText(value, max) {
    if (typeof value !== 'string') return '';
    return (
        value
            // eslint-disable-next-line no-control-regex
            .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
            .slice(0, max)
    );
}

class Audience {
    constructor({ maxPerRoom = MAX_PER_ROOM, now = () => Date.now() } = {}) {
        this.rooms = new Map(); // room id -> { key, members: Map(socket id -> member) }
        this.bySocket = new Map(); // socket id -> room id
        this.maxPerRoom = maxPerRoom;
        this.now = now;
    }

    // The key of the meeting, drawn the first time it is asked for
    key(roomId) {
        let room = this.rooms.get(roomId);
        if (!room) {
            room = { key: crypto.randomBytes(12).toString('base64url'), members: new Map() };
            this.rooms.set(roomId, room);
        }
        return room.key;
    }

    check(roomId, key) {
        const room = this.rooms.get(roomId);
        if (!room || typeof key !== 'string') return false;
        const a = Buffer.from(room.key);
        const b = Buffer.from(key);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    }

    // -> { member } or { error }
    join(roomId, socketId, { key, name, clientId } = {}) {
        if (!this.check(roomId, key))
            return { error: 'Ce lien ne marche plus : scannez le QR code affiché dans la salle.' };
        const room = this.rooms.get(roomId);
        const cleanName = cleanLine(name, NAME_MAX);
        if (!cleanName) return { error: 'Indiquez votre prénom.' };
        if (typeof clientId !== 'string' || !CLIENT_ID.test(clientId)) return { error: 'Page à recharger.' };
        if (!room.members.has(socketId) && room.members.size >= this.maxPerRoom)
            return { error: 'Trop de monde connecté depuis la salle.' };
        this.leave(socketId);
        const member = { name: cleanName, clientId, voterId: `salle:${clientId}`, lastReact: 0, lastQuestion: 0 };
        room.members.set(socketId, member);
        this.bySocket.set(socketId, roomId);
        return { member };
    }

    // -> { roomId, member } or null
    find(socketId) {
        const roomId = this.bySocket.get(socketId);
        const member = roomId ? this.rooms.get(roomId)?.members.get(socketId) : null;
        return member ? { roomId, member } : null;
    }

    leave(socketId) {
        const roomId = this.bySocket.get(socketId);
        if (!roomId) return null;
        this.bySocket.delete(socketId);
        this.rooms.get(roomId)?.members.delete(socketId);
        return roomId;
    }

    // People connected from the room (one per phone, even with two tabs)
    count(roomId) {
        const members = this.rooms.get(roomId)?.members;
        return members ? new Set([...members.values()].map((m) => m.clientId)).size : 0;
    }

    sockets(roomId) {
        return [...(this.rooms.get(roomId)?.members.keys() || [])];
    }

    // The meeting ended: the key no longer works; returns the sockets to tell
    close(roomId) {
        const sockets = this.sockets(roomId);
        sockets.forEach((id) => this.bySocket.delete(id));
        this.rooms.delete(roomId);
        return sockets;
    }

    // -> emoji to send, or null (unknown, or too soon after the previous one)
    react(member, emoji) {
        if (!REACTIONS.includes(emoji)) return null;
        const now = this.now();
        if (now - member.lastReact < REACT_EVERY_MS) return null;
        member.lastReact = now;
        return emoji;
    }

    // -> { text } or { error }
    question(member, text) {
        const clean = cleanText(text, QUESTION_MAX);
        if (!clean) return { error: 'La question est vide.' };
        const now = this.now();
        const wait = QUESTION_EVERY_MS - (now - member.lastQuestion);
        if (wait > 0) return { error: `Attendez ${Math.ceil(wait / 1000)} s avant la question suivante.` };
        member.lastQuestion = now;
        return { text: clean };
    }
}

module.exports = { Audience, REACTIONS, cleanLine, cleanText };
