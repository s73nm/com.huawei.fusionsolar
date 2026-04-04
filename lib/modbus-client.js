'use strict';

const net = require('net');
const Modbus = require('jsmodbus');

const READ_DELAY_MS = 250;
const CONNECT_TIMEOUT_MS = 15000;
const RESPONSE_TIMEOUT_MS = 5000;

// Serialises all Modbus traffic to the same host:port so that multiple devices
// (e.g. SUN2000 + LUNA2000) sharing one SDongle never open concurrent connections.
const _hostQueue = new Map(); // key: "host:port" → Promise (tail of pending chain)

function withHostLock(host, port, fn) {
  const key = `${host}:${port}`;
  // Chain onto whatever is already queued; if the previous task failed, we still proceed.
  const next = (_hostQueue.get(key) ?? Promise.resolve()).then(fn, fn);
  // Store a non-rejecting tail so future tasks are not blocked by errors in earlier ones.
  _hostQueue.set(key, next.catch(() => {}));
  return next;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parses a raw Modbus response buffer into a typed value.
 *
 * @param {Buffer} buf
 * @param {string} dataType
 * @returns {number|string}
 */
function parseBuffer(buf, dataType) {
  switch (dataType) {
    case 'UINT16': return buf.readUInt16BE(0);
    case 'INT16':  return buf.readInt16BE(0);
    case 'UINT32': return buf.readUInt32BE(0);
    case 'INT32':  return buf.readInt32BE(0);
    case 'STRING': return buf.toString('ascii').replace(/\0/g, '').trim();
    case 'UINT64': {
      // 4 × 16-bit words (big-endian) → 64-bit unsigned integer
      // JS Numbers are safe up to 2^53; energy kWh values never exceed this.
      const high = buf.readUInt32BE(0);
      const low  = buf.readUInt32BE(4);
      return Number((BigInt(high) << 32n) | BigInt(low));
    }
    default: throw new Error(`Unsupported data type: ${dataType}`);
  }
}

/**
 * Iterates over a register map and reads each register from the client.
 * Non-fatal errors per register are swallowed; the value is set to null.
 *
 * @param {Object} registers  { name: [address, length, dataType, label, decimalPower] }
 * @param {Object} client     jsmodbus TCP client
 * @returns {Promise<Object>} { name: scaledValue | null }
 */
async function readRegisters(registers, client) {
  const result = {};

  for (const [name, [address, length, dataType, , decimalPower]] of Object.entries(registers)) {
    try {
      await delay(READ_DELAY_MS);
      const resp = await client.readHoldingRegisters(address, length);
      const buf = resp.response.body.valuesAsBuffer;
      let value = parseBuffer(buf, dataType);

      if (typeof value === 'number' && decimalPower !== 0) {
        value = value * Math.pow(10, decimalPower);
        value = Math.round(value * 1e4) / 1e4;
      }

      result[name] = value;
    } catch {
      result[name] = null;
    }
  }

  return result;
}

/**
 * Opens a Modbus TCP connection, reads the given registers, then closes.
 * Calls are serialised per host:port so concurrent device polls never race.
 *
 * @param {string} host
 * @param {number} port
 * @param {number} unitId
 * @param {Object} registers
 * @returns {Promise<Object>}
 */
function readModbusRegisters(host, port, unitId, registers) {
  return withHostLock(host, port, async () => {
    try {
      return await _connect(host, port, unitId, (client) => readRegisters(registers, client));
    } catch (err) {
      // Huawei inverters/SDongles occasionally reject the first TCP connection.
      // One automatic retry after a short pause is enough to recover reliably.
      await delay(1500);
      return _connect(host, port, unitId, (client) => readRegisters(registers, client));
    }
  });
}

function _connect(host, port, unitId, fn) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const client = new Modbus.client.TCP(socket, unitId, RESPONSE_TIMEOUT_MS);
    socket.setKeepAlive(false);

    const connectTimeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Connection to ${host}:${port} timed out`));
    }, CONNECT_TIMEOUT_MS);

    socket.on('connect', async () => {
      clearTimeout(connectTimeout);
      try {
        await delay(500);
        const result = await fn(client);
        socket.end();
        resolve(result);
      } catch (err) {
        socket.destroy();
        reject(err);
      }
    });

    socket.on('error', (err) => {
      clearTimeout(connectTimeout);
      reject(new Error(`Socket error: ${err.message}`));
    });

    socket.connect({ host, port });
  });
}

/**
 * Writes a single 16-bit register value via Modbus TCP.
 * Serialised through the same per-host lock as reads.
 *
 * @param {string} host
 * @param {number} port
 * @param {number} unitId
 * @param {number} address   Register address
 * @param {number} value     16-bit integer value to write
 * @returns {Promise<void>}
 */
function writeModbusRegister(host, port, unitId, address, value) {
  return withHostLock(host, port, () => _connect(host, port, unitId, (client) => client.writeSingleRegister(address, value)));
}

module.exports = { readModbusRegisters, writeModbusRegister };
