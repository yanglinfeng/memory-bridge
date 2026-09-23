import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Database,
  Download,
  FileUp,
  Plus,
  Search,
  SlidersHorizontal,
} from 'lucide-react';
import { api } from '../api';
import {
  KIND_LABELS,
  STATUS_LABELS,
  type Memory,
  type MemoryDetail,
  type MemoryKind,
  type MemoryStatus,
} from '../types';
import {
  MemoryEditor,
  type MemoryFormValue,
} from './MemoryEditor';
import { MemoryInspector } from './MemoryInspector';

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function MemoryLibrary({
  onToast,
}: {
  onToast: (message: string, error?: boolean) => void;
}) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<MemoryKind | ''>('');
  const [namespace, setNamespace] = useState('');
  const [scopeType, setScopeType] =
    useState<Memory['scopeType'] | ''>('');
  const [scopeKey, setScopeKey] = useState('');
  const [status, setStatus] = useState<MemoryStatus | ''>('');
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MemoryDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingMemory, setEditingMemory] = useState<Memory | null>(null);
  const [saving, setSaving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const memoryListRequestRevision = useRef(0);
  const detailRequestRevision = useRef(0);

  const clearSelection = useCallback(() => {
    selectedIdRef.current = null;
    detailRequestRevision.current += 1;
    setSelectedId(null);
    setDetail(null);
    setDetailLoading(false);
  }, []);

  const loadMemories = useCallback(async () => {
    const requestRevision = memoryListRequestRevision.current + 1;
    memoryListRequestRevision.current = requestRevision;
    setLoading(true);
    try {
      const result = await api.listMemories({
        query,
        kind,
        namespace,
        scopeType,
        scopeKey,
        status,
      });
      if (requestRevision !== memoryListRequestRevision.current) return;
      setMemories(result.items);
      setTotal(result.total);
      const currentSelectedId = selectedIdRef.current;
      if (
        currentSelectedId &&
        !result.items.some((memory) => memory.id === currentSelectedId)
      ) {
        clearSelection();
      }
    } catch (error) {
      if (requestRevision !== memoryListRequestRevision.current) return;
      onToast(
        error instanceof Error ? error.message : '读取记忆失败',
        true,
      );
    } finally {
      if (requestRevision === memoryListRequestRevision.current) {
        setLoading(false);
      }
    }
  }, [
    clearSelection,
    kind,
    namespace,
    onToast,
    query,
    scopeKey,
    scopeType,
    status,
  ]);

  useEffect(() => {
    const timer = window.setTimeout(loadMemories, 180);
    return () => window.clearTimeout(timer);
  }, [loadMemories]);

  const selectMemory = async (id: string) => {
    const requestRevision = detailRequestRevision.current + 1;
    detailRequestRevision.current = requestRevision;
    selectedIdRef.current = id;
    setSelectedId(id);
    setDetail(null);
    setDetailLoading(true);
    try {
      const nextDetail = await api.memory(id);
      if (requestRevision !== detailRequestRevision.current) return;
      setDetail(nextDetail);
    } catch (error) {
      if (requestRevision !== detailRequestRevision.current) return;
      onToast(
        error instanceof Error ? error.message : '读取详情失败',
        true,
      );
    } finally {
      if (requestRevision === detailRequestRevision.current) {
        setDetailLoading(false);
      }
    }
  };

  const openCreate = () => {
    setEditingMemory(null);
    setEditorOpen(true);
  };

  const openEdit = () => {
    if (!detail) return;
    setEditingMemory(detail.memory);
    setEditorOpen(true);
  };

  const saveMemory = async (value: MemoryFormValue) => {
    setSaving(true);
    try {
      if (editingMemory) {
        const updated = await api.updateMemory(editingMemory.id, value);
        onToast('记忆已更新');
        setEditorOpen(false);
        await loadMemories();
        await selectMemory(updated.id);
      } else {
        const result = await api.createMemory(value);
        onToast(
          result.deduplicated
            ? '发现重复内容，已合并到现有记忆'
            : '记忆已保存',
        );
        setEditorOpen(false);
        await loadMemories();
        await selectMemory(result.memory.id);
      }
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : '保存失败',
        true,
      );
    } finally {
      setSaving(false);
    }
  };

  const deleteMemory = async () => {
    if (!detail) return;
    if (!window.confirm('确定删除这条记忆吗？删除后可以在“已删除”筛选中恢复。')) {
      return;
    }
    try {
      await api.deleteMemory(detail.memory.id);
      onToast('记忆已移入已删除');
      clearSelection();
      await loadMemories();
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : '删除失败',
        true,
      );
    }
  };

  const restoreMemory = async () => {
    if (!detail) return;
    try {
      let decision = await api.restoreMemory(detail.memory.id);
      if (decision.status === 'requires_confirmation') {
        const conflictSummary = decision.conflicts
          .map((memory) => `“${memory.title}”`)
          .join('、');
        const confirmed = window.confirm(
          `恢复会与当前记忆 ${conflictSummary} 冲突。是否恢复旧记忆并替代当前值？`,
        );
        if (!confirmed) {
          onToast('已保留当前记忆，旧记忆仍处于已删除状态');
          return;
        }
        decision = await api.restoreMemory(
          detail.memory.id,
          'replace',
          decision.confirmationToken || undefined,
        );
      }
      onToast(
        decision.status === 'merged'
          ? '已与现有等价记忆合并'
          : '记忆已恢复',
      );
      await loadMemories();
      await selectMemory(decision.memory.id);
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : '恢复失败',
        true,
      );
    }
  };

  const refreshSelected = async (memoryId: string) => {
    await loadMemories();
    await selectMemory(memoryId);
  };

  const importFile = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text()) as unknown;
      if (
        !window.confirm(
          '完整恢复会用备份替换当前用户的记忆、关系、审计和幂等记录。确定继续吗？',
        )
      ) {
        return;
      }
      const result = await api.importBackup(payload);
      onToast(
        `已完整恢复 ${result.imported} 条记忆、${result.relationCount} 条关系和 ${result.auditCount} 条审计`,
      );
      await loadMemories();
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : '导入失败',
        true,
      );
    } finally {
      event.target.value = '';
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

  const hasFilters = Boolean(
    query || kind || namespace || scopeType || scopeKey || status,
  );

  return (
    <div className="memory-workspace">
      <main className="memory-main">
        <header className="filter-bar">
          <label className="search-field">
            <Search size={18} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索记忆内容、标签或来源"
            />
          </label>
          <select
            aria-label="类型"
            value={kind}
            onChange={(event) =>
              setKind(event.target.value as MemoryKind | '')
            }
          >
            <option value="">全部类型</option>
            {Object.entries(KIND_LABELS).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
          <input
            className="namespace-filter"
            aria-label="命名空间"
            value={namespace}
            onChange={(event) => setNamespace(event.target.value)}
            placeholder="命名空间"
          />
          <select
            aria-label="作用域类型"
            value={scopeType}
            onChange={(event) => {
              const next = event.target.value as Memory['scopeType'] | '';
              setScopeType(next);
              setScopeKey(next === 'personal' ? 'self' : '');
            }}
          >
            <option value="">全部作用域</option>
            <option value="personal">个人共享</option>
            <option value="role">Persona 私有</option>
            <option value="session">聊天私有</option>
            <option value="project">项目绑定</option>
          </select>
          <input
            className="scope-key-filter"
            aria-label="作用域 ID"
            value={scopeKey}
            onChange={(event) => setScopeKey(event.target.value)}
            placeholder={scopeType ? '稳定 scope ID' : '先选作用域'}
            disabled={!scopeType}
          />
          <select
            aria-label="状态"
            value={status}
            onChange={(event) =>
              setStatus(event.target.value as MemoryStatus | '')
            }
          >
            <option value="">全部状态</option>
            {Object.entries(STATUS_LABELS).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
          <button
            className="icon-button"
            type="button"
            aria-label="清除筛选"
            title="清除筛选"
            disabled={!hasFilters}
            onClick={() => {
              setQuery('');
              setKind('');
              setNamespace('');
              setScopeType('');
              setScopeKey('');
              setStatus('');
            }}
          >
            <SlidersHorizontal size={18} />
          </button>
        </header>

        <section className="memory-content">
          {loading ? (
            <div className="center-message">正在读取记忆库…</div>
          ) : memories.length ? (
            <>
              <header className="list-heading">
                <span>共 {total} 条记忆</span>
                <div>
                  <button
                    className="text-button"
                    onClick={() => fileInput.current?.click()}
                  >
                    <FileUp size={15} />导入
                  </button>
                  <button className="text-button" onClick={exportBackup}>
                    <Download size={15} />备份
                  </button>
                  <button className="button primary small" onClick={openCreate}>
                    <Plus size={16} />新建记忆
                  </button>
                </div>
              </header>
              <div className="memory-list" role="list">
                {memories.map((memory) => (
                  <button
                    className={`memory-row ${
                      selectedId === memory.id ? 'selected' : ''
                    }`}
                    key={memory.id}
                    onClick={() => selectMemory(memory.id)}
                    role="listitem"
                  >
                    <span className={`kind-marker kind-${memory.kind}`} />
                    <span className="memory-row-main">
                      <strong>{memory.title}</strong>
                      <small>{memory.content}</small>
                    </span>
                    <span className="memory-row-meta">
                      <small>{KIND_LABELS[memory.kind]}</small>
                      <small>
                        {memory.namespace} ·
                        {' '}{memory.scopeType}/{memory.scopeKey}
                      </small>
                    </span>
                    <span className={`status-text status-${memory.status}`}>
                      {STATUS_LABELS[memory.status]}
                    </span>
                    <time>{formatDate(memory.updatedAt)}</time>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="empty-library">
              <Database size={58} strokeWidth={1.35} />
              <h1>
                {hasFilters ? '没有符合条件的记忆' : '还没有长期记忆'}
              </h1>
              <p>
                {hasFilters
                  ? '调整搜索条件，或者清除当前筛选。'
                  : '长期记忆用于 AIRI 跨会话保留稳定事实、偏好与项目决定。'}
              </p>
              {!hasFilters && (
                <div>
                  <button className="button primary" onClick={openCreate}>
                    <Plus size={17} />新建记忆
                  </button>
                  <button
                    className="button secondary"
                    onClick={() => fileInput.current?.click()}
                  >
                    <FileUp size={17} />导入
                  </button>
                </div>
              )}
            </div>
          )}
        </section>
        <input
          ref={fileInput}
          className="visually-hidden"
          type="file"
          accept="application/json,.json"
          onChange={importFile}
        />
      </main>

      <MemoryInspector
        detail={detail}
        loading={detailLoading}
        onEdit={openEdit}
        onDelete={deleteMemory}
        onRestore={restoreMemory}
        onClose={clearSelection}
        onChanged={refreshSelected}
        onToast={onToast}
      />
      <MemoryEditor
        open={editorOpen}
        memory={editingMemory}
        saving={saving}
        onClose={() => setEditorOpen(false)}
        onSave={saveMemory}
      />
    </div>
  );
}
