import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

test('keeps the approved TuyuLove brand and decentralization copy', () => {
  assert.match(app, />TUYULOVE</);
  assert.doesNotMatch(app, />TUYU</);
  assert.match(app, /tuyu-wordmark-zh\.png/);
  assert.match(app, /让生意，/);
  assert.match(app, /彼此连接，不被集中/);
  assert.match(app, /实时库存与订单，留在商家自己的主机/);
  assert.match(app, /商品、价格、库存与发货，由厂家自己管理/);
  assert.match(styles, /--green: #008255/);
});

test('preserves reserved merchant endpoints without exposing unavailable downloads', () => {
  assert.match(app, /https:\/\/download\.tuyulove\.com\/macos/);
  assert.match(app, /https:\/\/download\.tuyulove\.com\/windows/);
  assert.match(app, /https:\/\/download\.tuyulove\.com\/linux/);
  assert.match(app, /data-download-endpoint/);
  assert.match(app, /iOS[\s\S]*尚未发布/);
  assert.match(app, /Android[\s\S]*尚未发布/);
  assert.doesNotMatch(app, /apps\.apple\.com|play\.google\.com/);
});

test('ships every first-party visual asset referenced by the approved design', () => {
  for (const name of [
    'tuyu-logo.png',
    'tuyu-wordmark-zh.png',
    'hero-hikers.webp',
    'journey-lake.webp',
    'journey-phone.webp',
    'journey-cafe.webp',
    'journey-town.webp',
    'decentralized-merchant.webp',
    'decentralized-factory.webp',
  ]) {
    assert.equal(
      existsSync(new URL(`../public/assets/${name}`, import.meta.url)),
      true,
      `missing public/assets/${name}`,
    );
  }
});
