'use strict';

jest.mock('../src/models/NetworkIntel');
jest.mock('../src/models/UserGeoHistory');
jest.mock('../src/models/Session');

const config = require('../src/config');
const { isPrivateIp } = require('../src/ipIntel/privateIp');
const providers = require('../src/ipIntel/providers');
const NetworkIntel = require('../src/models/NetworkIntel');
const UserGeoHistory = require('../src/models/UserGeoHistory');
const svc = require('../src/ipIntelService');

function mockFetchJson(body, ok = true) {
  global.fetch = jest.fn().mockResolvedValue({ ok, status: ok ? 200 : 500, json: async () => body });
}

beforeEach(() => {
  jest.clearAllMocks();
  svc._resetCacheForTests();
  config.ipIntel.provider = 'ipqs';
  config.ipIntel.apiKey = 'test-key';
  config.ipIntel.devIp = '';
});

describe('isPrivateIp', () => {
  test.each(['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '100.64.0.5', '::1', 'fd00::1', 'fe80::1', 'garbage'])(
    '%s is private/unclassifiable', (ip) => expect(isPrivateIp(ip)).toBe(true)
  );
  test.each(['8.8.8.8', '49.205.1.1', '172.32.0.1', '2001:4860:4860::8888'])(
    '%s is public', (ip) => expect(isPrivateIp(ip)).toBe(false)
  );
});

describe('providers', () => {
  test('ipqs maps VPN + Data Center and treats "N/A" as null', async () => {
    mockFetchJson({ success: true, country_code: 'NL', timezone: 'N/A', vpn: true, proxy: true, tor: false, connection_type: 'Data Center' });
    const r = await providers.ipqs('1.2.3.4', { config: config.ipIntel, userAgent: 'UA' });
    expect(r).toEqual({ country: 'NL', timezone: null, isVpn: true, isProxy: true, isTor: false, isDatacenter: true });
    expect(global.fetch.mock.calls[0][0]).toContain('user_agent=UA');
  });

  test('ipqs throws when success is false', async () => {
    mockFetchJson({ success: false, message: 'Invalid key' });
    await expect(providers.ipqs('1.2.3.4', { config: config.ipIntel })).rejects.toThrow('Invalid key');
  });

  test('ipapi maps hosting → datacenter and leaves isVpn null', async () => {
    mockFetchJson({ status: 'success', countryCode: 'IN', timezone: 'Asia/Kolkata', proxy: false, hosting: true });
    const r = await providers.ipapi('1.2.3.4', { config: config.ipIntel });
    expect(r).toMatchObject({ country: 'IN', isVpn: null, isProxy: false, isDatacenter: true });
  });
});

describe('classifyIp', () => {
  test('private IP → private_ip, no provider call', async () => {
    global.fetch = jest.fn();
    const r = await svc.classifyIp('127.0.0.1');
    expect(r.source).toBe('private_ip');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('private IP uses IP_INTEL_DEV_IP outside production', async () => {
    config.ipIntel.devIp = '49.205.1.1';
    mockFetchJson({ success: true, country_code: 'IN', vpn: false, proxy: false, tor: false, connection_type: 'Residential' });
    const r = await svc.classifyIp('::1');
    expect(r.source).toBe('provider');
    expect(global.fetch.mock.calls[0][0]).toContain('49.205.1.1');
  });

  test('no API key → disabled', async () => {
    config.ipIntel.apiKey = '';
    const r = await svc.classifyIp('8.8.8.8');
    expect(r.source).toBe('disabled');
  });

  test('second lookup of the same IP is served from cache; concurrent lookups share one call', async () => {
    mockFetchJson({ success: true, country_code: 'US', vpn: false, proxy: false, tor: false, connection_type: 'Residential' });
    const [a, b] = await Promise.all([svc.classifyIp('8.8.8.8'), svc.classifyIp('8.8.8.8')]);
    expect(a.data.country).toBe('US');
    expect(b.data.country).toBe('US');
    const c = await svc.classifyIp('8.8.8.8');
    expect(c.source).toBe('cache');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('provider failure → error source with nulls, not a throw', async () => {
    mockFetchJson({}, false);
    const r = await svc.classifyIp('8.8.8.8');
    expect(r.source).toBe('error');
    expect(r.data.isVpn).toBeNull();
  });
});

describe('evaluateNewCountry', () => {
  const doc = { _id: 'n1', tenantId: 't1', country: 'GB', evaluatedForUserId: null };
  beforeEach(() => {
    NetworkIntel.updateOne = jest.fn().mockResolvedValue({});
    UserGeoHistory.updateOne = jest.fn().mockResolvedValue({});
  });
  const history = (countries) =>
    (UserGeoHistory.findOne = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(countries ? { countries } : null) }));

  test('true when the user has history and this country is not in it', async () => {
    history(['IN']);
    expect(await svc.evaluateNewCountry(doc, 'u1')).toBe(true);
    expect(UserGeoHistory.updateOne).toHaveBeenCalledWith(
      { tenantId: 't1', userId: 'u1' }, { $addToSet: { countries: 'GB' } }, { upsert: true }
    );
  });

  test('false for a known country', async () => {
    history(['IN', 'GB']);
    expect(await svc.evaluateNewCountry(doc, 'u1')).toBe(false);
  });

  test('null on the first-ever login (no baseline), but the country is recorded', async () => {
    history(null);
    expect(await svc.evaluateNewCountry(doc, 'u1')).toBeNull();
    expect(UserGeoHistory.updateOne).toHaveBeenCalled();
  });

  test('does not re-evaluate a record already scored for this user', async () => {
    history(['IN']);
    expect(await svc.evaluateNewCountry({ ...doc, evaluatedForUserId: 'u1', isNewCountry: true }, 'u1')).toBe(true);
    expect(UserGeoHistory.findOne).not.toHaveBeenCalled();
  });
});
