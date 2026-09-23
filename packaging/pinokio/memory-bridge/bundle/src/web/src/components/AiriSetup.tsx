import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Clipboard,
  ExternalLink,
  PlugZap,
  Terminal,
} from 'lucide-react';
import { api } from '../api';
import type { ServiceConfig } from '../types';

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function AiriSetup({
  onToast,
}: {
  onToast: (message: string, error?: boolean) => void;
}) {
  const [config, setConfig] = useState<ServiceConfig | null>(null);
  const [copied, setCopied] = useState('');

  useEffect(() => {
    api
      .config()
      .then(setConfig)
      .catch((error: unknown) =>
        onToast(
          error instanceof Error ? error.message : '读取接入配置失败',
          true,
        ),
      );
  }, [onToast]);

  const mcpConfig = useMemo(() => {
    if (!config) return '';
    return JSON.stringify(
      {
        mcpServers: {
          'memory-bridge': {
            command: config.nodePath,
            args: [
              `${config.projectDir}/dist/server/mcp-stdio.js`,
            ],
            env: {
              MEMORY_BRIDGE_DATA_DIR: config.dataDir,
              MEMORY_BRIDGE_USER_ID: config.userId,
              MEMORY_BRIDGE_NAMESPACE: config.defaultNamespace,
              MEMORY_BRIDGE_SEMANTIC_MODE: config.semanticMode,
              MEMORY_BRIDGE_OLLAMA_URL: config.ollamaBaseUrl,
              MEMORY_BRIDGE_EMBED_MODEL: config.embeddingModel,
              MEMORY_BRIDGE_QUERY_MODEL: config.queryModel,
              MEMORY_BRIDGE_RERANK_MODEL: config.rerankModel,
              MEMORY_BRIDGE_MODEL_KEEP_ALIVE: config.modelKeepAlive,
              MEMORY_BRIDGE_FOREGROUND_QUIET_MS:
                String(config.foregroundQuietMs),
              MEMORY_BRIDGE_EXTRACTION_MODEL: config.extractionModel,
              MEMORY_BRIDGE_RELATION_MODEL: config.relationModel,
              MEMORY_BRIDGE_EXPLICIT_INTENT_MODEL:
                config.explicitIntentModel,
              MEMORY_BRIDGE_CONSOLIDATION_MODEL:
                config.consolidationModel,
              MEMORY_BRIDGE_REFLECTION_MODEL: config.reflectionModel,
            },
          },
        },
      },
      null,
      2,
    );
  }, [config]);

  const modelPullCommand = useMemo(() => {
    if (!config) return '';
    return [...new Set([
      config.compatChatModel,
      config.embeddingModel,
      config.queryModel,
      config.rerankModel,
      config.extractionModel,
      config.relationModel,
      config.explicitIntentModel,
      config.consolidationModel,
      config.reflectionModel,
    ])]
      .map((model) => `ollama pull ${shellQuote(model)}`)
      .join(' && ');
  }, [config]);

  const copy = async (key: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(key);
    window.setTimeout(() => setCopied(''), 1800);
  };

  return (
    <main className="page airi-page">
      <header className="page-header">
        <div>
          <h1>AIRI 接入</h1>
          <p>
            让 AIRI 通过本地生命周期代理自动召回和沉淀长期记忆；
            MCP 保留为兼容与人工管理接口。
          </p>
        </div>
        <a
          className="button secondary"
          href="https://airi.moeru.ai/docs/"
          target="_blank"
          rel="noreferrer"
        >
          AIRI 文档 <ExternalLink size={15} />
        </a>
      </header>

      <section className="setup-step">
        <span className="step-number">1</span>
        <div>
          <h2>构建可执行服务</h2>
          <p>
            在本项目目录安装依赖并构建。AIRI 聊天、embedding、
            查询理解、提取、关系判断、显式意图、巩固、反思和重排模型均按
            当前服务配置独立加载。
          </p>
          <div className="code-block">
            <Terminal size={17} />
            <code>npm install && npm run build</code>
            <button onClick={() => copy('build', 'npm install && npm run build')}>
              {copied === 'build' ? <Check size={16} /> : <Clipboard size={16} />}
            </button>
          </div>
          <div className="code-block">
            <Terminal size={17} />
            <code>{modelPullCommand || '正在读取模型配置…'}</code>
            <button
              disabled={!modelPullCommand}
              onClick={() =>
                copy('models', modelPullCommand)
              }
            >
              {copied === 'models' ? <Check size={16} /> : <Clipboard size={16} />}
            </button>
          </div>
          <div className="code-block">
            <Terminal size={17} />
            <code>MEMORY_BRIDGE_AUTOMATION_MODE=auto npm start</code>
            <button
              onClick={() =>
                copy(
                  'start-auto',
                  'MEMORY_BRIDGE_AUTOMATION_MODE=auto npm start',
                )
              }
            >
              {copied === 'start-auto'
                ? <Check size={16} />
                : <Clipboard size={16} />}
            </button>
          </div>
          <p>
            首次评估新模型或 namespace 时可省略
            <code> auto </code>变量进入 shadow 模式；shadow
            只生成待确认候选，不会自动升级为规范长期记忆。
          </p>
        </div>
      </section>

      <section className="setup-step">
        <span className="step-number">2</span>
        <div>
          <h2>在 AIRI 中添加 MCP Server</h2>
          <p>
            打开“设置 → 机体模块 → MCP”，添加本地服务器。可以逐项填写，也可以使用 JSON 编辑器。
          </p>
          <div className="config-block">
            <pre>{mcpConfig || '正在生成本机配置…'}</pre>
            <button
              disabled={!mcpConfig}
              onClick={() => copy('config', mcpConfig)}
            >
              {copied === 'config' ? <Check size={16} /> : <Clipboard size={16} />}
              {copied === 'config' ? '已复制' : '复制配置'}
            </button>
          </div>
        </div>
      </section>

      <section className="setup-step">
        <span className="step-number">3</span>
        <div>
          <h2>配置聊天模型与自动生命周期</h2>
          <p>
            把 AIRI 的 Ollama-compatible 模型设为下面的模型和
            Base URL。无需修改角色卡，也不要添加“请主动调用记忆
            工具”的提示；兼容代理会在回答前自动召回，在最终回复
            交付后异步提取。
          </p>
          <div className="code-block">
            <Terminal size={17} />
            <code>{config?.compatChatModel || '正在读取模型配置…'}</code>
            <button
              disabled={!config?.compatChatModel}
              onClick={() =>
                copy('airi-model', config?.compatChatModel || '')
              }
            >
              {copied === 'airi-model' ? <Check size={16} /> : <Clipboard size={16} />}
            </button>
          </div>
          <div className="code-block">
            <Terminal size={17} />
            <code>
              {config?.compatApiBaseUrl || '正在读取接入地址…'}
            </code>
            <button
              disabled={!config?.compatApiBaseUrl}
              onClick={() =>
                copy(
                  'airi-base-url',
                  config?.compatApiBaseUrl || '',
                )
              }
            >
              {copied === 'airi-base-url' ? <Check size={16} /> : <Clipboard size={16} />}
            </button>
          </div>
        </div>
      </section>

      <section className="setup-step setup-check">
        <span className="step-number"><PlugZap size={18} /></span>
        <div>
          <h2>最终联调标准</h2>
          <ol>
            <li>普通聊天自然提及稳定偏好，不说“请记住”。</li>
            <li>等待后台提取完成，新建空会话自然询问并正确召回。</li>
            <li>自然表达偏好已经改变，同一 UUID 追加版本并关闭旧版本。</li>
            <li>再开新会话，只回答新值，不把旧值当作当前事实。</li>
            <li>自然要求遗忘，完整重启 AIRI、忆桥和 Ollama 后仍无法召回。</li>
          </ol>
          <p className="warning-note">
            自动闭环的代理日志应为 memoryAliasCount=0、
            toolCallCount=0，同时 SQLite 必须出现对应 recall、
            turn、candidate、version、evidence 与 tombstone。
            验收数据只能写入隔离库，正式数据库最终必须为空。
          </p>
        </div>
      </section>
    </main>
  );
}
