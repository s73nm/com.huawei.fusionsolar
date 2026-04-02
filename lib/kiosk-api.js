'use strict';

const https = require('https');
const http = require('http');

/**
 * Parses a FusionSolar Kiosk URL and returns the base URL and kk token.
 *
 * Supports:
 *   https://uni001eu5.fusionsolar.huawei.com/pvmswebsite/.../cloud.html#/kiosk?kk=XXXXX
 *   https://eu5.fusionsolar.huawei.com/singleKiosk.html?kk=XXXXX
 *
 * @param {string} kioskUrl
 * @returns {{ baseUrl: string, kk: string }}
 */
function parseKioskUrl(kioskUrl) {
  if (!kioskUrl || typeof kioskUrl !== 'string') {
    throw new Error('Invalid kiosk URL');
  }

  const url = kioskUrl.trim();

  const kkMatch = url.match(/[?&#]kk=([^&\s]+)/);
  if (!kkMatch) {
    throw new Error('Could not find kk parameter in kiosk URL');
  }

  const urlMatch = url.match(/^(https?:\/\/[^/]+)/);
  if (!urlMatch) {
    throw new Error('Could not parse base URL from kiosk URL');
  }

  return {
    baseUrl: urlMatch[1],
    kk: kkMatch[1],
  };
}

/**
 * Builds the REST API endpoint URL for fetching kiosk data.
 *
 * @param {string} baseUrl
 * @param {string} kk
 * @returns {string}
 */
function buildApiUrl(baseUrl, kk) {
  return `${baseUrl}/rest/pvms/web/kiosk/v1/station-kiosk-file?kk=${kk}`;
}

/**
 * Fetches JSON data from the FusionSolar Kiosk REST API.
 *
 * @param {string} apiUrl
 * @returns {Promise<Object>}
 */
function fetchKioskData(apiUrl) {
  return new Promise((resolve, reject) => {
    const transport = apiUrl.startsWith('https') ? https : http;

    const req = transport.get(
      apiUrl,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Homey/FusionSolarKiosk',
        },
        timeout: 15000,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }

          try {
            // The FusionSolar Kiosk API embeds a JSON string inside the outer JSON,
            // with double-encoded HTML entities. The pattern is:
            //   {"success":true,"data":"{&quot;realKpi&quot;:{...}}"}
            //
            // Strategy:
            //   1. Replace &quot; with \" so the outer JSON stays valid.
            //   2. Parse the outer JSON.
            //   3. If data is a string, parse it as inner JSON.
            //
            // NOTE: replacing &quot; → " (unescaped) on the whole string would
            // break the outer JSON structure – that was the previous bug.
            const clean = raw
              .replace(/&quot;/g, '\\"')
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>');

            const outer = JSON.parse(clean);

            if (outer.success === false) {
              reject(new Error(`API error: ${outer.failCode || 'unknown'}`));
              return;
            }

            // Flatten nested data field
            let merged = { ...outer };
            if (typeof outer.data === 'string') {
              try {
                const inner = JSON.parse(outer.data);
                merged = { ...outer, ...inner };
              } catch (_) { /* keep outer if inner parse fails */ }
            } else if (outer.data && typeof outer.data === 'object') {
              merged = { ...outer, ...outer.data };
            }

            resolve(merged);
          } catch (err) {
            reject(new Error(`Failed to parse response: ${err.message}`));
          }
        });
      },
    );

    req.on('error', (err) => reject(new Error(`Network error: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

/**
 * Extracts normalised KPI values from raw kiosk data.
 *
 * @param {Object} data
 * @returns {{
 *   realTimePower: number,    // W  – current generation power
 *   dailyEnergy: number,      // kWh
 *   monthEnergy: number,      // kWh
 *   yearEnergy: number,       // kWh
 *   cumulativeEnergy: number  // kWh
 * }}
 */
function extractKpiValues(data) {
  const kpi = data.realKpi || data.stationOverview || {};

  const num = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  };

  // realTimePower is reported in kW – convert to W for Homey's measure_power capability
  const realTimePowerKw = num(kpi.realTimePower ?? kpi.activePower ?? 0);

  return {
    realTimePower: Math.round(realTimePowerKw * 1000),
    dailyEnergy: num(kpi.dailyEnergy ?? kpi.dayPower ?? 0),
    monthEnergy: num(kpi.monthEnergy ?? kpi.monthPower ?? 0),
    yearEnergy: num(kpi.yearEnergy ?? kpi.yearPower ?? 0),
    cumulativeEnergy: num(kpi.cumulativeEnergy ?? kpi.totalPower ?? 0),
  };
}

module.exports = { parseKioskUrl, buildApiUrl, fetchKioskData, extractKpiValues };
