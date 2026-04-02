'use strict';

const { Driver } = require('homey');
const { login, getStationList } = require('../../lib/openapi-client');

class FusionSolarOpenAPIDriver extends Driver {

  async onInit() {
    this.log('FusionSolar OpenAPI driver initialised');
  }

  async onPair(session) {
    let _token   = null;
    let _baseUrl = 'https://eu5.fusionsolar.huawei.com';

    // Phase 1: Login and return list of available stations
    session.setHandler('login', async ({ baseUrl, username, systemCode }) => {
      _baseUrl = (baseUrl || 'https://eu5.fusionsolar.huawei.com').trim().replace(/\/$/, '');

      _token = await login(_baseUrl, username, systemCode);

      const { stations } = await getStationList(_baseUrl, _token);

      if (!stations.length) {
        throw new Error(this.homey.__('openapi.pair.errors.noStations'));
      }

      this.log(`Login OK – ${stations.length} station(s) found`);
      return { success: true, stations };
    });
  }

  async onRepair(session, device) {
    session.setHandler('login', async ({ baseUrl, username, systemCode }) => {
      const base = (baseUrl || 'https://eu5.fusionsolar.huawei.com').trim().replace(/\/$/, '');

      // Verify credentials by logging in
      await login(base, username, systemCode);

      await device.setSettings({ base_url: base, username, system_code: systemCode });
      return { success: true };
    });
  }

}

module.exports = FusionSolarOpenAPIDriver;
