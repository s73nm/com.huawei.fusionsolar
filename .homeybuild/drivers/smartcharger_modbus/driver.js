'use strict';

const { Driver } = require('homey');
const { SMARTCHARGER_REGISTERS } = require('../../lib/modbus-registers');
const { readModbusRegisters } = require('../../lib/modbus-client');

class SmartChargerModbusDriver extends Driver {

  async onInit() {
    this.log('SmartCharger Modbus driver initialised');
  }

  async onPair(session) {
    session.setHandler('connect', async ({ address, port, modbusId, name }) => {
      address  = (address || '').trim();
      port     = parseInt(port, 10) || 502;
      modbusId = parseInt(modbusId, 10) || 1;

      if (!address) {
        throw new Error(this.homey.__('modbus.pair.errors.noAddress'));
      }

      const probeRegisters = {
        offeringName:       SMARTCHARGER_REGISTERS.offeringName,
        ratedPower:         SMARTCHARGER_REGISTERS.ratedPower,
        totalEnergyCharged: SMARTCHARGER_REGISTERS.totalEnergyCharged,
        chargerTemperature: SMARTCHARGER_REGISTERS.chargerTemperature,
        phaseAVoltage:      SMARTCHARGER_REGISTERS.phaseAVoltage,
      };

      const data = await readModbusRegisters(address, port, modbusId, probeRegisters);

      this.log(`Pairing SmartCharger at ${address}:${port} id=${modbusId}, name="${data.offeringName}", rated=${data.ratedPower}kW`);

      return {
        success:      true,
        offeringName: data.offeringName || 'SmartCharger',
        kpi: {
          ratedPower:         data.ratedPower,
          totalEnergyCharged: data.totalEnergyCharged,
          chargerTemperature: data.chargerTemperature,
          phaseAVoltage:      data.phaseAVoltage,
        },
      };
    });
  }

}

module.exports = SmartChargerModbusDriver;
