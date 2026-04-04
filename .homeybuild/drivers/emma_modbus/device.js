'use strict';

const { Device } = require('homey');
const {
  EMMA_REGISTERS,
  isEmmaDataValid,
} = require('../../lib/modbus-registers');
const { readModbusRegisters } = require('../../lib/modbus-client');

const DEFAULT_INTERVAL_S = 60;
const MIN_INTERVAL_S     = 10;

// All capabilities provided by the EMMA device.
// Order here controls display order for newly paired devices.
const REQUIRED_CAPABILITIES = [
  // ── Grid ─────────────────────────────────────────────────────────────────
  'measure_power',            // Netzwirkleistung (W): + = import, − = export
  'meter_power',              // Netzbezug gesamt (kWh) – used by Homey Energy as cumulativeImported
  'meter_power.exported',     // Netzeinspeisung gesamt (kWh) – cumulativeExported
  'meter_power.imported_today',  // Netzbezug heute (kWh)
  'meter_power.exported_today',  // Netzeinspeisung heute (kWh)

  // ── Solar ─────────────────────────────────────────────────────────────────
  'measure_power.pv',         // Solarleistung (W)
  'meter_power.pv_total',     // Gesamtertrag PV (kWh)
  'meter_power.pv_daily',     // PV-Ertrag heute (kWh)
  'meter_power.inv_total',    // Gesamtertrag Wechselrichter (kWh)
  'meter_power.inv_daily',    // Wechselrichter-Ertrag heute (kWh)

  // ── House load ────────────────────────────────────────────────────────────
  'measure_power.load',       // Hausverbrauch (W) – live
  'meter_power.consumption_today', // Hausverbrauch heute (kWh)

  // ── Battery ───────────────────────────────────────────────────────────────
  'measure_power.battery',    // Batterieleistung (W): + = laden, − = entladen
  'measure_battery',          // Batterie SOC (%)
  'meter_power.charged',      // Gesamte Ladeenergie (kWh)
  'meter_power.discharged',   // Gesamte Entladeenergie (kWh)
  'meter_power.charged_today',     // Ladeenergie heute (kWh)
  'meter_power.discharged_today',  // Entladeenergie heute (kWh)
];

class EMMAModbusDevice extends Device {

  async onInit() {
    this.log(`[EMMA] Device initialised: ${this.getName()}`);
    this._failureCount = 0;
    await this._ensureCapabilities();
    await this._startPolling();

    this._fetchAndUpdate().catch((err) => {
      this.error('Initial fetch failed:', err.message);
    });
  }

  async onSettings({ changedKeys }) {
    if (['address', 'port', 'modbus_id', 'poll_interval'].some((k) => changedKeys.includes(k))) {
      await this._stopPolling();
      await this._startPolling();
      this._fetchAndUpdate().catch((err) => {
        this.error('Fetch after settings change failed:', err.message);
      });
    }
  }

  async onUninit() {
    await this._stopPolling();
  }

  async onDeleted() {
    await this._stopPolling();
  }

  // ─── Capabilities ──────────────────────────────────────────────────────────

  async _ensureCapabilities() {
    for (const cap of REQUIRED_CAPABILITIES) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap);
      }
    }
  }

  // ─── Polling ───────────────────────────────────────────────────────────────

  _intervalMs() {
    let s = parseInt(this.getSetting('poll_interval'), 10);
    if (!Number.isFinite(s) || s < MIN_INTERVAL_S) s = DEFAULT_INTERVAL_S;
    return s * 1000;
  }

  async _startPolling() {
    this._timer = this.homey.setInterval(() => {
      this._fetchAndUpdate().catch((err) => {
        this.error('Poll failed:', err.message);
      });
    }, this._intervalMs());
  }

  async _stopPolling() {
    if (this._timer) {
      this.homey.clearInterval(this._timer);
      this._timer = null;
    }
  }

  // ─── Data fetch ────────────────────────────────────────────────────────────

  async _fetchAndUpdate() {
    if (this._fetchInProgress) return;
    this._fetchInProgress = true;

    const address = this.getSetting('address');

    if (!address) {
      this._fetchInProgress = false;
      await this.setUnavailable(this.homey.__('modbus.errors.noAddress'));
      return;
    }

    const port     = parseInt(this.getSetting('port'), 10) || 502;
    const modbusId = parseInt(this.getSetting('modbus_id'), 10) || 0;

    try {
      const d = await readModbusRegisters(address, port, modbusId, EMMA_REGISTERS);

      if (!isEmmaDataValid(d)) {
        this._failureCount += 1;
        if (this._failureCount >= 3) {
          await this.setUnavailable(this.homey.__('modbus.errors.emmaNotDetected'));
        }
        this._fetchInProgress = false;
        return;
      }

      // Sign convention: feedInPower (+) = export to grid, (−) = import from grid
      // Homey convention for measure_power: (+) = import, (−) = export → negate
      const negate = (v) => (v !== null && v !== undefined) ? -v : null;

      // ── Grid ───────────────────────────────────────────────────────────────
      await this._set('measure_power',             negate(d.feedInPower));
      await this._set('meter_power',               d.totalSupplyFromGrid   ?? null);
      await this._set('meter_power.exported',      d.totalFeedInToGrid     ?? null);
      await this._set('meter_power.imported_today', d.supplyFromGridToday  ?? null);
      await this._set('meter_power.exported_today', d.feedInToGridToday    ?? null);

      // ── Solar ──────────────────────────────────────────────────────────────
      await this._set('measure_power.pv',          d.pvOutputPower         ?? null);
      await this._set('meter_power.pv_total',      d.totalPvEnergyYield    ?? null);
      await this._set('meter_power.pv_daily',      d.pvYieldToday          ?? null);
      await this._set('meter_power.inv_total',     d.inverterTotalYield    ?? null);
      await this._set('meter_power.inv_daily',     d.inverterYieldToday    ?? null);

      // ── House load ─────────────────────────────────────────────────────────
      await this._set('measure_power.load',        d.loadPower             ?? null);
      await this._set('meter_power.consumption_today', d.consumptionToday  ?? null);

      // ── Battery ────────────────────────────────────────────────────────────
      // batteryPower: (+) = charging, (−) = discharging (same as Homey convention)
      await this._set('measure_power.battery',     d.batteryPower          ?? null);
      await this._set('measure_battery',           d.soc                   ?? null);
      await this._set('meter_power.charged',       d.totalChargedEnergy    ?? null);
      await this._set('meter_power.discharged',    d.totalDischargedEnergy ?? null);
      await this._set('meter_power.charged_today',    d.chargedToday       ?? null);
      await this._set('meter_power.discharged_today', d.dischargedToday    ?? null);

      this._failureCount = 0;
      if (!this.getAvailable()) await this.setAvailable();

    } catch (err) {
      this._failureCount += 1;
      this.error(`Fetch error (${this._failureCount}):`, err.message);
      if (this._failureCount >= 3) {
        await this.setUnavailable(
          `${this.homey.__('modbus.errors.fetchFailed')}: ${err.message}`,
        );
      }
    } finally {
      this._fetchInProgress = false;
    }
  }

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

module.exports = EMMAModbusDevice;
