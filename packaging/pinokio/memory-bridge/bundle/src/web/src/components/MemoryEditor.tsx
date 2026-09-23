import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import {
  KIND_LABELS,
  type Memory,
  type MemoryKind,
} from '../types';

export interface MemoryFormValue {
  title: string;
  content: string;
  summary: string;
  namespace: string;
  kind: MemoryKind;
  tags: string[];
  importance: number;
  confidence: number;
  source: string;
}

const EMPTY_VALUE: MemoryFormValue = {
  title: '',
  content: '',
  summary: '',
  namespace: 'personal',
  kind: 'knowledge',
  tags: [],
  importance: 0.5,
  confidence: 0.8,
  source: 'manual',
};

function toFormValue(memory?: Memory | null): MemoryFormValue {
  if (!memory) return EMPTY_VALUE;
  return {
    title: memory.title,
    content: memory.content,
    summary: memory.summary,
    namespace: memory.namespace,
    kind: memory.kind,
    tags: memory.tags,
    importance: memory.importance,
    confidence: memory.confidence,
    source: memory.source,
  };
}

export function MemoryEditor({
  open,
  memory,
  saving,
  onClose,
  onSave,
}: {
  open: boolean;
  memory?: Memory | null;
  saving: boolean;
  onClose: () => void;
  onSave: (value: MemoryFormValue) => Promise<void>;
}) {
  const [value, setValue] = useState<MemoryFormValue>(
    toFormValue(memory),
  );
  const [tagsText, setTagsText] = useState(
    (memory?.tags || []).join(', '),
  );

  useEffect(() => {
    setValue(toFormValue(memory));
    setTagsText((memory?.tags || []).join(', '));
  }, [memory, open]);

  if (!open) return null;

  const update = <Key extends keyof MemoryFormValue>(
    key: Key,
    next: MemoryFormValue[Key],
  ) => setValue((current) => ({ ...current, [key]: next }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const tags = tagsText
      .split(/[,，]/)
      .map((tag) => tag.trim())
      .filter(Boolean);
    await onSave({ ...value, tags });
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="memory-editor-title"
      >
        <header className="modal-header">
          <div>
            <h2 id="memory-editor-title">
              {memory ? '编辑记忆' : '新建记忆'}
            </h2>
            <p>只保存跨会话仍然有价值、可以独立理解的信息。</p>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <form className="memory-form" onSubmit={submit}>
          <label className="field field-wide">
            <span>记忆内容</span>
            <textarea
              value={value.content}
              onChange={(event) => update('content', event.target.value)}
              placeholder="写成脱离当前对话也能理解的完整事实"
              rows={5}
              required
              autoFocus
            />
          </label>
          <label className="field field-wide">
            <span>标题</span>
            <input
              value={value.title}
              onChange={(event) => update('title', event.target.value)}
              placeholder="留空时自动取内容第一行"
              maxLength={100}
            />
          </label>
          <label className="field field-wide">
            <span>摘要</span>
            <textarea
              value={value.summary}
              onChange={(event) => update('summary', event.target.value)}
              placeholder="可选，用于快速理解这条记忆"
              rows={2}
              maxLength={500}
            />
          </label>
          <label className="field">
            <span>类型</span>
            <select
              value={value.kind}
              onChange={(event) =>
                update('kind', event.target.value as MemoryKind)
              }
            >
              {Object.entries(KIND_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>命名空间</span>
            <input
              value={value.namespace}
              onChange={(event) =>
                update('namespace', event.target.value)
              }
              placeholder="personal"
              required
            />
          </label>
          <label className="field field-wide">
            <span>标签</span>
            <input
              value={tagsText}
              onChange={(event) => setTagsText(event.target.value)}
              placeholder="使用逗号分隔，例如 AIRI, 长期记忆"
            />
          </label>
          <label className="field">
            <span>
              重要度 <b>{value.importance.toFixed(2)}</b>
            </span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={value.importance}
              onChange={(event) =>
                update('importance', Number(event.target.value))
              }
            />
          </label>
          <label className="field">
            <span>
              置信度 <b>{value.confidence.toFixed(2)}</b>
            </span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={value.confidence}
              onChange={(event) =>
                update('confidence', Number(event.target.value))
              }
            />
          </label>
          <footer className="modal-footer field-wide">
            <button
              type="button"
              className="button secondary"
              onClick={onClose}
            >
              取消
            </button>
            <button
              type="submit"
              className="button primary"
              disabled={saving || !value.content.trim()}
            >
              {saving ? '正在保存…' : memory ? '保存修改' : '保存记忆'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

