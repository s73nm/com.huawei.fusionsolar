'use strict';

const { Driver } = require('homey');
const {
  POWERMETER_EMMA_DATA_REGISTERS,
  isPowerMeterEmmaDataValid,
} = require('../../lib/modbus-registers');
const { readModbusRegisters } = require('../../lib/modbus-client');

class PowerMeterEmmaModbusDriver extends Driver {

  async onInit() {
    this.log('Power Meter EMMA Modbus driver initialised');
  }

  async onPair(session) {
    session.setHandler('connect', async ({ address, port, modbusId, name }) => {
      address  = (address || '').trim();
      port     = parseInt(port, 10) || 502;
      modbusId = parseInt(modbusId, 10) || 0;

      if (!address) {
        throw new Error(this.homey.__('modbus.pair.errors.noAddress'));
      }

      const data = await readModbusRegisters(address, port, modbusId, POWERMETER_EMMA_DATA_REGISTERS);

      if (!isPowerMeterEmmaDataValid(data)) {
        throw new Error(this.homey.__('modbus.pair.errors.meterNotDetected'));
      }

      this.log(`Pairing Power Meter (EMMA) at ${address}:${port} id=${modbusId}, feedIn=${data.feedInPower}W`);

      return {
        success: true,
        kpi: {
          feedInPower:         data.feedInPower,
          totalFeedInToGrid:   data.totalFeedInToGrid,
          totalSupplyFromGrid: data.totalSupplyFromGrid,
        },
      };
    });
  }

}

module.exports = PowerMeterEmmaModbusDriver;
