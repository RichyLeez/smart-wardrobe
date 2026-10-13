// 设置：身材数据与搭配目标、推荐偏好、天气位置、备份与数据管理。

import { useEffect, useMemo, useState } from 'react';
import { BODY_FIELDS, DEFAULT_BODY, bodyRatios, suggestGoals, validateBody } from '../../core/body';
import { GOAL_HINTS, GOAL_LABELS } from '../../core/catalog';
import { emptyFeedback } from '../../core/recommend';
import type { BodyGoal, BodyProfile, Gender } from '../../core/types';
import { Field, Segmented, Switch } from '../components/Controls';
import { Icon } from '../components/Icon';
import { Mannequin } from '../components/Mannequin';
import { createDemoWardrobe, removeDemoData } from '../demo';
import { backupFilename, exportBackup, readBackup } from '../../storage/backup';
import { clearAll, requestPersistence, storageEstimate } from '../../storage/db';
import { saveFile } from '../../storage/hosted';
import { useStore } from '../store';
import { useUI } from '../ui';

const GOALS: BodyGoal[] = ['lengthen_legs', 'balance_upper', 'balance_lower', 'define_waist'];
const GENDER_LABELS: Record<Gender, string> = { female: '女', male: '男', unspecified: '不填' };

function mb(n: number): string {
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function SettingsPage() {
  const store = useStore();
  const ui = useUI();
  const saved = store.settings.body;
  const [form, setForm] = useState<Record<string, string>>(() => {
    const b = saved ?? DEFAULT_BODY;
    return Object.fromEntries(BODY_FIELDS.map((f) => [f.key, saved ? String(b[f.key]) : '']));
  });
  const [gender, setGender] = useState<Gender>(saved?.gender ?? 'unspecified');
  const [busy, setBusy] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<Awaited<ReturnType<typeof storageEstimate>>>(null);
  const cloud = store.storage?.mode === 'cloud';
  const memory = store.storage?.mode === 'memory';

  useEffect(() => {
    storageEstimate().then(setEstimate);
  }, [store.items.length, store.records.length]);

  const parsed: BodyProfile | null = useMemo(() => {
    const vals = BODY_FIELDS.map((f) => Number(form[f.key]));
    if (vals.some((v) => !Number.isFinite(v) || v <= 0)) return null;
    const b = { gender } as BodyProfile;
    BODY_FIELDS.forEach((f, i) => (b[f.key] = vals[i]));
    return b;
  }, [form, gender]);
  const errors = parsed ? validateBody(parsed) : [];
  const preview = parsed && errors.length === 0 ? parsed : saved;
  const ratios = preview ? bodyRatios(preview) : null;
  const suggestions = preview ? suggestGoals(preview) : [];
  const dirty =
    parsed !== null &&
    (!saved || BODY_FIELDS.some((f) => saved[f.key] !== parsed[f.key]) || saved.gender !== parsed.gender);

  async function saveBody() {
    if (!parsed) return ui.toast('请把 6 项数据填完整');
    if (errors.length) return ui.toast(errors[0]);
    await store.updateSettings({ body: parsed });
    await requestPersistence();
    ui.toast('身材数据已保存');
  }

  async function toggleGoal(g: BodyGoal, on: boolean) {
    const base = store.goals;
    const goals = on ? [...base.filter((x) => x !== g), g] : base.filter((x) => x !== g);
    await store.updateSettings({ goals, goalsCustomized: true });
  }

  async function doExport() {
    setBusy('正在打包…');
    try {
      const blob = await exportBackup((d, t) => setBusy(`正在打包图片 ${d}/${t}`));
      setBusy('等待保存…');
      const saved = await saveFile(blob, backupFilename());
      ui.toast(saved ? `备份已导出（${mb(blob.size)}）` : '已取消导出');
    } catch (e) {
      ui.toast(e instanceof Error ? `导出失败：${e.message}` : '导出失败');
    } finally {
      setBusy(null);
    }
  }

  async function doImport(file: File | undefined) {
    if (!file) return;
    setBusy('正在读取备份…');
    try {
      const { summary, apply } = await readBackup(file);
      setBusy(null);
      const ok = await ui.confirm({
        title: '用这个备份替换当前数据？',
        body: `备份里有 ${summary.items} 件单品、${summary.outfits} 个套装、${summary.records} 条记录。${
          cloud ? '云端现有的数据会被全部替换，所有设备上都会生效。' : '当前设备上的数据会被全部替换。'
        }`,
        confirmText: '替换并恢复',
        danger: true,
      });
      if (!ok) return;
      setBusy('正在恢复…');
      await apply((d, t) => setBusy(cloud ? `正在上传图片 ${d}/${t}` : `正在恢复图片 ${d}/${t}`));
      await store.reload();
      ui.toast('已从备份恢复');
      ui.close();
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : '恢复失败');
    } finally {
      setBusy(null);
    }
  }

  async function loadDemo() {
    setBusy('正在生成示例衣橱…');
    try {
      await createDemoWardrobe((d, t) => setBusy(`正在生成示例衣橱 ${d}/${t}`));
      await store.reload();
      ui.toast('已载入示例衣橱');
    } finally {
      setBusy(null);
    }
  }

  async function clearDemo() {
    const n = await removeDemoData();
    await store.reload();
    ui.toast(n ? `已清除 ${n} 件示例单品及示例记录` : '没有示例数据');
  }

  async function wipe() {
    const ok = await ui.confirm({
      title: '清空所有数据？',
      body: cloud
        ? '单品、图片、套装、记录和身材数据都会从云端删除，所有设备上都会消失，无法恢复。建议先导出备份。'
        : '单品、图片、套装、记录和身材数据都会从这台设备上删除，无法恢复。建议先导出备份。',
      confirmText: '全部清空',
      danger: true,
    });
    if (!ok) return;
    setBusy('正在清空…');
    try {
      await clearAll();
      await store.reload();
      ui.toast('已清空');
    } catch (e) {
      ui.toast(e instanceof Error ? `没有全部清空：${e.message}` : '没有全部清空，请重试');
      return;
    } finally {
      setBusy(null);
    }
    ui.close();
  }

  const hasDemo = store.items.some((i) => i.demo) || store.records.some((r) => r.demo);

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="设置">
      <div className="overlay-inner">
        <header className="topbar">
          <button type="button" className="icon-btn" aria-label="返回" onClick={() => ui.close()}>
            <Icon name="back" />
          </button>
          <h1>设置</h1>
          <span style={{ width: 40 }} />
        </header>
        <div className="page">
          <section className="section" style={{ marginTop: 4 }}>
            <h2 className="section-title">
              身材数据 <small>单位 cm</small>
            </h2>
            <div className="body-preview">
              <div className="stage">
                <Mannequin body={preview} items={[]} label="按身材数据生成的人台" />
              </div>
              <div className="ratios">
                {ratios ? (
                  <>
                    <div>
                      <span>腿长占身高</span>
                      <b>{Math.round(ratios.legRatio * 100)}%</b>
                    </div>
                    <div>
                      <span>胸臀比</span>
                      <b>{ratios.chestHip.toFixed(2)}</b>
                    </div>
                    <div>
                      <span>腰臀比</span>
                      <b>{ratios.waistHip.toFixed(2)}</b>
                    </div>
                  </>
                ) : (
                  <span className="muted small">填写后人台会按你的比例变化，推荐也会参考这些比例。</span>
                )}
              </div>
            </div>
            <div className="body-grid" style={{ marginTop: 14 }}>
              {BODY_FIELDS.map((f) => (
                <label key={f.key}>
                  {f.label}
                  <span className="input-unit">
                    <input
                      className="input"
                      type="number"
                      inputMode="decimal"
                      min={f.min}
                      max={f.max}
                      placeholder={String(DEFAULT_BODY[f.key])}
                      value={form[f.key]}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [f.key]: e.target.value })}
                    />
                    <span>cm</span>
                  </span>
                  <span className="field-hint">{f.hint}</span>
                </label>
              ))}
            </div>
            <Field label="比例参考" hint="只用于判断比例偏离程度">
              <Segmented<Gender> options={['female', 'male', 'unspecified']} value={gender} labels={GENDER_LABELS} onChange={setGender} />
            </Field>
            {parsed && errors.length > 0 && <div className="warnbox">{errors[0]}</div>}
            <button type="button" className="btn btn-primary btn-block" style={{ marginTop: 10 }} disabled={!dirty} onClick={saveBody}>
              {saved && !dirty ? '已保存' : '保存身材数据'}
            </button>
          </section>

          <section className="section">
            <h2 className="section-title">
              搭配目标
              {store.settings.goalsCustomized && (
                <button type="button" className="btn btn-small btn-ghost" onClick={() => store.updateSettings({ goalsCustomized: false })}>
                  恢复建议
                </button>
              )}
            </h2>
            <p className="small muted" style={{ marginTop: 0 }}>
              这些是常见的穿搭经验，不是硬性规则。打开后推荐会参考对应的版型、长度和腰线。
            </p>
            <div className="panel">
              {GOALS.map((g) => {
                const s = suggestions.find((x) => x.goal === g);
                return (
                  <label className="goal" key={g}>
                    <span>
                      {GOAL_LABELS[g]}
                      {s && <span className="tag">建议</span>}
                    </span>
                    <span className="switch" style={{ minHeight: 0 }}>
                      <input type="checkbox" role="switch" checked={store.goals.includes(g)} onChange={(e: React.ChangeEvent<HTMLInputElement>) => toggleGoal(g, e.target.checked)} />
                    </span>
                    <small>{s ? s.reason : GOAL_HINTS[g]}</small>
                  </label>
                );
              })}
            </div>
          </section>

          <section className="section">
            <h2 className="section-title">推荐</h2>
            <div className="panel">
              <Switch
                label="优先轮换闲置单品"
                hint="最近穿过的降低优先级，很久没穿的提高优先级"
                checked={store.settings.rotation}
                onChange={(v) => store.updateSettings({ rotation: v })}
              />
              <div className="kv">
                <span>喜好记录 {Object.keys(store.feedback.pairs).length} 组</span>
                <button
                  type="button"
                  className="btn btn-small btn-ghost"
                  onClick={async () => {
                    await store.setFeedback(emptyFeedback());
                    ui.toast('已清除喜好记录');
                  }}
                >
                  清除
                </button>
              </div>
              {!store.storage?.hosted && (
              <div className="kv">
                <span>天气位置 {store.settings.location ? '已保存' : '未设置'}</span>
                {store.settings.location && (
                  <button type="button" className="btn btn-small btn-ghost" onClick={() => store.updateSettings({ location: undefined })}>
                    清除
                  </button>
                )}
              </div>
              )}
            </div>
          </section>

          <section className="section">
            <h2 className="section-title">
              数据{' '}
              <small>
                {estimate
                  ? cloud
                    ? `照片已用 ${mb(estimate.usage)}${estimate.quota ? ` / ${mb(estimate.quota)}` : ''}`
                    : `已用 ${mb(estimate.usage)}`
                  : ''}
              </small>
            </h2>
            <p className="small muted" style={{ marginTop: 0 }}>
              {cloud
                ? '单品、照片和记录保存在你的 Claude 账号下，只有你自己能看到。手机和电脑打开同一个链接，看到的是同一份衣橱。也可以随时导出一份完整备份留存。'
                : memory
                  ? '这个浏览器不允许保存数据，刷新页面后录入的内容会丢失。请换用普通浏览器窗口打开，或先导出备份。'
                  : '所有单品、照片和记录只保存在这个浏览器里。清除浏览器数据或更换设备前，请先导出备份。'}
              {!cloud && !memory && estimate && !estimate.persisted && ' 浏览器尚未把数据标记为持久保存，定期导出备份更稳妥。'}
            </p>
            {store.storage?.hosted && !cloud && store.storage.note && (
              <div className="warnbox" style={{ marginBottom: 10 }}>
                云端存储不可用：{store.storage.note}。现在的数据只保存在这个浏览器里。
              </div>
            )}
            <div style={{ display: 'grid', gap: 8 }}>
              <button type="button" className="btn" disabled={!!busy} onClick={doExport}>
                导出完整备份（.zip）
              </button>
              <label className="btn" aria-disabled={!!busy}>
                从备份恢复
                <input type="file" accept=".zip,application/zip" hidden onChange={(e: React.ChangeEvent<HTMLInputElement>) => doImport(e.target.files?.[0])} />
              </label>
              {hasDemo ? (
                <button type="button" className="btn" disabled={!!busy} onClick={clearDemo}>
                  清除示例数据
                </button>
              ) : (
                <button type="button" className="btn" disabled={!!busy} onClick={loadDemo}>
                  载入示例衣橱
                </button>
              )}
              <button type="button" className="btn btn-danger" disabled={!!busy} onClick={wipe}>
                清空所有数据
              </button>
              {busy && <p className="small muted">{busy}</p>}
            </div>
          </section>

          <section className="section small muted">
            <p>
              推荐完全在你的浏览器里用规则计算：配色、天气、场合、风格、身材目标、轮换和你的喜好七项打分，不调用任何 AI 服务。人台用于观察配色和比例，真实上身效果以照片为准。
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
