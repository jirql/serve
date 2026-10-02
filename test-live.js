// 标准 VLESS/Trojan over WS 端到端测试 (与 xray/mihomo 线上格式一致)
// 用法: node test-live.js [host]   默认 www.jirql.dpdns.org, 传 localhost 测本地
const WebSocket = require('ws');
const crypto = require('crypto');

const UUID = process.env.UUID;
if (!UUID) { console.error('用法: UUID=<节点UUID> node test-live.js [host]'); process.exit(1); }
const HOST = process.argv[2] || 'www.jirql.dpdns.org';
const WSPATH = UUID.replace(/-/g, '').slice(0, 8);
const SCHEME = HOST.startsWith('localhost') ? 'ws' : 'wss';

// 官方 VLESS 请求: [ver][uuid16][addon_len=0][cmd][port2][atyp][addr][payload]
function vlessReq(cmd, target, port, payload) {
  const idBuf = Buffer.from(UUID.replace(/-/g, ''), 'hex');
  const tBuf = Buffer.from(target);
  return Buffer.concat([
    Buffer.from([0]), idBuf, Buffer.from([0, cmd]),
    Buffer.from([port >> 8, port & 0xff]),
    Buffer.from([0x02, tBuf.length]), tBuf,
    payload || Buffer.alloc(0),
  ]);
}

// xray Trojan 请求: [sha224(uuid)][\r\n][cmd=0x01][atyp][addr][port2][\r\n][payload]
function trojanReq(target, port, payload) {
  const hash = Buffer.from(crypto.createHash('sha224').update(UUID).digest('hex'));
  const tBuf = Buffer.from(target);
  return Buffer.concat([
    hash, Buffer.from('\r\n'), Buffer.from([0x01]),
    Buffer.from([0x03, tBuf.length]), tBuf, Buffer.from([port >> 8, port & 0xff]), Buffer.from('\r\n'),
    payload || Buffer.alloc(0),
  ]);
}

const HTTP_REQ = Buffer.from('GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n');

function testVless() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${SCHEME}://${HOST}/${WSPATH}`, { headers: { Host: HOST } });
    const t = setTimeout(() => { console.log('VLESS: ❌ 超时'); resolve(false); }, 12000);
    let acked = false;
    ws.on('open', () => ws.send(vlessReq(1, 'example.com', 80, HTTP_REQ)));
    ws.on('message', (data) => {
      if (!acked) {
        if (data.length >= 2 && data[0] === 0 && data[1] === 0) {
          console.log('VLESS: ✅ ACK', data.toString('hex')); acked = true;
        } else { console.log('VLESS: ❌ 异常响应', data.toString('hex').slice(0, 40)); clearTimeout(t); ws.close(); resolve(false); return; }
        return;
      }
      const text = data.toString('utf8');
      console.log('VLESS: ✅ 回包', text.split('\r\n')[0]);
      clearTimeout(t); ws.close(); resolve(text.includes('200'));
    });
    ws.on('unexpected-response', (r, res) => { console.log('VLESS: ❌ 升级被拒 HTTP', res.statusCode); clearTimeout(t); resolve(false); });
    ws.on('error', (e) => { console.log('VLESS: ❌', e.message); clearTimeout(t); resolve(false); });
  });
}

function testTrojan() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${SCHEME}://${HOST}/${WSPATH}`, { headers: { Host: HOST } });
    const t = setTimeout(() => { console.log('Trojan: ❌ 超时'); resolve(false); }, 12000);
    ws.on('open', () => ws.send(trojanReq('example.com', 80, HTTP_REQ)));
    ws.on('message', (data) => {
      // xray Trojan 无握手响应, 首条消息即隧道数据
      const text = data.toString('utf8');
      console.log('Trojan: ✅ 回包', text.split('\r\n')[0]);
      clearTimeout(t); ws.close(); resolve(text.includes('200'));
    });
    ws.on('unexpected-response', (r, res) => { console.log('Trojan: ❌ 升级被拒 HTTP', res.statusCode); clearTimeout(t); resolve(false); });
    ws.on('error', (e) => { console.log('Trojan: ❌', e.message); clearTimeout(t); resolve(false); });
  });
}

(async () => {
  console.log(`目标: ${SCHEME}://${HOST}/${WSPATH}`);
  const a = await testVless();
  const b = await testTrojan();
  process.exit(a && b ? 0 : 1);
})();
