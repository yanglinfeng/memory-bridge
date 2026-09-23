import { useEffect, useState } from 'react';
import { ClipboardList } from 'lucide-react';
import { api } from '../api';
import type { AuditRecord } from '../types';

const ACTION_LABELS: Record<string, string> = {
  remember: '写入记忆',
  deduplicate: '合并重复记忆',
  update: '更新记忆',
  forget: '删除记忆',
  restore: '恢复记忆',
  recall: '召回记忆',
};

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(value));
}

export function AuditLog({
  onToast,
}: {
  onToast: (message: string, error?: boolean) => void;
}) {
  const [records, setRecords] = useState<AuditRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .audits()
      .then(setRecords)
      .catch((error: unknown) =>
        onToast(
          error instanceof Error ? error.message : '读取审计日志失败',
          true,
        ),
      )
      .finally(() => setLoading(false));
  }, [onToast]);

  return (
    <main className="page audit-page">
      <header className="page-header">
        <div>
          <h1>审计日志</h1>
          <p>每一次写入、修改、召回和删除都有可检查的操作记录。</p>
        </div>
      </header>
      {loading ? (
        <div className="center-message">正在读取审计日志…</div>
      ) : records.length ? (
        <div className="audit-table">
          <div className="audit-row audit-head">
            <span>时间</span>
            <span>操作</span>
            <span>记忆 ID</span>
            <span>详情</span>
          </div>
          {records.map((record) => (
            <div className="audit-row" key={record.id}>
              <time>{formatDate(record.createdAt)}</time>
              <strong>
                {ACTION_LABELS[record.action] || record.action}
              </strong>
              <code>{record.memoryId || '—'}</code>
              <pre>{JSON.stringify(record.detail, null, 2)}</pre>
            </div>
          ))}
        </div>
      ) : (
        <div className="page-empty">
          <ClipboardList size={46} strokeWidth={1.3} />
          <h2>还没有审计记录</h2>
          <p>记忆库发生真实操作后，记录会显示在这里。</p>
        </div>
      )}
    </main>
  );
}

