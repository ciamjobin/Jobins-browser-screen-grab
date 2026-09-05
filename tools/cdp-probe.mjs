// Throwaway harness: drives a real Chrome over CDP to see how the target pages lay out, and whether
// overriding the device metrics makes their content expand without scrolling.
import net from 'node:net';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.env.CDP_PORT || 9222);

function httpJson(path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`${path}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

class Ws {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.handlers = [];
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
  }

  drain() {
    for (;;) {
      if (this.buffer.length < 2) return;
      const second = this.buffer[1];
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (this.buffer.length < offset + length) return;
      const payload = this.buffer.subarray(offset, offset + length).toString('utf8');
      this.buffer = this.buffer.subarray(offset + length);
      for (const handler of this.handlers) handler(payload);
    }
  }

  send(text) {
    const payload = Buffer.from(text, 'utf8');
    const mask = crypto.randomBytes(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, 0x80 | payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0xfe;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0xff;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  onMessage(handler) {
    this.handlers.push(handler);
  }

  close() {
    this.socket.destroy();
  }
}

function connect(wsUrl) {
  const url = new URL(wsUrl);
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: url.hostname, port: Number(url.port) }, () => {
      const key = crypto.randomBytes(16).toString('base64');
      socket.write(
        `GET ${url.pathname}${url.search} HTTP/1.1\r\n` +
          `Host: ${url.host}\r\n` +
          'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    socket.once('error', reject);
    socket.once('data', (chunk) => {
      const text = chunk.toString('latin1');
      const end = text.indexOf('\r\n\r\n');
      if (!text.startsWith('HTTP/1.1 101')) return reject(new Error(text.slice(0, 120)));
      const ws = new Ws(socket);
      const rest = chunk.subarray(Buffer.byteLength(text.slice(0, end + 4), 'latin1'));
      if (rest.length) {
        ws.buffer = rest;
        ws.drain();
      }
      resolve(ws);
    });
  });
}

function makeClient(ws) {
  let nextId = 1;
  const pending = new Map();
  const events = [];
  ws.onMessage((text) => {
    const message = JSON.parse(text);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    } else if (message.method) {
      events.push(message.method);
    }
  });
  return {
    events,
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`${method} timed out`));
        }, 30000);
      });
    }
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MEASURE = `(() => {
  const de = document.documentElement, b = document.body;
  const scrollers = [...document.querySelectorAll('body *')]
    .map((el) => {
      const cs = getComputedStyle(el), r = el.getBoundingClientRect();
      return { el, cs, r };
    })
    .filter(({ el, cs, r }) =>
      /auto|scroll/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 4 &&
      el.clientHeight >= innerHeight * 0.3 && r.width >= innerWidth * 0.4)
    .map(({ el, r }) => ({
      tag: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''),
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      rectTop: Math.round(r.top)
    }));
  return {
    innerHeight, innerWidth,
    docScrollHeight: Math.max(de.scrollHeight, b ? b.scrollHeight : 0, de.offsetHeight, b ? b.offsetHeight : 0),
    bodyOverflow: getComputedStyle(b).overflowY,
    htmlOverflow: getComputedStyle(de).overflowY,
    scrollers
  };
})()`;

async function measure(client) {
  const { result } = await client.send('Runtime.evaluate', {
    expression: MEASURE,
    returnByValue: true
  });
  return result.value;
}

async function probe(url) {
  const target = await httpJson(`/json/new?${encodeURIComponent('about:blank')}`, 'PUT');
  const ws = await connect(target.webSocketDebuggerUrl);
  const client = makeClient(ws);
  try {
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Page.navigate', { url });
    for (let i = 0; i < 60 && !client.events.includes('Page.loadEventFired'); i += 1) await wait(250);
    await wait(3500);

    const before = await measure(client);
    const needed = (m) =>
      Math.max(m.docScrollHeight, ...m.scrollers.map((s) => s.rectTop + s.scrollHeight), m.innerHeight);

    console.log(`\n=== ${url}`);
    console.log(`  viewport ${before.innerWidth}x${before.innerHeight}  docScrollHeight ${before.docScrollHeight}`);
    console.log(`  inner scrollers: ${before.scrollers.length ? JSON.stringify(before.scrollers) : 'none'}`);

    let height = needed(before);
    let bestHeight = height;
    let previousOverflow = Infinity;
    let after = before;
    for (let round = 1; round <= 4; round += 1) {
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: before.innerWidth,
        height: Math.ceil(height),
        deviceScaleFactor: 0,
        mobile: false
      });
      await wait(900);
      after = await measure(client);
      const grown = needed(after);
      const overflow = grown - height;
      console.log(
        `  round ${round}: asked ${Math.ceil(height)} -> docScrollHeight ${after.docScrollHeight}, overflow ${Math.round(overflow)}`
      );
      bestHeight = height;
      if (overflow <= 4) break;
      // A residual that stops shrinking means something is sized to the viewport and will grow
      // forever; keep the last height that actually made progress.
      if (overflow >= previousOverflow - 4) break;
      previousOverflow = overflow;
      height = grown;
    }

    await client.send('Emulation.setDeviceMetricsOverride', {
      width: before.innerWidth,
      height: Math.ceil(bestHeight),
      deviceScaleFactor: 0,
      mobile: false
    });
    await wait(700);
    const shot = await client.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: before.innerWidth, height: Math.ceil(bestHeight), scale: 1 }
    });
    await client.send('Emulation.clearDeviceMetricsOverride');

    const png = Buffer.from(shot.data, 'base64');
    const file = `tools/probe-shots/${new URL(url).hostname}.png`;
    fs.mkdirSync('tools/probe-shots', { recursive: true });
    fs.writeFileSync(file, png);
    console.log(`  FINAL: ${png.readUInt32BE(16)}x${png.readUInt32BE(20)} px -> ${file}`);
  } finally {
    ws.close();
    await httpJson(`/json/close/${target.id}`).catch(() => {});
  }
}

const urls = process.argv.slice(2);
for (const url of urls) {
  await probe(url).catch((error) => console.log(`\n=== ${url}\n  FAILED: ${error.message}`));
}
