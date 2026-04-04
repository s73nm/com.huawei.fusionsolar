'use strict';

const { Driver } = require('homey');
const { EMMA_REGISTERS, isEmmaDataValid } = require('../../lib/modbus-registers');
const { readModbusRegisters } = require('../../lib/modbus-client');

class EMMAModbusDriver extends Driver {

  async onInit() {
    this.log('EMMA Modbus driver initialised');
  }

  async onPair(session) {
    session.setHandler('connect', async ({ address, port, modbusId, name }) => {
      address  = (address || '').trim();
      port     = parseInt(port, 10) || 502;
      modbusId = parseInt(modbusId, 10) || 0;

      if (!address) {
        throw new Error(this.homey.__('modbus.pair.errors.noAddress'));
      }

      // Probe a small subset of registers for fast validation
      const probeRegisters = {
        feedInPower:         EMMA_REGISTERS.feedInPower,
        totalSupplyFromGrid: EMMA_REGISTERS.totalSupplyFromGrid,
        totalFeedInToGrid:   EMMA_REGISTERS.totalFeedInToGrid,
        pvOutputPower:       EMMA_REGISTERS.pvOutputPower,
        soc:                 EMMA_REGISTERS.soc,
      };

      const data = await readModbusRegisters(address, port, modbusId, probeRegisters);

      if (!isEmmaDataValid(data)) {
        throw new Error(this.homey.__('modbus.pair.errors.emmaNotDetected'));
      }

      this.log(`[EMMA] Pairing at ${address}:${port} id=${modbusId}, feedInPower=${data.feedInPower}W, SOC=${data.soc}%`);

      return {
        success: true,
        kpi: {
          feedInPower:         data.feedInPower,
          totalSupplyFromGrid: data.totalSupplyFromGrid,
          totalFeedInToGrid:   data.totalFeedInToGrid,
          pvOutputPower:       data.pvOutputPower,
          soc:                 data.soc,
        },
      };
    });
  }

}

module.exports = EMMAModbusDriver;
