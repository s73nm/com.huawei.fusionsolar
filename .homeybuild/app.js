'use strict';

const { App } = require('homey');

class FusionSolarKioskApp extends App {

  async onUninit() {
    this.log('FusionSolar app is stopping...');
  }

  async onInit() {
    this.log('FusionSolar app is running...');

    this.homey.flow
      .getConditionCard('is_producing')
      .registerRunListener(async ({ device }) => {
        const power = device.getCapabilityValue('measure_power');
        return typeof power === 'number' && power > 0;
      });

    this.homey.flow
      .getConditionCard('modbus_is_producing')
      .registerRunListener(async ({ device }) => {
        const power = device.getCapabilityValue('measure_power');
        return typeof power === 'number' && power > 0;
      });
  }

}

module.exports = FusionSolarKioskApp;
