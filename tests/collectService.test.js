'use strict';

jest.mock('../src/models/EventBatch');
jest.mock('../src/models/Session');

const EventBatch = require('../src/models/EventBatch');
const Session = require('../src/models/Session');
const { ingest, attachUserId, BadRequestError } = require('../src/collectService');

function makeDto(overrides = {}) {
  return {
    tenantId: 'tenant_test001',
    appId: 'app_test001',
    deviceFingerprint: 'fp_abc123',
    events: [{ type: 'mousemove', sessionId: 'sess_1', t: 100 }],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  EventBatch.create = jest.fn().mockResolvedValue({});
  EventBatch.updateMany = jest.fn().mockResolvedValue({ modifiedCount: 0 });
  Session.findById = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
  Session.updateOne = jest.fn().mockResolvedValue({});
});

describe('ingest()', () => {
  test('rejects a batch over the configured max event count', async () => {
    // MAX_BATCH_EVENTS=500 in tests/setupEnv.js
    const events = Array.from({ length: 501 }, (_, i) => ({ type: 'mousemove', sessionId: 'sess_1', t: i }));
    await expect(ingest(makeDto({ events }), '1.2.3.4')).rejects.toThrow(BadRequestError);
    expect(EventBatch.create).not.toHaveBeenCalled();
  });

  test('rejects a batch where no event carries a sessionId', async () => {
    const events = [{ type: 'mousemove', t: 1 }, { type: 'mousemove', t: 2 }];
    await expect(ingest(makeDto({ events }), '1.2.3.4')).rejects.toThrow('no sessionId present on any event');
  });

  test('rejects a batch with inconsistent sessionIds', async () => {
    const events = [
      { type: 'mousemove', sessionId: 'sess_1', t: 1 },
      { type: 'mousemove', sessionId: 'sess_2', t: 2 },
    ];
    await expect(ingest(makeDto({ events }), '1.2.3.4')).rejects.toThrow('inconsistent sessionId within batch');
  });

  test('stores the batch with the derived sessionId and clientIp', async () => {
    await ingest(makeDto(), '9.9.9.9');

    expect(EventBatch.create).toHaveBeenCalledTimes(1);
    const arg = EventBatch.create.mock.calls[0][0];
    expect(arg.sessionId).toBe('sess_1');
    expect(arg.tenantId).toBe('tenant_test001');
    expect(arg.clientIp).toBe('9.9.9.9');
    expect(arg.eventCount).toBe(1);
    expect(arg.userId).toBeNull(); // no identify event in this batch
  });

  test('upserts the Session summary doc with $setOnInsert / $set / $inc', async () => {
    await ingest(makeDto(), null);

    expect(Session.updateOne).toHaveBeenCalledTimes(1);
    const [filter, update, opts] = Session.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: 'sess_1' });
    expect(update.$setOnInsert._id).toBe('sess_1');
    expect(update.$inc).toEqual({ batchCount: 1, eventCount: 1 });
    expect(opts).toEqual({ upsert: true });
  });

  test('extracts browserUserId from an identify event and calls attachUserId when the session is not already identified', async () => {
    const events = [
      { type: 'mousemove', sessionId: 'sess_1', t: 1 },
      { type: 'identify', sessionId: 'sess_1', userId: 'user_42', t: 2 },
    ];
    Session.findById = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });

    await ingest(makeDto({ events }), '1.2.3.4');

    // attachUserId itself calls Session.updateOne + EventBatch.updateMany —
    // once for the initial upsert, once more for the attach.
    expect(Session.updateOne).toHaveBeenCalledTimes(2);
    const attachCall = Session.updateOne.mock.calls[1];
    expect(attachCall[0]).toEqual({ _id: 'sess_1' });
    expect(attachCall[1].$set).toEqual({ userId: 'user_42', identifiedBy: 'browser' });
    expect(EventBatch.updateMany).toHaveBeenCalledWith({ sessionId: 'sess_1' }, { $set: { userId: 'user_42' } });
  });

  test('does NOT re-attach a browser-reported userId if the session already has one (server identify wins)', async () => {
    const events = [{ type: 'identify', sessionId: 'sess_1', userId: 'user_new', t: 1 }];
    Session.findById = jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({ userId: 'user_already_set' }),
    });

    await ingest(makeDto({ events }), '1.2.3.4');

    // Only the initial upsert — no second attachUserId-triggered updateOne.
    expect(Session.updateOne).toHaveBeenCalledTimes(1);
    expect(EventBatch.updateMany).not.toHaveBeenCalled();
  });

  test('ignores an identify event with no userId', async () => {
    const events = [{ type: 'identify', sessionId: 'sess_1', t: 1 }];
    await ingest(makeDto({ events }), '1.2.3.4');

    const arg = EventBatch.create.mock.calls[0][0];
    expect(arg.userId).toBeNull();
    expect(Session.updateOne).toHaveBeenCalledTimes(1); // no attach call
  });
});

describe('attachUserId()', () => {
  test('sets userId + identifiedBy on the Session and backfills every matching EventBatch', async () => {
    EventBatch.updateMany = jest.fn().mockResolvedValue({ modifiedCount: 3 });

    await attachUserId('sess_7', 'user_99', 'server');

    expect(Session.updateOne).toHaveBeenCalledWith(
      { _id: 'sess_7' },
      { $set: { userId: 'user_99', identifiedBy: 'server' } }
    );
    expect(EventBatch.updateMany).toHaveBeenCalledWith({ sessionId: 'sess_7' }, { $set: { userId: 'user_99' } });
  });
});
