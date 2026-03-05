import { expect } from 'chai';

import ShipError from './ship';

describe('ShipError', () => {
    it('should create an error with message only', () => {
        const err = new ShipError('something failed');
        expect(err).to.be.instanceOf(Error);
        expect(err.message).to.include('something failed');
        expect(err.cause).to.equal(undefined);
    });

    it('should include previous error in message', () => {
        const prev = new Error('pg connection lost');
        const err = new ShipError('Ship processing failed', prev);
        expect(err.message).to.include('Ship processing failed');
        expect(err.message).to.include('pg connection lost');
    });

    it('should preserve previous error as cause', () => {
        const prev = new Error('deadlock detected');
        const err = new ShipError('block processing failed', prev);
        expect(err.cause).to.equal(prev);
    });

    it('should preserve PG error code through cause chain', () => {
        const pgError = Object.assign(new Error('deadlock detected'), { code: '40P01' });
        const shipErr = new ShipError('block processing failed', pgError);

        // The cause chain preserves the original error with its code
        expect(shipErr.cause).to.equal(pgError);
        expect((shipErr.cause as any).code).to.equal('40P01');
    });

    it('should include previous error stack in its own stack', () => {
        const prev = new Error('original');
        const err = new ShipError('wrapped', prev);
        expect(err.stack).to.include('original');
    });

    it('should handle undefined previousError', () => {
        const err = new ShipError('no cause');
        expect(err.cause).to.equal(undefined);
        expect(err.stack).to.be.a('string');
    });
});
