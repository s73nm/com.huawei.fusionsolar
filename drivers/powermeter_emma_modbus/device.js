'use strict';

const { Device } = require('homey');
const {
  POWERMETER_EMMA_DATA_REGISTERS,
  isPowerMeterEmmaDataValid,
} = require('../../lib/modbus-registers');
const { readModbusRegisters } = require('../../lib/modbus-client');

const DEFAULT_INTERVAL_S = 60;
const MIN_INTERVAL_S     = 10;

// EMMA provides only aggregate grid data — no per-phase voltage, current, or power.
const REQUIRED_CAPABILITIES = [
  'measure_power',                   // Grid Active Power (W): + = import, − = export
  'meter_power',                     // Total Supply from Grid (kWh)
  'meter_power.exported',            // Total Feed-in to Grid (kWh)
  'meter_power.imported_today',      // Supply from Grid Today (kWh)
  'meter_power.exported_today',      // Feed-in to Grid Today (kWh)
  'measure_power.load',              // House Consumption Live (W)
  'meter_power.consumption_today',   // House Consumption Today (kWh)
];

class PowerMeterEmmaModbusDevice extends Device {

  async onInit() {
    this.log(`Device initialised: ${this.getName()}`);
    this._prevExporting   = null;
    this._failureCount    = 0;
    this._fetchInProgress = false;
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

  async onUninit() { await this._stopPolling(); }
  async onDeleted() { await this._stopPolling(); }

  // ─── Capabilities ──────────────────────────────────────────────────────────

  async _ensureCapabilities() {
    for (const cap of REQUIRED_CAPABILITIES) {
      if (!this.hasCapability(cap)) await this.addCapability(cap);
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
      const d = await readModbusRegisters(address, port, modbusId, POWERMETER_EMMA_DATA_REGISTERS);

      if (!isPowerMeterEmmaDataValid(d)) {
        this._failureCount += 1;
        if (this._failureCount >= 3) {
          await this.setUnavailable(this.homey.__('modbus.errors.meterNotDetected'));
        }
        this._fetchInProgress = false;
        return;
      }

      // feedInPower: + = export to grid, − = import from grid
      // Homey convention: + = import, − = export → negate
      const gridPower = d.feedInPower !== null && d.feedInPower !== undefined
        ? -d.feedInPower : null;

      await this._set('measure_power',                 gridPower);
      await this._set('meter_power',                   d.totalSupplyFromGrid  ?? null);
      await this._set('meter_power.exported',          d.totalFeedInToGrid    ?? null);
      await this._set('meter_power.imported_today',    d.supplyFromGridToday  ?? null);
      await this._set('meter_power.exported_today',    d.feedInToGridToday    ?? null);
      await this._set('measure_power.load',            d.loadPower            ?? null);
      await this._set('meter_power.consumption_today', d.consumptionToday     ?? null);

      // Fire export/import transition triggers (null = first run, skip)
      if (gridPower !== null && this._prevExporting !== null) {
        const isExporting = gridPower < 0;
        if (isExporting && !this._prevExporting) {
          this.homey.flow.getDeviceTriggerCard('dtsu666_grid_export_started')
            .trigger(this, { power: Math.abs(gridPower) }).catch(() => {});
        } else if (!isExporting && this._prevExporting) {
          this.homey.flow.getDeviceTriggerCard('dtsu666_grid_import_started')
            .trigger(this, { power: gridPower }).catch(() => {});
        }
      }
      if (gridPower !== null) this._prevExporting = gridPower < 0;

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

module.exports = PowerMeterEmmaModbusDevice;
