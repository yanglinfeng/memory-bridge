#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function argument(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : '';
  if (!value || value.startsWith('--')) throw new Error(`${name} 缺少值`);
  return path.resolve(value);
}

const appRoot = argument('--app-root');
const stateDir = argument('--state-dir');
const output = argument('--output');
const server = path.join(appRoot, 'dist', 'server', 'mcp-stdio.js');
if (!fs.existsSync(server)) throw new Error('尚未安装 MCP 服务');
const outputParent = path.dirname(output);
fs.mkdirSync(outputParent, { recursive: true, mode: 0o700 });
fs.chmodSync(outputParent, 0o700);
const config = {
  mcpServers: {
    'memory-bridge': {
      command: process.execPath,
      args: [server],
      env: {
        MEMORY_BRIDGE_DATA_DIR: path.join(stateDir, 'data'),
        MEMORY_BRIDGE_USER_ID: 'default',
        MEMORY_BRIDGE_NAMESPACE: 'personal',
        MEMORY_BRIDGE_SEMANTIC_MODE: 'required',
        MEMORY_BRIDGE_OLLAMA_URL: 'http://127.0.0.1:11434',
        MEMORY_BRIDGE_EMBED_MODEL: 'bge-m3:latest',
        MEMORY_BRIDGE_RERANK_MODEL: 'qwen2.5:14b',
        MEMORY_BRIDGE_QUERY_MODEL: 'qwen2.5:14b',
      },
    },
  },
};
const temporary = `${output}.tmp-${process.pid}`;
fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, {
  flag: 'wx',
  mode: 0o600,
});
fs.renameSync(temporary, output);
fs.chmodSync(output, 0o600);
console.log(JSON.stringify({ status: 'generated', output }));
