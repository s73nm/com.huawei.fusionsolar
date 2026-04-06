'use strict';

const { Driver } = require('homey');
const {
  LUNA2000_EMMA_DATA_REGISTERS,
  isLuna2000EmmaDataValid,
} = require('../../lib/modbus-registers');
const { readModbusRegisters } = require('../../lib/modbus-client');

class LUNA2000EmmaModbusDriver extends Driver {

  async onInit() {
    this.log('LUNA2000 EMMA Modbus driver initialised');
  }

  async onPair(session) {
    session.setHandler('connect', async ({ address, port, modbusId, name }) => {
      address  = (address || '').trim();
      port     = parseInt(port, 10) || 502;
      modbusId = parseInt(modbusId, 10) || 0;

      if (!address) {
        throw new Error(this.homey.__('modbus.pair.errors.noAddress'));
      }

      const probeRegisters = {
        soc:                   LUNA2000_EMMA_DATA_REGISTERS.soc,
        batteryPower:          LUNA2000_EMMA_DATA_REGISTERS.batteryPower,
        totalChargedEnergy:    LUNA2000_EMMA_DATA_REGISTERS.totalChargedEnergy,
        chargedToday:          LUNA2000_EMMA_DATA_REGISTERS.chargedToday,
      };

      const data = await readModbusRegisters(address, port, modbusId, probeRegisters);

      if (!isLuna2000EmmaDataValid(data)) {
        throw new Error(this.homey.__('modbus.pair.errors.batteryNotDetected'));
      }

      this.log(`Pairing LUNA2000 (EMMA) at ${address}:${port} id=${modbusId}, SOC=${data.soc}%`);

      return {
        success: true,
        kpi: {
          soc:          data.soc,
          batteryPower: data.batteryPower,
          totalCharged: data.totalChargedEnergy,
          chargedToday: data.chargedToday,
        },
      };
    });
  }

}

module.exports = LUNA2000EmmaModbusDriver;
