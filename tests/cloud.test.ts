import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudBackend } from '../src/storage/cloud';
import * as db from '../src/storage/db';
import { createMemoryBackend } from '../src/storage/memory';
import { FakeAssets, FakeCloud } from './fake-cloud';
import { makeItem } from './helpers';

const UID = 'u_abcdefghijklmnopqrstuv';

async function setup() {
  const cloud = new FakeCloud();
  const assets = new FakeAssets();
  const backend = new CloudBackend(cloud, assets, UID, assets.fetcher);
  await backend.init();
  return { cloud, assets, backend };
}

const png = (n = 64) => new Blob([new Uint8Array(n).fill(7)], { type: 'image/png' });

test('云端：单品写入后能完整读回，undefined 字段被去掉，数据放在用户私有路径下', async () => {
  const { cloud, backend } = await setup();
  const item = { ...makeItem('top', 'T恤', '#232326'), fit: undefined, brand: undefined };
  await backend.putMany('items', [item]);
  const back = await backend.getAll<typeof item>('items');
  assert.equal(back.length, 1);
  assert.equal(back[0].name, item.name);
  assert.ok(!('fit' in back[0]) && !('brand' in back[0]));
  for (const path of cloud.docs.keys()) {
    assert.ok(path.startsWith(`data/users/${UID}/w/`), path);
    assert.equal(path.split('/').length % 2, 0, `文档路径应为偶数段：${path}`);
  }
});

test('云端：超过一页的集合会分页读全', async () => {
  const { backend } = await setup();
  const rows = Array.from({ length: 1234 }, (_, i) => ({ id: `rec-${String(i).padStart(5, '0')}`, date: '2026-01-01', n: i }));
  await backend.putMany('records', rows);
  const back = await backend.getAll<{ id: string }>('records');
  assert.equal(back.length, 1234);
  assert.equal(new Set(back.map((r) => r.id)).size, 1234);
});

test('云端：连续修改同一个设置只写入最后的值，同一文档从不并发写入', async () => {
  const { cloud, backend } = await setup();
  const writesBefore = cloud.writes;
  await Promise.all([1, 2, 3, 4, 5, 6].map((t) => backend.setKV('today', { tempC: t })));
  assert.deepEqual(await backend.getKV('today'), { tempC: 6 });
  assert.ok(cloud.writes - writesBefore <= 2, `写入了 ${cloud.writes - writesBefore} 次`);
  await Promise.all([
    backend.putMany('items', [{ id: 'a', v: 1 }]),
    backend.putMany('items', [{ id: 'a', v: 2 }]),
    backend.putMany('items', [{ id: 'a', v: 3 }]),
  ]);
  assert.equal(cloud.maxInflight, 1);
  assert.equal((await backend.getAll<{ v: number }>('items'))[0].v, 3);
});

test('云端：图片上传后用平台地址显示，能取回原始数据，删除时一并删除文件', async () => {
  const { assets, backend } = await setup();
  await backend.putImages([{ id: 'img-1', blob: png(100), width: 40, height: 50 }]);
  assert.equal(assets.files.size, 1);
  const src = await backend.imageSrc('img-1');
  assert.ok(src && src.url.startsWith('/_blob/') && !src.revoke);
  const got = await backend.getImage('img-1');
  assert.equal(got?.blob.size, 100);
  assert.equal(got?.width, 40);
  await backend.deleteImages(['img-1']);
  assert.equal(assets.files.size, 0);
  assert.equal(await backend.imageSrc('img-1'), undefined);
});

test('云端：另一台设备打开时能读到同一份单品和图片', async () => {
  const cloud = new FakeCloud();
  const assets = new FakeAssets();
  const phone = new CloudBackend(cloud, assets, UID, assets.fetcher);
  await phone.init();
  await phone.putImages([{ id: 'img-a', blob: png(), width: 10, height: 10 }]);
  await phone.putMany('items', [makeItem('bottom', '牛仔裤', '#506f94', { id: 'it-1' })]);
  await phone.setKV('settings', { rotation: false });

  const laptop = new CloudBackend(cloud, assets, UID, assets.fetcher);
  await laptop.init();
  assert.equal((await laptop.getAll('items')).length, 1);
  assert.deepEqual(await laptop.getKV('settings'), { rotation: false });
  assert.ok((await laptop.imageSrc('img-a'))?.url.startsWith('/_blob/'));

  // 别人的账号看不到
  const stranger = new CloudBackend(cloud, assets, 'u_someoneelse0000000000', assets.fetcher);
  await stranger.init();
  assert.equal((await stranger.getAll('items')).length, 0);
  assert.equal(await stranger.imageSrc('img-a'), undefined);
});

test('云端：上传中途失败时，已上传但没有索引的文件会被清理，错误信息是中文', async () => {
  const { assets, backend } = await setup();
  assets.failUploadsAfter = 1;
  await assert.rejects(
    backend.putImages([
      { id: 'img-1', blob: png(), width: 1, height: 1 },
      { id: 'img-2', blob: png(), width: 1, height: 1 },
    ]),
    /云端存储空间已满/,
  );
  // 第一张已建立索引，保留；第二张没有上传成功
  assert.equal(assets.files.size, 1);
  assert.ok(await backend.imageSrc('img-1'));
  assert.equal(await backend.imageSrc('img-2'), undefined);
});

test('云端：网络临时错误自动重试一次', async () => {
  const { cloud, backend } = await setup();
  cloud.failWrites.push({ code: 'unavailable' });
  await backend.putMany('outfits', [{ id: 'o1', name: 'x' }]);
  assert.equal((await backend.getAll('outfits')).length, 1);
  cloud.failWrites.push({ code: 'quota_exceeded' });
  await assert.rejects(backend.putMany('outfits', [{ id: 'o2' }]), /空间已满/);
});

test('云端：清空所有数据会删除单品、记录、设置和图片文件', async () => {
  const { cloud, assets, backend } = await setup();
  await backend.putImages([{ id: 'img-1', blob: png(), width: 1, height: 1 }]);
  await backend.putMany('items', [{ id: 'a' }, { id: 'b' }]);
  await backend.putMany('records', [{ id: 'r' }]);
  await backend.setKV('settings', { x: 1 });
  await backend.clearAll();
  assert.equal(cloud.docs.size, 0);
  assert.equal(assets.files.size, 0);
  assert.equal(await backend.getKV('settings'), undefined);
});

test('存储入口：示例衣橱的图片不会写入存储，也不会被删除', async () => {
  const mem = createMemoryBackend();
  db.useBackend(mem, { mode: 'memory', hosted: false });
  await db.putMany('images', [
    { id: 'demo:tee:232326:640', blob: png(), width: 1, height: 1 },
    { id: 'img-real', blob: png(), width: 1, height: 1 },
  ]);
  assert.equal(await db.getOne('images', 'demo:tee:232326:640'), undefined);
  assert.ok(await db.getOne('images', 'img-real'));
  await db.deleteMany('images', ['demo:tee:232326:640', 'img-real']);
  assert.equal(await db.getOne('images', 'img-real'), undefined);
});
