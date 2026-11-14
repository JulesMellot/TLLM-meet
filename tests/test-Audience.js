'use strict';

require('should');

const { Audience, cleanLine, cleanText } = require('../app/src/Audience');

describe('test-Audience', () => {
    const ID = 'phone-0001';

    it('lets a phone in with the key of the meeting only', () => {
        const audience = new Audience();
        (audience.join('r1', 's1', { key: 'nope', name: 'Ana', clientId: ID }).error || '').should.match(/QR code/);
        const key = audience.key('r1');
        audience.key('r1').should.equal(key); // the same while the meeting lasts
        const { member } = audience.join('r1', 's1', { key, name: '  Ana  ', clientId: ID });
        member.name.should.equal('Ana');
        member.voterId.should.equal(`salle:${ID}`);
        audience.find('s1').roomId.should.equal('r1');
        audience.count('r1').should.equal(1);
    });

    it('asks for a name and a proper phone id', () => {
        const audience = new Audience();
        const key = audience.key('r1');
        audience.join('r1', 's1', { key, name: '   ', clientId: ID }).error.should.match(/prénom/);
        audience.join('r1', 's1', { key, name: 'Ana', clientId: '<x>' }).error.should.be.ok();
        audience.join('r1', 's1', { key, name: 'x'.repeat(80), clientId: ID }).member.name.length.should.equal(40);
    });

    it('counts a phone once, even with two tabs, and forgets who leaves', () => {
        const audience = new Audience();
        const key = audience.key('r1');
        audience.join('r1', 's1', { key, name: 'Ana', clientId: ID });
        audience.join('r1', 's2', { key, name: 'Ana', clientId: ID });
        audience.join('r1', 's3', { key, name: 'Bob', clientId: 'phone-0002' });
        audience.count('r1').should.equal(2);
        audience.leave('s3').should.equal('r1');
        audience.count('r1').should.equal(1);
        (audience.leave('s3') === null).should.be.true();
    });

    it('turns people away beyond the limit', () => {
        const audience = new Audience({ maxPerRoom: 1 });
        const key = audience.key('r1');
        audience.join('r1', 's1', { key, name: 'Ana', clientId: ID }).member.should.be.ok();
        audience.join('r1', 's2', { key, name: 'Bob', clientId: 'phone-0002' }).error.should.match(/Trop/);
    });

    it('ends with the meeting: the key no longer works', () => {
        const audience = new Audience();
        const key = audience.key('r1');
        audience.join('r1', 's1', { key, name: 'Ana', clientId: ID });
        audience.close('r1').should.eql(['s1']);
        (audience.find('s1') === null).should.be.true();
        audience.check('r1', key).should.be.false();
        audience.key('r1').should.not.equal(key);
    });

    it('takes known reactions, not too fast', () => {
        let now = 0;
        const audience = new Audience({ now: () => now });
        const key = audience.key('r1');
        const { member } = audience.join('r1', 's1', { key, name: 'Ana', clientId: ID });
        (audience.react(member, '💣') === null).should.be.true();
        now = 1000;
        audience.react(member, '👏').should.equal('👏');
        (audience.react(member, '👏') === null).should.be.true();
        now = 1800;
        audience.react(member, '🎉').should.equal('🎉');
    });

    it('takes a question every ten seconds, cleaned', () => {
        let now = 100000;
        const audience = new Audience({ now: () => now });
        const key = audience.key('r1');
        const { member } = audience.join('r1', 's1', { key, name: 'Ana', clientId: ID });
        audience.question(member, '   ').error.should.match(/vide/);
        audience.question(member, ' Et le budget ?\u0007\n\n\n\nMerci ').text.should.equal('Et le budget ? \n\nMerci');
        audience.question(member, 'Encore').error.should.match(/Attendez 10 s/);
        now += 10000;
        audience.question(member, 'Encore').text.should.equal('Encore');
        audience.question(member, 'x'.repeat(900)).should.have.property('error');
        now += 10000;
        audience.question(member, 'x'.repeat(900)).text.length.should.equal(500);
    });

    it('cleans one line of text', () => {
        cleanLine(' a\u0000b \n  c ', 10).should.equal('a b c');
        cleanLine(42, 10).should.equal('');
        cleanText(null, 10).should.equal('');
    });
});
