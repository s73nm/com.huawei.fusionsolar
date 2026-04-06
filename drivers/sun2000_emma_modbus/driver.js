'use strict';

const { Driver } = require('homey');
const {
  SUN2000_EMMA_DATA_REGISTERS,
  isSun2000EmmaDataValid,
} = require('../../lib/modbus-registers');
const { readModbusRegisters } = require('../../lib/modbus-client');

class SUN2000EmmaModbusDriver extends Driver {

  async onInit() {
    this.log('SUN2000 EMMA Modbus driver initialised');
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
        pvOutputPower:      SUN2000_EMMA_DATA_REGISTERS.pvOutputPower,
        inverterActivePower: SUN2000_EMMA_DATA_REGISTERS.inverterActivePower,
        inverterTotalYield: SUN2000_EMMA_DATA_REGISTERS.inverterTotalYield,
        inverterYieldToday: SUN2000_EMMA_DATA_REGISTERS.inverterYieldToday,
      };

      const data = await readModbusRegisters(address, port, modbusId, probeRegisters);

      if (!isSun2000EmmaDataValid(data)) {
        throw new Error(this.homey.__('modbus.pair.errors.inverterNotDetected'));
      }

      this.log(`Pairing SUN2000 (EMMA) at ${address}:${port} id=${modbusId}, PV=${data.pvOutputPower}W`);

      return {
        success: true,
        kpi: {
          pvOutputPower:      data.pvOutputPower,
          inverterActivePower: data.inverterActivePower,
          inverterTotalYield: data.inverterTotalYield,
          inverterYieldToday: data.inverterYieldToday,
        },
      };
    });
  }

}

module.exports = SUN2000EmmaModbusDriver;
