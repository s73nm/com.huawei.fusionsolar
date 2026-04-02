'use strict';

const https = require('https');

const REQUEST_TIMEOUT_MS = 15000;

/**
 * Sends a POST request to the FusionSolar Northbound API.
 */
function post(baseUrl, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url     = new URL(path, baseUrl);

    const options = {
      hostname: url.hostname,
      port:     url.port || 443,
      path:     url.pathname,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Accept:           'application/json',
        'User-Agent':     'Homey/FusionSolarOpenAPI',
        ...(token ? { 'xsrf-token': token } : {}),
      },
      timeout: REQUEST_TIMEOUT_MS,
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve({ data: JSON.parse(raw), headers: res.headers });
        } catch (err) {
          reject(new Error(`Failed to parse response: ${err.message}`));
        }
      });
    });

    req.on('error',   (err) => reject(new Error(`Network error: ${err.message}`)));
    req.on('timeout', ()    => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(payload);
    req.end();
  });
}

/** Returns true when the API indicates a session-expired condition. */
function isSessionExpired(failCode) {
  return failCode === 305 || failCode === 306;
}

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

/**
 * Authenticates and returns the xsrf-token.
 */
async function login(baseUrl, userName, systemCode) {
  const { data, headers } = await post(baseUrl, '/thirdData/login', { userName, systemCode });

  if (!data.success) {
    throw new Error(`Login failed (${data.failCode ?? 'unknown'}): ${data.message ?? 'Check credentials'}`);
  }

  const token = headers['xsrf-token'];
  if (!token) throw new Error('Login succeeded but no xsrf-token in response');
  return token;
}

/**
 * Returns the list of stations for this account.
 */
async function getStationList(baseUrl, token) {
  const { data } = await post(baseUrl, '/thirdData/getStationList', { pageNo: 1, pageSize: 100 }, token);

  if (!data.success) return { expired: isSessionExpired(data.failCode), stations: [] };

  let stations = [];
  if (Array.isArray(data.data))                    stations = data.data;
  else if (data.data && Array.isArray(data.data.list)) stations = data.data.list;

  return { expired: false, stations };
}

/**
 * Returns real-time station-level KPI (power, daily/monthly/total energy).
 */
async function getStationRealKpi(baseUrl, token, stationCode) {
  const { data } = await post(baseUrl, '/thirdData/getStationRealKpi', { stationCodes: stationCode }, token);

  if (!data.success) return { expired: isSessionExpired(data.failCode), kpi: null };

  const list  = Array.isArray(data.data) ? data.data : [];
  const entry = list.find((d) => d.stationCode === stationCode) ?? list[0];
  if (!entry?.dataItemMap) return { expired: false, kpi: null };

  const m = entry.dataItemMap;

  return {
    expired: false,
    kpi: {
      realTimePower: num(m.real_time_power) !== null ? Math.round(num(m.real_time_power) * 1000) : null, // kW → W
      dailyEnergy:   num(m.day_power),
      monthEnergy:   num(m.month_power),
      totalEnergy:   num(m.total_power),
      perPower:      num(m.per_power ?? m.perPower),   // specific yield kWh/kWp (may not exist)
      dayIncome:     num(m.day_income),
      totalIncome:   num(m.total_income),
    },
  };
}

/**
 * Returns yearly energy for a station.
 * collectTime can be any timestamp within the desired year (defaults to now).
 */
async function getStationYearKpi(baseUrl, token, stationCode, collectTime = Date.now()) {
  const { data } = await post(
    baseUrl,
    '/thirdData/getKpiStationYear',
    { stationCodes: stationCode, collectTime },
    token,
  );

  if (!data.success) return { expired: isSessionExpired(data.failCode), yearEnergy: null };

  const list  = Array.isArray(data.data) ? data.data : [];
  const entry = list.find((d) => d.stationCode === stationCode) ?? list[0];
  if (!entry?.dataItemMap) return { expired: false, yearEnergy: null };

  const m = entry.dataItemMap;
  // Field name varies by API version
  const yearEnergy = num(m.inverter_power ?? m.power ?? m.ongrid_power ?? m.radiation_intensity);

  return { expired: false, yearEnergy };
}

/**
 * Returns the list of devices (inverters, batteries, meters) for a station.
 * Each device has: devSn, devName, devTypeId
 *   devTypeId 1  = String Inverter (SUN2000)
 *   devTypeId 14 = Battery (LUNA2000, older API / some regions)
 *   devTypeId 17 = Grid meter (DTSU666)
 *   devTypeId 39 = Battery (LUNA2000, newer API / other regions)
 */
async function getDevList(baseUrl, token, stationCode) {
  const { data } = await post(baseUrl, '/thirdData/getDevList', { stationCodes: stationCode }, token);

  if (!data.success) return { expired: isSessionExpired(data.failCode), devices: [] };

  const devices = Array.isArray(data.data) ? data.data : [];
  return { expired: false, devices };
}

/**
 * Returns real-time KPI for a list of devices of the same type.
 *
 * devTypeId 1 (Inverter) dataItemMap fields:
 *   active_power (kW), reactive_power (kVar), power_factor,
 *   grid_frequency (Hz), efficiency (%), temperature (°C),
 *   mppt_power (kW), pv1_u (V), pv1_i (A), pv2_u (V), pv2_i (A),
 *   ab_u (V), a_u, b_u, c_u (phase voltages V), a_i, b_i, c_i (A)
 */
async function getDevRealKpi(baseUrl, token, devSns, devTypeId) {
  const { data } = await post(
    baseUrl,
    '/thirdData/getDevRealKpi',
    { devSns: devSns.join(','), devTypeId },
    token,
  );

  if (!data.success) return { expired: isSessionExpired(data.failCode), devices: [] };

  const devices = Array.isArray(data.data) ? data.data : [];
  return { expired: false, devices };
}

module.exports = {
  login,
  getStationList,
  getStationRealKpi,
  getStationYearKpi,
  getDevList,
  getDevRealKpi,
};
