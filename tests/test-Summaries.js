'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Summaries } = require('../app/src/Summaries');
const { Transcripts } = require('../app/src/Transcripts');

// A stand-in for the Claude Code CLI: records how it was called, answers with `reply`
function fakeSpawn(calls, { reply = '# Point hebdo\n\n## En bref\nTout va bien.\n', code = 0, stderr = '' } = {}) {
    return (bin, args, opts) => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        let input = '';
        child.stdin = {
            on() {},
            end(text) {
                input = text;
                calls.push({ bin, args, opts, input });
                setImmediate(() => {
                    if (code === 0) child.stdout.emit('data', reply);
                    else child.stderr.emit('data', stderr);
                    child.emit('close', code);
                });
            },
        };
        child.kill = () => {};
        return child;
    };
}

describe('test-Summaries (compte rendu par Claude)', () => {
    let dir;
    const jules = { username: 'jules', role: 'admin' };

    beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tllm-summaries-'))));
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('is off without a token or without SUMMARY_USERS', () => {
        assert.ok(!new Summaries({ dir, users: 'jules' }).allowed(jules));
        assert.ok(!new Summaries({ dir, token: 'tok' }).allowed(jules));
        assert.ok(new Summaries({ dir, token: 'tok', users: 'jules' }).allowed(jules));
    });

    it('is reserved to the listed admin accounts', () => {
        const s = new Summaries({ dir, token: 'tok', users: ' jules , ' });
        assert.ok(s.allowed(jules));
        assert.ok(!s.allowed({ username: 'marie', role: 'admin' }));
        assert.ok(!s.allowed({ username: 'jules', role: 'moderator' })); // a moderator account with the same name
        assert.ok(!s.allowed(null));
    });

    it('sends the transcription to the CLI with no tools and only the token in its environment', async () => {
        const calls = [];
        process.env.SOME_SERVER_SECRET = 'nope';
        const s = new Summaries({ dir, token: 'tok', users: 'jules', spawnFn: fakeSpawn(calls) });
        assert.equal(s.state('salle-k7m2xq', '1760000000000'), 'none');
        const p = s.generate('salle-k7m2xq', '1760000000000', '[00:00:12] Jules : On commence ?\n');
        assert.equal(s.state('salle-k7m2xq', '1760000000000'), 'running');
        await p;
        delete process.env.SOME_SERVER_SECRET;

        const [call] = calls;
        assert.equal(call.bin, 'claude');
        assert.deepEqual(call.args.slice(call.args.indexOf('--tools'), call.args.indexOf('--tools') + 2), [
            '--tools',
            '',
        ]);
        assert.ok(call.args.includes('-p'));
        assert.equal(call.opts.env.CLAUDE_CODE_OAUTH_TOKEN, 'tok');
        assert.equal(call.opts.env.SOME_SERVER_SECRET, undefined);
        assert.match(call.input, /<transcription>\n\[00:00:12\] Jules : On commence \?\n<\/transcription>/);

        assert.equal(s.state('salle-k7m2xq', '1760000000000'), 'ready');
        assert.match(s.read('salle-k7m2xq', '1760000000000'), /^# Point hebdo/);
    });

    it('reports a failure and allows a new attempt', async () => {
        const calls = [];
        const s = new Summaries({
            dir,
            token: 'tok',
            users: 'jules',
            log: { error() {} },
            spawnFn: fakeSpawn(calls, { code: 1, stderr: 'Invalid API key' }),
        });
        await assert.rejects(s.generate('salle-k7m2xq', '1760000000000', 'x'), /Invalid API key/);
        assert.equal(s.state('salle-k7m2xq', '1760000000000'), 'failed');
        assert.ok(!s.has('salle-k7m2xq', '1760000000000'));
    });

    it('is deleted with its transcription', async () => {
        const now = Date.now();
        const t = new Transcripts({ dir, now: () => now, log: { error() {} } });
        const session = t.start('salle-k7m2xq', { name: 'Point' });
        t.add(t.begin('salle-k7m2xq'), { name: 'Jules', text: 'Bonjour', at: now });
        t.close('salle-k7m2xq');
        t.live.delete('salle-k7m2xq');
        const s = new Summaries({ dir, token: 'tok', users: 'jules', spawnFn: fakeSpawn([]) });
        await s.generate('salle-k7m2xq', session.id, 'x');
        assert.ok(s.has('salle-k7m2xq', session.id));
        assert.ok(t.remove('salle-k7m2xq', session.id));
        assert.ok(!s.has('salle-k7m2xq', session.id));
    });

    it('is purged with its transcription after the retention period', async () => {
        let now = Date.UTC(2026, 0, 1);
        const t = new Transcripts({ dir, now: () => now, retentionDays: 30, log: { error() {} } });
        const session = t.start('salle-k7m2xq');
        t.close('salle-k7m2xq');
        const s = new Summaries({ dir, token: 'tok', users: 'jules', spawnFn: fakeSpawn([]) });
        await s.generate('salle-k7m2xq', session.id, 'x');
        now += 31 * 86400000;
        assert.equal(t.purge(), 2);
        assert.deepEqual(fs.readdirSync(dir), []);
    });
});
