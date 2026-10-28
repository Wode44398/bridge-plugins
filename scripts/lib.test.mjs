import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex, serializeIndex, signIndex, verifyIndex, checkPlugin, zipPlugin, listZip } from './lib.mjs';

const ver = (version) => ({ version, engines: { bridge: '>=6.74' }, restart: false, url: `u/${version}`, sha256: 'a', size: 1, date: '2026-10-28', notes: 'n' });

test('buildIndex：版本新的在前，顶层字段正确', () => {
  const idx = buildIndex({ foo: [ver('1.0.0'), ver('1.10.0'), ver('1.2.0')] }, { seq: 3, generatedAt: 'T', pluginsMeta: { foo: { name: '富' } } });
  assert.equal(idx.format, 1);
  assert.equal(idx.market, 'official');
  assert.equal(idx.seq, 3);
  assert.deepEqual(idx.plugins[0].versions.map((v) => v.version), ['1.10.0', '1.2.0', '1.0.0']);
  assert.equal(idx.plugins[0].name, '富');
  assert.equal(idx.plugins[0].builtin, false);
  assert.match(idx.plugins[0].homepage, /plugins\/foo$/);
});

test('签名往返：能验过，篡改后验不过', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const bytes = serializeIndex(buildIndex({}, { seq: 1, generatedAt: 'T' }));
  const sigText = signIndex(bytes, pem, 'official-2026-10');
  assert.equal(JSON.parse(sigText).keyId, 'official-2026-10');
  assert.ok(verifyIndex(bytes, sigText, spki));
  assert.ok(!verifyIndex(Buffer.concat([bytes, Buffer.from(' ')]), sigText, spki));
});

const plugin = (over = {}, market = {}) => ({
  dirName: 'foo', errors: [],
  manifest: { id: 'foo', version: '1.0.0', engines: { bridge: '>=6.74' }, ...over },
  market: { notes: { '1.0.0': 'x' }, ...market },
});

test('checkPlugin：基础与 builtin 上界判定', () => {
  assert.deepEqual(checkPlugin(plugin()), []);
  assert.ok(checkPlugin(plugin({ id: 'Foo' })).length);
  assert.ok(checkPlugin(plugin({ id: 'bar' })).some((s) => s.includes('目录名')));
  assert.ok(checkPlugin(plugin({ version: '1.0' })).length);
  assert.ok(checkPlugin(plugin({ engines: {} })).length);
  assert.ok(checkPlugin(plugin({}, { notes: {} })).length);
  assert.ok(checkPlugin(plugin({}, { builtin: true })).some((s) => s.includes('上界')));
  assert.deepEqual(checkPlugin(plugin({ engines: { bridge: '>=6.74 <6.75' } }, { builtin: true })), []);
  assert.deepEqual(checkPlugin(plugin({ engines: { bridge: '~6.74' } }, { builtin: true })), []);
});

test('zipPlugin：根上直接是 bridge-plugin.json，排除 market.json / 测试文件', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-test-'));
  try {
    const dir = path.join(tmp, 'foo');
    fs.mkdirSync(path.join(dir, 'web'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'bridge-plugin.json'), '{}');
    fs.writeFileSync(path.join(dir, 'index.mjs'), '');
    fs.writeFileSync(path.join(dir, 'market.json'), '{}');
    fs.writeFileSync(path.join(dir, 'a.test.mjs'), '');
    fs.writeFileSync(path.join(dir, 'web', 'index.html'), '');
    const out = path.join(tmp, 'foo-1.0.0.zip');
    zipPlugin(dir, out);
    const names = listZip(out).map((s) => s.replace(/\/$/, ''));
    assert.ok(names.includes('bridge-plugin.json'));
    assert.ok(names.includes('web/index.html'));
    assert.ok(!names.includes('market.json'));
    assert.ok(!names.includes('a.test.mjs'));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
