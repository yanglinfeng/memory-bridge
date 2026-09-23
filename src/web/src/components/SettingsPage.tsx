import { useCallback, useEffect, useState } from 'react';
import {
  BrainCircuit,
  CalendarClock,
  Database,
  Download,
  LockKeyhole,
  Save,
} from 'lucide-react';
import { api } from '../api';
import {
  KIND_LABELS,
  type MemoryKind,
  type RetentionPolicy,
  type ServiceConfig,
} from '../types';

function parseOptionalDays(value: string): number | null {
  const trimmed = value.trim();
  return trimmed ? Number.parseInt(trimmed, 10) : null;
}

export function SettingsPage({
  onToast,
}: {
  onToast: (message: string, error?: boolean) => void;
}) {
  const [config, setConfig] = useState<ServiceConfig | null>(null);
  const [policies, setPolicies] = useState<RetentionPolicy[]>([]);
  const [namespace, setNamespace] = useState('');
  const [kind, setKind] = useState<MemoryKind | ''>('');
  const [evidenceTtlDays, setEvidenceTtlDays] = useState('');
  const [halfLifeDays, setHalfLifeDays] = useState('');
  const [autoArchive, setAutoArchive] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [nextConfig, nextPolicies] = await Promise.all([
        api.config(),
        api.retentionPolicies(),
      ]);
      setConfig(nextConfig);
      setPolicies(nextPolicies);
      setNamespace((current) => current || nextConfig.defaultNamespace);
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : '读取设置失败',
        true,
      );
    }
  }, [onToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const savePolicy = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!namespace.trim()) {
      onToast('命名空间不能为空', true);
      return;
    }
    setSaving(true);
    try {
      await api.saveRetentionPolicy({
        namespace: namespace.trim(),
        kind: kind || null,
        evidenceTtlDays: parseOptionalDays(evidenceTtlDays),
        halfLifeDays: parseOptionalDays(halfLifeDays),
        autoArchive,
      });
      onToast('保留策略已保存');
      await load();
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : '保存保留策略失败',
        true,
      );
    } finally {
      setSaving(false);
    }
  };

  const exportBackup = async () => {
    try {
      await api.downloadBackup();
      onToast('完整备份已导出');
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : '导出失败',
        true,
      );
    }
  };

  return (
    <main className="page settings-page">
      <header className="page-header">
        <div>
          <h1>设置</h1>
          <p>当前实例默认仅绑定本机地址，数据保存在你自己的电脑上。</p>
        </div>
      </header>
      <section className="settings-section">
        <header>
          <Database size={20} />
          <div>
            <h2>本地存储</h2>
            <p>SQLite 真相库、派生索引和审计日志使用同一数据目录。</p>
          </div>
        </header>
        <dl className="settings-list">
          <div><dt>数据目录</dt><dd><code>{config?.dataDir || '读取中…'}</code></dd></div>
          <div><dt>默认用户</dt><dd>{config?.userId || '—'}</dd></div>
          <div><dt>默认命名空间</dt><dd>{config?.defaultNamespace || '—'}</dd></div>
          <div><dt>HTTP 地址</dt><dd>{config ? `${config.host}:${config.port}` : '—'}</dd></div>
          <div><dt>自动化模式</dt><dd>{config?.automationMode || '—'}</dd></div>
        </dl>
        <button className="button secondary" onClick={exportBackup}>
          <Download size={16} />导出完整备份
        </button>
      </section>

      <section className="settings-section">
        <header>
          <BrainCircuit size={20} />
          <div>
            <h2>模型角色</h2>
            <p>开发验收统一使用本机 14B 模型，各角色后续可以独立替换。</p>
          </div>
        </header>
        <dl className="settings-list">
          <div><dt>AIRI 聊天</dt><dd><code>{config?.compatChatModel || '—'}</code></dd></div>
          <div><dt>查询理解</dt><dd><code>{config?.queryModel || '—'}</code></dd></div>
          <div><dt>自动提取</dt><dd><code>{config?.extractionModel || '—'}</code></dd></div>
          <div><dt>非破坏式巩固</dt><dd><code>{config?.consolidationModel || '—'}</code></dd></div>
          <div><dt>Embedding</dt><dd><code>{config?.embeddingModel || '—'}</code></dd></div>
          <div><dt>批量重排</dt><dd><code>{config?.rerankModel || '—'}</code></dd></div>
          <div><dt>模型常驻</dt><dd><code>{config?.modelKeepAlive || '—'}</code></dd></div>
          <div>
            <dt>前台安静窗口</dt>
            <dd>{config ? `${config.foregroundQuietMs} ms` : '—'}</dd>
          </div>
        </dl>
      </section>

      <section className="settings-section retention-section">
        <header>
          <CalendarClock size={20} />
          <div>
            <h2>保留与衰减策略</h2>
            <p>
              默认全部关闭：不抹除证据原文、不因时间自动归档。留空即永久保留，
              只有显式填写天数才会启用清理。Pin、档案和长期指令始终受保护。
            </p>
          </div>
        </header>
        <form className="retention-form" onSubmit={savePolicy}>
          <label className="field">
            <span>命名空间</span>
            <input
              value={namespace}
              onChange={(event) => setNamespace(event.target.value)}
              placeholder="default"
            />
          </label>
          <label className="field">
            <span>记忆类型</span>
            <select
              value={kind}
              onChange={(event) =>
                setKind(event.target.value as MemoryKind | '')}
            >
              <option value="">全部类型</option>
              {Object.entries(KIND_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>证据正文 TTL（天）</span>
            <input
              type="number"
              min="1"
              max="3650"
              value={evidenceTtlDays}
              onChange={(event) => setEvidenceTtlDays(event.target.value)}
              placeholder="留空 = 永不抹除"
            />
          </label>
          <label className="field">
            <span>低权重半衰期（天）</span>
            <input
              type="number"
              min="1"
              max="3650"
              value={halfLifeDays}
              onChange={(event) => setHalfLifeDays(event.target.value)}
              placeholder="留空 = 永不衰减"
            />
          </label>
          <label className="check-field">
            <input
              type="checkbox"
              checked={autoArchive}
              onChange={(event) => setAutoArchive(event.target.checked)}
            />
            <span>达到阈值后自动归档，不物理删除</span>
          </label>
          <button className="button primary" disabled={saving}>
            <Save size={16} />{saving ? '正在保存…' : '保存策略'}
          </button>
        </form>

        <div className="policy-list">
          {policies.length ? (
            policies.map((policy) => (
              <article key={policy.id}>
                <header>
                  <strong>
                    {policy.namespace} ·
                    {' '}{policy.kind ? KIND_LABELS[policy.kind] : '全部类型'}
                  </strong>
                  <span>{policy.autoArchive ? '自动归档' : '不自动归档'}</span>
                </header>
                <p>
                  证据 TTL：
                  {policy.evidenceTtlDays === null
                    ? '不抹除'
                    : `${policy.evidenceTtlDays} 天`}
                  {' · '}半衰期：
                  {policy.halfLifeDays === null
                    ? '不衰减'
                    : `${policy.halfLifeDays} 天`}
                </p>
              </article>
            ))
          ) : (
            <p className="panel-empty">
              尚未创建自定义策略：默认不衰减、不抹除证据，数据长期保留。
            </p>
          )}
        </div>
      </section>

      <section className="settings-section">
        <header>
          <LockKeyhole size={20} />
          <div>
            <h2>隐私边界</h2>
            <p>服务不会主动上传记忆，也不会自动收集浏览器或文件内容。</p>
          </div>
        </header>
        <ul className="privacy-list">
          <li>默认只监听 127.0.0.1，不向局域网或公网开放。</li>
          <li>AIRI 生命周期适配和 MCP 均在本机运行，不经过外部中转。</li>
          <li>普通删除可恢复；物理清除会擦除正文、证据、索引和派生摘要。</li>
          <li>用户自行导出的明文备份不受后续物理清除控制，应保存在可信位置。</li>
        </ul>
      </section>
    </main>
  );
}
