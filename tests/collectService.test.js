'use strict';

jest.mock('../src/models/EventStores');
jest.mock('../src/models/Session');

const { LoginEvent, SessionEvent, PaymentEvent } = require('../src/models/EventStores');
const Session = require('../src/models/Session');
const { ingest, attachUserId, splitEvents, BadRequestError } = require('../src/collectService');

function makeDto(overrides = {}) {
  return {
    tenantId: 'tenant_test001',
    appId: 'app_test001',
    deviceFingerprint: 'fp_abc123',
    events: [{ type: 'mousemove', sessionId: 'sess_1', t: 100 }],
    ...overrides,
  };
}

function mockExistingSession(doc) {
  Session.findById = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(doc) });
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const M of [LoginEvent, SessionEvent, PaymentEvent]) {
    M.create = jest.fn().mockResolvedValue({});
    M.updateMany = jest.fn().mockResolvedValue({ modifiedCount: 0 });
  }
  mockExistingSession(null);
  Session.updateOne = jest.fn().mockResolvedValue({});
});

describe('ingest() validation', () => {
  test('rejects a batch over the configured max event count', async () => {
    const events = Array.from({ length: 501 }, (_, i) => ({ type: 'mousemove', sessionId: 'sess_1', t: i }));
    await expect(ingest(makeDto({ events }), '1.2.3.4')).rejects.toThrow(BadRequestError);
    expect(LoginEvent.create).not.toHaveBeenCalled();
  });

  test('rejects a batch where no event carries a sessionId', async () => {
    const events = [{ type: 'mousemove', t: 1 }];
    await expect(ingest(makeDto({ events }), '1.2.3.4')).rejects.toThrow('no sessionId present on any event');
  });

  test('rejects a batch with inconsistent sessionIds', async () => {
    const events = [
      { type: 'mousemove', sessionId: 'sess_1', t: 1 },
      { type: 'mousemove', sessionId: 'sess_2', t: 2 },
    ];
    await expect(ingest(makeDto({ events }), '1.2.3.4')).rejects.toThrow('inconsistent sessionId within batch');
  });
});

describe('ingest() routing', () => {
  test('new session: events go to login_events', async () => {
    await ingest(makeDto(), '9.9.9.9');
    expect(LoginEvent.create).toHaveBeenCalledTimes(1);
    const arg = LoginEvent.create.mock.calls[0][0];
    expect(arg.sessionId).toBe('sess_1');
    expect(arg.clientIp).toBe('9.9.9.9');
    expect(arg.userId).toBeNull();
    expect(SessionEvent.create).not.toHaveBeenCalled();
    expect(PaymentEvent.create).not.toHaveBeenCalled();
  });

  test('batch crossing login: pre-login + identify → login_events, rest → session_events', async () => {
    const events = [
      { type: 'keydown', sessionId: 'sess_1', t: 1 },
      { type: 'identify', sessionId: 'sess_1', userId: 'user_42', t: 2 },
      { type: 'click', sessionId: 'sess_1', userId: 'user_42', t: 3 },
    ];
    await ingest(makeDto({ events }), null);

    const login = LoginEvent.create.mock.calls[0][0];
    expect(login.events.map((e) => e.type)).toEqual(['keydown', 'identify']);
    expect(login.userId).toBe('user_42');
    const sess = SessionEvent.create.mock.calls[0][0];
    expect(sess.events.map((e) => e.type)).toEqual(['click']);
    expect(sess.userId).toBe('user_42');

    // initial upsert + attachUserId
    expect(Session.updateOne).toHaveBeenCalledTimes(2);
    expect(Session.updateOne.mock.calls[0][1].$set.phase).toBe('session');
    expect(Session.updateOne.mock.calls[1][1].$set).toEqual({ userId: 'user_42', identifiedBy: 'browser' });
    expect(LoginEvent.updateMany).toHaveBeenCalledWith(
      { sessionId: 'sess_1', userId: null },
      { $set: { userId: 'user_42' } }
    );
  });

  test('logged-in session: payment page events go to payment_events', async () => {
    mockExistingSession({ userId: 'user_42', phase: 'session' });
    const events = [
      { type: 'click', sessionId: 'sess_1', userId: 'user_42', page: '/dashboard', t: 1 },
      { type: 'keydown', sessionId: 'sess_1', userId: 'user_42', page: '/checkout/card', t: 2 },
      { type: 'click', sessionId: 'sess_1', userId: 'user_42', page: '/x', pageType: 'payment', t: 3 },
    ];
    await ingest(makeDto({ events }), null);

    expect(LoginEvent.create).not.toHaveBeenCalled();
    expect(SessionEvent.create.mock.calls[0][0].eventCount).toBe(1);
    expect(PaymentEvent.create.mock.calls[0][0].eventCount).toBe(2);
    expect(PaymentEvent.create.mock.calls[0][0].userId).toBe('user_42');
  });

  test('logout is stored in session_events and later events go back to login_events', async () => {
    mockExistingSession({ userId: 'user_42', phase: 'session' });
    const events = [
      { type: 'click', sessionId: 'sess_1', userId: 'user_42', t: 1 },
      { type: 'logout', sessionId: 'sess_1', userId: 'user_42', t: 2 },
      { type: 'mousemove', sessionId: 'sess_1', t: 3 },
    ];
    await ingest(makeDto({ events }), null);

    expect(SessionEvent.create.mock.calls[0][0].events.map((e) => e.type)).toEqual(['click', 'logout']);
    expect(LoginEvent.create.mock.calls[0][0].events.map((e) => e.type)).toEqual(['mousemove']);
    const $set = Session.updateOne.mock.calls[0][1].$set;
    expect($set.phase).toBe('login');
    expect($set.loggedOutAt).toBeInstanceOf(Date);
  });

  test('legacy session with userId but no phase is treated as logged in', async () => {
    mockExistingSession({ userId: 'user_1' });
    await ingest(makeDto(), null);
    expect(SessionEvent.create).toHaveBeenCalledTimes(1);
    expect(LoginEvent.create).not.toHaveBeenCalled();
  });

  test('does NOT re-attach a browser userId if the session already has one', async () => {
    mockExistingSession({ userId: 'user_already_set', phase: 'login' });
    const events = [{ type: 'identify', sessionId: 'sess_1', userId: 'user_new', t: 1 }];
    await ingest(makeDto({ events }), null);
    expect(Session.updateOne).toHaveBeenCalledTimes(1);
    expect(LoginEvent.updateMany).not.toHaveBeenCalled();
  });

  test('identify without userId does not count as login', async () => {
    const events = [{ type: 'identify', sessionId: 'sess_1', t: 1 }];
    await ingest(makeDto({ events }), null);
    expect(LoginEvent.create.mock.calls[0][0].userId).toBeNull();
    expect(Session.updateOne.mock.calls[0][1].$set.phase).toBe('login');
  });
});

describe('splitEvents()', () => {
  test('payment page before login still counts as login phase', () => {
    const { buckets } = splitEvents([{ type: 'click', page: '/payment' }], 'login');
    expect(buckets.login).toHaveLength(1);
    expect(buckets.payment).toHaveLength(0);
  });
});

describe('attachUserId()', () => {
  test('server identify marks session logged in and backfills login_events', async () => {
    LoginEvent.updateMany = jest.fn().mockResolvedValue({ modifiedCount: 3 });
    await attachUserId('sess_7', 'user_99', 'server');

    const [filter, update] = Session.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: 'sess_7' });
    expect(update.$set).toMatchObject({ userId: 'user_99', identifiedBy: 'server', phase: 'session' });
    expect(LoginEvent.updateMany).toHaveBeenCalledWith(
      { sessionId: 'sess_7', userId: null },
      { $set: { userId: 'user_99' } }
    );
  });
});
