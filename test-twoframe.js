// 模拟 xray/mihomo 两帧模式: 先发纯握手帧(无payload), 等响应, 再发数据帧
// 用法: node test-twoframe.js [host] [vless|trojan]
const WebSocket = require('ws');
const crypto = require('crypto');
const UUID = process.env.UUID;
if (!UUID) { console.error('用法: UUID=<节点UUID> node test-twoframe.js [host] [vless|trojan]'); process.exit(1); }
const HOST = process.argv[2] || 'localhost:3997';
const PROTO = process.argv[3] || 'vless';
const SCHEME = HOST.startsWith('localhost') ? 'ws' : 'wss';
const WSPATH = UUID.replace(/-/g, '').slice(0, 8);

function vlessHeader(target, port) {
  const idBuf = Buffer.from(UUID.replace(/-/g, ''), 'hex');
  const tBuf = Buffer.from(target);
  return Buffer.concat([
    Buffer.from([0]), idBuf, Buffer.from([0, 1]),
    Buffer.from([port >> 8, port & 0xff]),
    Buffer.from([0x02, tBuf.length]), tBuf,
  ]);
}
function trojanHeader(target, port) {
  const hash = Buffer.from(crypto.createHash('sha224').update(UUID).digest('hex'));
  const tBuf = Buffer.from(target);
  return Buffer.concat([hash, Buffer.from('\r\n'), Buffer.from([0x01]), Buffer.from([0x03, tBuf.length]), tBuf, Buffer.from([port >> 8, port & 0xff]), Buffer.from('\r\n')]);
}

const ws = new WebSocket(`${SCHEME}://${HOST}/${WSPATH}`, { headers: { Host: HOST.split(':')[0] } });
let acked = false;
const t = setTimeout(() => { console.log('❌ 超时(两帧模式失败)'); process.exit(1); }, 10000);
ws.on('open', () => {
  console.log(`发送 ${PROTO} 纯握手帧...`);
  ws.send(PROTO === 'trojan' ? trojanHeader('example.com', 80) : vlessHeader('example.com', 80));
  if (PROTO === 'trojan') {
    // xray Trojan 无握手响应, 直接发第二帧
    setTimeout(() => { console.log('发送第二帧数据...'); ws.send(Buffer.from('GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n')); }, 200);
  }
});
ws.on('message', (data) => {
  if (!acked) {
    if (PROTO === 'trojan') {
      // 无 ACK: 首条消息即隧道数据
      acked = true;
      console.log('回包 ✅:', data.toString('utf8').split('\r\n')[0]);
      clearTimeout(t); ws.close(); process.exit(data.toString('utf8').includes('200') ? 0 : 1);
    }
    console.log('握手响应:', data.toString('hex'));
    const ok = data[0] === 0 && data[1] === 0;
    if (!ok) { console.log('❌ 握手失败'); clearTimeout(t); ws.close(); process.exit(1); }
    acked = true;
    console.log('ACK ✅, 发送第二帧数据...');
    ws.send(Buffer.from('GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n'));
    return;
  }
  console.log('回包 ✅:', data.toString('utf8').split('\r\n')[0]);
  clearTimeout(t); ws.close(); process.exit(0);
});
ws.on('error', (e) => { console.log('❌', e.message); process.exit(1); });
