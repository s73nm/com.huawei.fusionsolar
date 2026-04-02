'use strict';

const { Device } = require('homey');
const {
  login,
  getStationRealKpi,
  getStationYearKpi,
  getDevList,
  getDevRealKpi,
} = require('../../lib/openapi-client');

const DEFAULT_INTERVAL_MIN = 10;
const MIN_INTERVAL_MIN     = 5;

const DEV_TYPE_INVERTER       = 1;
const DEV_TYPE_BATTERY        = 14; // LUNA2000 (older API / some regions)
const DEV_TYPE_BATTERY_ALT    = 39; // LUNA2000 (newer API / other regions)
const DEV_TYPE_METER          = 17; // DTSU666 grid meter

// Station-level capabilities — always present
const REQUIRED_CAPABILITIES = [
  'measure_power',       // real-time AC output (W)
  'meter_power',         // total lifetime yield (kWh)
  'meter_power.daily',   // today's yield (kWh)
  'meter_power_monthly', // this month's yield (kWh)
  'meter_power_yearly',  // this year's yield (kWh)
];

// Inverter-level capabilities — always present (show — until data arrives)
const INVERTER_CAPABILITIES = [
  'measure_temperature.invertor', // internal temperature (°C)
  'measure_efficiency',           // inverter efficiency (%)
  'measure_frequency',            // grid frequency (Hz)
  'measure_power.active_power',   // AC active power sum (W)
];

// Battery-level capabilities — added dynamically when battery data is available
const BATTERY_CAPABILITIES = [
  'measure_battery',              // SoC (%)
  'measure_power.batt_plant',     // battery power W (+ = charging, − = discharging)
  'meter_power.plant_charged',    // charged today (kWh)
  'meter_power.plant_discharged', // discharged today (kWh)
];

// Grid meter capabilities — added dynamically when meter data is available
const METER_CAPABILITIES = [
  'measure_power.grid_import', // grid import power (W)
  'measure_power.grid_export', // grid export power (W)
];

class FusionSolarOpenAPIDevice extends Device {

  async onInit() {
    this.log(`Device initialised: ${this.getName()}`);
    this._token          = null;
    this._devSnsByType   = null; // { [typeId]: [sn, ...] } — shared cache for all device types
    await this._ensureCapabilities();
    await this._startPolling();
    this._fetchAndUpdate().catch((err) => {
      this.error('Initial fetch failed:', err.message);
    });
  }

  async onSettings({ changedKeys }) {
    if (['base_url', 'username', 'system_code', 'poll_interval'].some((k) => changedKeys.includes(k))) {
      this._token        = null;
      this._devSnsByType = null;
      await this._stopPolling();
      await this._startPolling();
      this._fetchAndUpdate().catch((err) => {
        this.error('Fetch after settings change failed:', err.message);
      });
    }
  }

  async onUninit() { await this._stopPolling(); }
  async onDeleted() { await this._stopPolling(); }

  // ─── Capabilities ──────────────────────────────────────────────────────────

  async _ensureCapabilities() {
    for (const cap of [...REQUIRED_CAPABILITIES, ...INVERTER_CAPABILITIES]) {
      if (!this.hasCapability(cap)) await this.addCapability(cap);
    }
  }

  // ─── Polling ───────────────────────────────────────────────────────────────

  _intervalMs() {
    let min = parseInt(this.getSetting('poll_interval'), 10);
    if (!Number.isFinite(min) || min < MIN_INTERVAL_MIN) min = DEFAULT_INTERVAL_MIN;
    return min * 60 * 1000;
  }

  async _startPolling() {
    this._timer = this.homey.setInterval(() => {
      this._fetchAndUpdate().catch((err) => this.error('Poll failed:', err.message));
    }, this._intervalMs());
  }

  async _stopPolling() {
    if (this._timer) { this.homey.clearInterval(this._timer); this._timer = null; }
  }

  // ─── Auth ──────────────────────────────────────────────────────────────────

  _baseUrl() {
    return (this.getSetting('base_url') || 'https://eu5.fusionsolar.huawei.com').trim().replace(/\/$/, '');
  }

  async _ensureToken() {
    if (this._token) return this._token;
    const username   = this.getSetting('username');
    const systemCode = this.getSetting('system_code');
    if (!username || !systemCode) throw new Error(this.homey.__('openapi.errors.noCredentials'));
    this._token = await login(this._baseUrl(), username, systemCode);
    return this._token;
  }

  async _withAutoRelogin(fn) {
    const token = await this._ensureToken();
    let result  = await fn(token);
    if (result.expired) {
      this._token = null;
      const fresh = await this._ensureToken();
      result = await fn(fresh);
    }
    return result;
  }

  // ─── Device list cache (shared by all device-type fetchers) ────────────────

  async _ensureDevSnsByType(base, stationCode) {
    if (this._devSnsByType) return;
    const devResult = await this._withAutoRelogin(
      (t) => getDevList(base, t, stationCode),
    );
    this._devSnsByType = {};
    for (const d of devResult.devices) {
      const typeId = Number(d.devTypeId);
      if (!this._devSnsByType[typeId]) this._devSnsByType[typeId] = [];
      if (d.devSn) this._devSnsByType[typeId].push(d.devSn);
    }
    this.log(`Device list cached: ${JSON.stringify(Object.fromEntries(
      Object.entries(this._devSnsByType).map(([k, v]) => [k, v.length]),
    ))}`);
  }

  // ─── Data fetch ────────────────────────────────────────────────────────────

  async _fetchAndUpdate() {
    if (this._fetchInProgress) return;
    this._fetchInProgress = true;

    const stationCode = this.getSetting('station_code');
    if (!stationCode) {
      this._fetchInProgress = false;
      await this.setUnavailable(this.homey.__('openapi.errors.noStation'));
      return;
    }

    const base = this._baseUrl();

    try {
      // ── Station-level KPI ──
      const stationResult = await this._withAutoRelogin(
        (t) => getStationRealKpi(base, t, stationCode),
      );

      if (!stationResult.kpi) {
        await this.setUnavailable(this.homey.__('openapi.errors.noData'));
        this._fetchInProgress = false;
        return;
      }

      const { kpi } = stationResult;
      await this._set('measure_power',      kpi.realTimePower);
      await this._set('meter_power',         kpi.totalEnergy);
      await this._set('meter_power.daily',   kpi.dailyEnergy);
      await this._set('meter_power_monthly', kpi.monthEnergy);

      // ── Non-blocking sub-fetches ──
      this._fetchYearKpi(base, stationCode).catch(() => {});
      this._fetchInverterKpi(base, stationCode).catch(() => {});
      this._fetchBatteryKpi(base, stationCode).catch(() => {});
      this._fetchMeterKpi(base, stationCode).catch(() => {});

      await this.homey.flow
        .getDeviceTriggerCard('openapi_power_changed')
        .trigger(this, { power: kpi.realTimePower ?? 0 })
        .catch(() => {});

      if (!this.getAvailable()) await this.setAvailable();

    } catch (err) {
      this.error('Fetch error:', err.message);
      if (err.message.includes('Login failed') || err.message.includes('noCredentials')) {
        this._token = null;
      }
      await this.setUnavailable(`${this.homey.__('openapi.errors.fetchFailed')}: ${err.message}`);
    } finally {
      this._fetchInProgress = false;
    }
  }

  async _fetchYearKpi(base, stationCode) {
    try {
      const result = await this._withAutoRelogin(
        (t) => getStationYearKpi(base, t, stationCode),
      );
      if (result.yearEnergy !== null) {
        await this._set('meter_power_yearly', result.yearEnergy);
      }
    } catch (err) {
      this.log('Yearly KPI skipped:', err.message);
    }
  }

  async _fetchInverterKpi(base, stationCode) {
    try {
      await this._ensureDevSnsByType(base, stationCode);
      const sns = this._devSnsByType[DEV_TYPE_INVERTER] || [];
      if (!sns.length) return;

      const kpiResult = await this._withAutoRelogin(
        (t) => getDevRealKpi(base, t, sns, DEV_TYPE_INVERTER),
      );
      if (!kpiResult.devices.length) return;

      const maps = kpiResult.devices.map((d) => d.dataItemMap).filter(Boolean);
      if (!maps.length) return;

      const num  = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
      const avg  = (key) => {
        const vals = maps.map((m) => num(m[key])).filter((v) => v !== null);
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      };
      const sumW = (key) => {
        const vals = maps.map((m) => num(m[key])).filter((v) => v !== null);
        return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) * 1000) : null; // kW → W
      };

      await this._set('measure_temperature.invertor', avg('temperature'));
      await this._set('measure_efficiency',           avg('efficiency'));
      await this._set('measure_frequency',            avg('grid_frequency'));
      await this._set('measure_power.active_power',   sumW('active_power'));

    } catch (err) {
      this.error('Inverter KPI failed:', err.message);
    }
  }

  async _fetchBatteryKpi(base, stationCode) {
    try {
      await this._ensureDevSnsByType(base, stationCode);
      // Support both devTypeId 14 (older API) and 39 (newer API) for LUNA2000
      const sns14 = this._devSnsByType[DEV_TYPE_BATTERY]     || [];
      const sns39 = this._devSnsByType[DEV_TYPE_BATTERY_ALT] || [];
      const sns   = [...new Set([...sns14, ...sns39])];
      const typeId = sns39.length ? DEV_TYPE_BATTERY_ALT : DEV_TYPE_BATTERY;
      if (!sns.length) return;

      const result = await this._withAutoRelogin(
        (t) => getDevRealKpi(base, t, sns, typeId),
      );
      if (!result.devices.length) return;

      const maps = result.devices.map((d) => d.dataItemMap).filter(Boolean);
      if (!maps.length) return;

      const num    = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
      const avg    = (key) => {
        const vals = maps.map((m) => num(m[key])).filter((v) => v !== null);
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      };
      const sumW   = (key) => {
        const vals = maps.map((m) => num(m[key])).filter((v) => v !== null);
        return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) * 1000) : null;
      };
      const sumKwh = (key) => {
        const vals = maps.map((m) => num(m[key])).filter((v) => v !== null);
        return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
      };

      // Add battery capabilities dynamically on first successful fetch
      for (const cap of BATTERY_CAPABILITIES) {
        if (!this.hasCapability(cap)) await this.addCapability(cap).catch(() => {});
      }

      await this._set('measure_battery',              avg('battery_soc'));
      await this._set('measure_power.batt_plant',     sumW('battery_power'));
      await this._set('meter_power.plant_charged',    sumKwh('charge_cap'));
      await this._set('meter_power.plant_discharged', sumKwh('discharge_cap'));

    } catch (err) {
      this.error('Battery KPI failed:', err.message);
    }
  }

  async _fetchMeterKpi(base, stationCode) {
    try {
      await this._ensureDevSnsByType(base, stationCode);
      const sns = this._devSnsByType[DEV_TYPE_METER] || [];
      if (!sns.length) return;

      const result = await this._withAutoRelogin(
        (t) => getDevRealKpi(base, t, sns, DEV_TYPE_METER),
      );
      if (!result.devices.length) return;

      const maps = result.devices.map((d) => d.dataItemMap).filter(Boolean);
      if (!maps.length) return;

      const num  = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
      const sumW = (key) => {
        const vals = maps.map((m) => num(m[key])).filter((v) => v !== null);
        return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) * 1000) : null;
      };

      // Add meter capabilities dynamically on first successful fetch
      for (const cap of METER_CAPABILITIES) {
        if (!this.hasCapability(cap)) await this.addCapability(cap).catch(() => {});
      }

      await this._set('measure_power.grid_import', sumW('active_power'));
      await this._set('measure_power.grid_export', sumW('reverse_active_power'));

    } catch (err) {
      this.error('Meter KPI failed:', err.message);
    }
  }

  // ─── Helper ────────────────────────────────────────────────────────────────

  async _set(capability, value) {
    if (value === null || value === undefined) return;
    if (!this.hasCapability(capability)) return;
    if (this.getCapabilityValue(capability) === value) return;
    try {
      await this.setCapabilityValue(capability, value);
    } catch (err) {
      this.log(`_set(${capability}, ${value}) failed:`, err.message);
    }
  }

}

module.exports = FusionSolarOpenAPIDevice;
