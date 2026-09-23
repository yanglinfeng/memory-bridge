import {
  Bot,
  BrainCircuit,
  Check,
  CircleAlert,
  Clock3,
  FileClock,
  LoaderCircle,
  MessageCirclePlus,
  PanelRightOpen,
  Plus,
  RefreshCw,
  SendHorizonal,
  Sparkles,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { api } from '../api';
import type {
  Conversation,
  ConversationMessage,
  ConversationStreamEvent,
  LocalChatWorkspace,
  Memory,
  ServiceConfig,
} from '../types';

type ConversationStage =
  | 'idle'
  | 'accepted'
  | 'recalling'
  | 'generating'
  | 'completed'
  | 'failed';

interface ConversationView {
  messages: ConversationMessage[];
  loading: boolean;
  loaded: boolean;
  streaming: string;
  stage: ConversationStage;
  error: string | null;
}

const EMPTY_VIEW: ConversationView = {
  messages: [],
  loading: false,
  loaded: false,
  streaming: '',
  stage: 'idle',
  error: null,
};

function formatTime(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function conversationLabel(conversation: Conversation): string {
  return conversation.title?.trim() ||
    conversation.lastMessagePreview?.trim().slice(0, 26) ||
    '未命名对话';
}

function stageCopy(stage: ConversationStage, error: string | null): {
  label: string;
  detail: string;
} {
  if (stage === 'accepted') {
    return { label: '消息已接收', detail: '正在建立本轮处理上下文。' };
  }
  if (stage === 'recalling') {
    return {
      label: '正在检索相关记忆',
      detail: '服务端正在按当前会话的授权范围检索，不在浏览器中拼接记忆。',
    };
  }
  if (stage === 'generating') {
    return {
      label: '本地模型正在回复',
      detail: '回答由当前服务端配置的 Ollama 模型流式生成。',
    };
  }
  if (stage === 'completed') {
    return {
      label: '本轮已完成',
      detail: '用户消息和回复已保存；长期记忆提炼在后台异步处理。',
    };
  }
  if (stage === 'failed') {
    return { label: '本轮未完成', detail: error || '服务端未能完成本轮对话。' };
  }
  return { label: '等待输入', detail: '新的会话从空数据开始；不会预填演示内容。' };
}

function relevantMemories(
  memories: readonly Memory[],
  conversationId: string,
  personaId: string,
): Memory[] {
  return memories.filter((memory) =>
    memory.scopeType === 'personal' ||
    (memory.scopeType === 'role' && memory.scopeKey === personaId) ||
    (memory.scopeType === 'session' && memory.scopeKey === conversationId)
  ).slice(0, 6);
}

function memoryScope(memory: Memory): string {
  if (memory.scopeType === 'personal') return '个人共享';
  if (memory.scopeType === 'role') return '本地助手';
  if (memory.scopeType === 'session') return '当前会话';
  return '项目';
}

function eventError(event: ConversationStreamEvent): string | null {
  if (event.type !== 'turn.failed') return null;
  return typeof event.data.message === 'string'
    ? event.data.message
    : '服务端未完成本轮对话';
}

export function ChatWorkspace({
  onToast,
}: {
  onToast: (message: string, error?: boolean) => void;
}) {
  const [workspace, setWorkspace] = useState<LocalChatWorkspace | null>(null);
  const [config, setConfig] = useState<ServiceConfig | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [openConversationIds, setOpenConversationIds] = useState<string[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [views, setViews] = useState<Record<string, ConversationView>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const endOfMessages = useRef<HTMLDivElement | null>(null);

  const activeConversation = useMemo(
    () => conversations.find((item) => item.id === activeConversationId) || null,
    [activeConversationId, conversations],
  );
  const activeView = activeConversationId
    ? views[activeConversationId] || EMPTY_VIEW
    : EMPTY_VIEW;

  const refreshMemories = useCallback(async (
    conversationId: string,
    personaId: string,
  ) => {
    try {
      const result = await api.listMemories({});
      setMemories(relevantMemories(result.items, conversationId, personaId));
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : '读取记忆状态失败',
        true,
      );
    }
  }, [onToast]);

  const refreshConversations = useCallback(async (personaId: string) => {
    const result = await api.listConversations(personaId);
    setConversations(result.items);
    return result.items;
  }, []);

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    try {
      const [nextWorkspace, nextConfig] = await Promise.all([
        api.bootstrapLocalChatWorkspace(),
        api.config(),
      ]);
      const nextConversations = await refreshConversations(
        nextWorkspace.persona.personaId,
      );
      setWorkspace(nextWorkspace);
      setConfig(nextConfig);
      setOpenConversationIds((current) =>
        current.filter((id) => nextConversations.some((item) => item.id === id)),
      );
      setActiveConversationId((current) =>
        current && nextConversations.some((item) => item.id === current)
          ? current
          : null,
      );
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : '初始化本地聊天工作台失败',
        true,
      );
    } finally {
      setLoading(false);
    }
  }, [onToast, refreshConversations]);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  const loadMessages = useCallback(async (conversationId: string) => {
    setViews((current) => ({
      ...current,
      [conversationId]: {
        ...(current[conversationId] || EMPTY_VIEW),
        loading: true,
        error: null,
      },
    }));
    try {
      const result = await api.conversationMessages(conversationId);
      setViews((current) => ({
        ...current,
        [conversationId]: {
          ...(current[conversationId] || EMPTY_VIEW),
          messages: result.items,
          loading: false,
          loaded: true,
          streaming: '',
        },
      }));
    } catch (error) {
      setViews((current) => ({
        ...current,
        [conversationId]: {
          ...(current[conversationId] || EMPTY_VIEW),
          loading: false,
          error: error instanceof Error ? error.message : '读取对话失败',
        },
      }));
    }
  }, []);

  useEffect(() => {
    if (!activeConversationId || activeView.loaded) return;
    void loadMessages(activeConversationId);
  }, [activeConversationId, activeView.loaded, loadMessages]);

  useEffect(() => {
    if (!activeConversation || !workspace) return;
    void refreshMemories(activeConversation.id, workspace.persona.personaId);
  }, [activeConversation, refreshMemories, workspace]);

  useEffect(() => {
    endOfMessages.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [activeConversationId, activeView.messages, activeView.streaming]);

  const openConversation = useCallback((conversationId: string) => {
    setOpenConversationIds((current) =>
      current.includes(conversationId) ? current : [...current, conversationId],
    );
    setActiveConversationId(conversationId);
  }, []);

  const createConversation = async () => {
    if (!workspace || creating) return;
    setCreating(true);
    try {
      const created = await api.createConversation({
        idempotencyKey: crypto.randomUUID(),
        personaId: workspace.persona.personaId,
        title: '新对话',
      });
      setConversations((current) => [
        created,
        ...current.filter((item) => item.id !== created.id),
      ]);
      setViews((current) => ({
        ...current,
        [created.id]: { ...EMPTY_VIEW, loaded: true },
      }));
      openConversation(created.id);
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : '创建新对话失败',
        true,
      );
    } finally {
      setCreating(false);
    }
  };

  const closeConversation = (conversationId: string) => {
    setOpenConversationIds((current) => {
      const next = current.filter((id) => id !== conversationId);
      setActiveConversationId((active) =>
        active === conversationId ? next.at(-1) || null : active,
      );
      return next;
    });
  };

  const updateStage = useCallback((conversationId: string, event: ConversationStreamEvent) => {
    setViews((current) => {
      const view = current[conversationId] || EMPTY_VIEW;
      if (event.type === 'assistant.delta') {
        const delta = typeof event.data.delta === 'string' ? event.data.delta : '';
        return {
          ...current,
          [conversationId]: { ...view, streaming: view.streaming + delta, stage: 'generating' },
        };
      }
      if (event.type === 'turn.stage') {
        const stage = event.data.stage;
        const nextStage: ConversationStage =
          stage === 'recalling' || stage === 'generating'
            ? stage
            : stage === 'accepted' ? 'accepted' : view.stage;
        return { ...current, [conversationId]: { ...view, stage: nextStage } };
      }
      if (event.type === 'turn.accepted') {
        return { ...current, [conversationId]: { ...view, stage: 'accepted' } };
      }
      if (event.type === 'turn.completed') {
        return { ...current, [conversationId]: { ...view, stage: 'completed' } };
      }
      if (event.type === 'turn.failed' || event.type === 'turn.interrupted') {
        return {
          ...current,
          [conversationId]: {
            ...view,
            stage: 'failed',
            error: eventError(event) || '本轮对话已中断',
          },
        };
      }
      return current;
    });
  }, []);

  const sendMessage = async () => {
    if (!activeConversation || !workspace) return;
    const text = (drafts[activeConversation.id] || '').trim();
    if (!text || !['idle', 'completed', 'failed'].includes(activeView.stage)) return;
    const clientMessageId = crypto.randomUUID();
    const sentAt = new Date().toISOString();
    const optimistic: ConversationMessage = {
      id: `local-${clientMessageId}`,
      conversationId: activeConversation.id,
      sequence: activeView.messages.length + 1,
      role: 'user',
      displayContent: text,
      actions: [],
      attachments: [],
      status: 'completed',
      generationGroupId: null,
      variantIndex: 1,
      isActiveVariant: true,
      createdAt: sentAt,
      completedAt: sentAt,
      version: 1,
    };
    setDrafts((current) => ({ ...current, [activeConversation.id]: '' }));
    setViews((current) => ({
      ...current,
      [activeConversation.id]: {
        ...(current[activeConversation.id] || EMPTY_VIEW),
        messages: [...(current[activeConversation.id]?.messages || []), optimistic],
        streaming: '',
        stage: 'accepted',
        error: null,
      },
    }));
    if (activeConversation.messageCount === 0 && activeConversation.title === '新对话') {
      try {
        const renamed = await api.updateConversation(activeConversation.id, {
          expectedVersion: activeConversation.version,
          title: text.slice(0, 36),
        });
        setConversations((current) => current.map((item) =>
          item.id === renamed.id ? renamed : item
        ));
      } catch {
        // 标题更新失败不会影响权威的发消息流程。
      }
    }
    try {
      await api.streamConversationMessage(
        activeConversation.id,
        { clientMessageId, text, clientSentAt: sentAt },
        async (event) => updateStage(activeConversation.id, event),
      );
      await Promise.all([
        loadMessages(activeConversation.id),
        refreshConversations(workspace.persona.personaId),
      ]);
      window.setTimeout(() => {
        void refreshMemories(activeConversation.id, workspace.persona.personaId);
      }, 1_200);
    } catch (error) {
      const message = error instanceof Error ? error.message : '消息发送失败';
      setViews((current) => ({
        ...current,
        [activeConversation.id]: {
          ...(current[activeConversation.id] || EMPTY_VIEW),
          stage: 'failed',
          error: message,
        },
      }));
      onToast(message, true);
    }
  };

  const onComposerKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  };

  if (loading) {
    return <main className="chat-workspace"><div className="chat-loading">正在准备本地聊天工作台…</div></main>;
  }

  const stage = stageCopy(activeView.stage, activeView.error);
  const activeTabs = openConversationIds
    .map((id) => conversations.find((item) => item.id === id))
    .filter((item): item is Conversation => Boolean(item));
  const modelLabel = config?.compatChatModel || 'qwen2.5:14b';

  return (
    <main className="chat-workspace">
      <aside className="chat-list-panel">
        <div className="chat-list-heading">
          <div>
            <span>本地对话</span>
            <small>{workspace ? workspace.profile.displayName : '本地助手'}</small>
          </div>
          <button className="chat-icon-button" onClick={() => void createConversation()} disabled={creating} aria-label="新建对话">
            {creating ? <LoaderCircle className="spin" size={18} /> : <Plus size={18} />}
          </button>
        </div>
        <button className="chat-new-button" onClick={() => void createConversation()} disabled={creating}>
          <MessageCirclePlus size={18} />新建对话
        </button>
        <div className="chat-list-scroll" aria-label="对话列表">
          {conversations.length === 0 ? (
            <div className="chat-list-empty">
              <MessageCirclePlus size={22} />
              <strong>还没有对话</strong>
              <span>点击“新建对话”开始，首次不会写入演示数据。</span>
            </div>
          ) : conversations.map((conversation) => (
            <button
              className={`chat-list-item ${activeConversationId === conversation.id ? 'selected' : ''}`}
              key={conversation.id}
              onClick={() => openConversation(conversation.id)}
            >
              <span className="chat-list-item-title">{conversationLabel(conversation)}</span>
              <time>{formatTime(conversation.lastMessageAt || conversation.createdAt)}</time>
              <small>{conversation.lastMessagePreview || '空白对话'}</small>
            </button>
          ))}
        </div>
      </aside>

      <section className="chat-main-panel">
        <div className="chat-tabs" role="tablist" aria-label="已打开的聊天窗口">
          {activeTabs.map((conversation) => (
            <div className={`chat-tab ${activeConversationId === conversation.id ? 'active' : ''}`} key={conversation.id}>
              <button role="tab" aria-selected={activeConversationId === conversation.id} onClick={() => openConversation(conversation.id)}>
                <Bot size={15} />{conversationLabel(conversation)}
              </button>
              <button className="chat-tab-close" onClick={() => closeConversation(conversation.id)} aria-label={`关闭 ${conversationLabel(conversation)}`}>
                <X size={14} />
              </button>
            </div>
          ))}
          <button className="chat-tab-add" onClick={() => void createConversation()} disabled={creating} aria-label="新建并打开对话"><Plus size={18} /></button>
        </div>

        {activeConversation ? (
          <>
            <header className="chat-conversation-header">
              <div>
                <h1>{conversationLabel(activeConversation)}</h1>
                <span><BrainCircuit size={14} />{workspace?.profile.displayName || '本地助手'} · 多窗口独立会话</span>
              </div>
              <button className="chat-header-status" onClick={() => workspace && void refreshMemories(activeConversation.id, workspace.persona.personaId)}>
                <span />{modelLabel} · 本机运行
              </button>
            </header>
            <div className="chat-message-scroll">
              {activeView.loading && activeView.messages.length === 0 ? (
                <div className="chat-loading">正在读取对话…</div>
              ) : activeView.messages.length === 0 && !activeView.streaming ? (
                <div className="chat-empty-state">
                  <BrainCircuit size={34} />
                  <h2>从这里开始聊</h2>
                  <p>这是一个空白会话。消息将由本机 {modelLabel} 回复，忆桥会在服务端按需召回并异步整理长期记忆。</p>
                </div>
              ) : (
                <div className="chat-message-list">
                  {activeView.messages.map((message) => (
                    <article className={`chat-message ${message.role}`} key={message.id}>
                      <div className="chat-avatar" aria-hidden="true">{message.role === 'assistant' ? '忆' : '你'}</div>
                      <div className="chat-message-body">
                        <p>{message.displayContent}</p>
                        <time>{formatTime(message.createdAt)}</time>
                      </div>
                    </article>
                  ))}
                  {activeView.streaming && (
                    <article className="chat-message assistant streaming">
                      <div className="chat-avatar" aria-hidden="true">忆</div>
                      <div className="chat-message-body"><p>{activeView.streaming}</p><span className="typing-dot" /></div>
                    </article>
                  )}
                </div>
              )}
              <div ref={endOfMessages} />
            </div>
            <div className="chat-composer-wrap">
              <label className="chat-composer">
                <textarea
                  value={drafts[activeConversation.id] || ''}
                  onChange={(event) => setDrafts((current) => ({ ...current, [activeConversation.id]: event.target.value }))}
                  onKeyDown={onComposerKeyDown}
                  placeholder="输入消息，Enter 发送；Shift + Enter 换行"
                  disabled={!['idle', 'completed', 'failed'].includes(activeView.stage)}
                  rows={3}
                />
                <div className="chat-composer-footer">
                  <span><Sparkles size={14} />长期记忆由服务端处理</span>
                  <button onClick={() => void sendMessage()} disabled={!drafts[activeConversation.id]?.trim() || !['idle', 'completed', 'failed'].includes(activeView.stage)} aria-label="发送消息">
                    <SendHorizonal size={18} />发送
                  </button>
                </div>
              </label>
            </div>
          </>
        ) : (
          <div className="chat-start-state">
            <div><BrainCircuit size={36} /><h1>打开一个本地聊天窗口</h1><p>新建对话后即可直接使用本机 {modelLabel}，没有预置聊天记录。</p><button className="chat-new-button" onClick={() => void createConversation()} disabled={creating}><Plus size={18} />新建对话</button></div>
          </div>
        )}
      </section>

      <aside className="chat-memory-panel">
        <header><div><PanelRightOpen size={17} /><h2>记忆状态</h2></div><button onClick={() => activeConversation && workspace && void refreshMemories(activeConversation.id, workspace.persona.personaId)} aria-label="刷新记忆状态"><RefreshCw size={15} /></button></header>
        {activeConversation ? <div className="chat-memory-scroll">
          <section className={`chat-stage-card ${activeView.stage}`}>
            {activeView.stage === 'failed' ? <CircleAlert size={19} /> : activeView.stage === 'completed' ? <Check size={19} /> : activeView.stage === 'idle' ? <Clock3 size={19} /> : <LoaderCircle className="spin" size={19} />}
            <div><strong>{stage.label}</strong><p>{stage.detail}</p></div>
          </section>
          <section className="chat-memory-section">
            <div className="chat-section-title"><span>当前可见记忆</span><small>{memories.length} 条</small></div>
            {memories.length === 0 ? <div className="chat-memory-empty"><FileClock size={20} /><strong>尚无可展示记忆</strong><p>忆桥不会把每一句闲聊强行保存。稳定事实、偏好或重复习惯会在后台通过安全门禁后沉淀。</p></div> : <div className="chat-memory-items">
              {memories.map((memory) => <article key={memory.id} className="chat-memory-item"><div><span>{memoryScope(memory)}</span><time>{formatTime(memory.updatedAt)}</time></div><strong>{memory.title || memory.content}</strong><p>{memory.summary || memory.content}</p></article>)}
            </div>}
          </section>
          <section className="chat-scope-note"><Sparkles size={16} /><p>本窗口与其他窗口拥有独立会话边界；个人共享记忆和本地助手角色记忆会在服务端按权限参与召回。</p></section>
        </div> : <div className="chat-memory-placeholder"><BrainCircuit size={26} /><p>打开对话后显示本窗口的真实处理状态和可见记忆。</p></div>}
      </aside>
    </main>
  );
}
