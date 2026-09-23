import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SAFE_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function projectFile(projectRoot, relativePath) {
  const root = path.resolve(projectRoot);
  const absolutePath = path.resolve(root, relativePath);
  if (absolutePath === root || !absolutePath.startsWith(`${root}${path.sep}`)) {
    throw new Error(`QA 实现指纹路径越界: ${relativePath}`);
  }
  const stat = fs.lstatSync(absolutePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`QA 实现指纹只接受普通文件: ${relativePath}`);
  }
  return absolutePath;
}

function runtimeJavaScriptFiles(projectRoot, relativeDirectory) {
  const root = path.resolve(projectRoot);
  const directory = path.resolve(root, relativeDirectory);
  if (directory === root || !directory.startsWith(`${root}${path.sep}`)) {
    throw new Error(`QA 运行时目录路径越界: ${relativeDirectory}`);
  }
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`QA 运行时目录必须是普通目录: ${relativeDirectory}`);
  }

  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`QA 运行时树不允许符号链接: ${path.relative(root, absolutePath)}`);
      }
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        files.push(path.relative(root, absolutePath).split(path.sep).join('/'));
      }
    }
  };
  visit(directory);
  return files;
}

export function buildQaImplementationEvidence({
  projectRoot,
  schemaVersion,
  relativeFiles,
  runtimeDirectories,
}) {
  const runtimeFiles = runtimeDirectories.flatMap((relativeDirectory) =>
    runtimeJavaScriptFiles(projectRoot, relativeDirectory));
  const allFiles = [...new Set([...relativeFiles, ...runtimeFiles])].sort();
  const files = Object.fromEntries(allFiles.map((relativePath) => [
    relativePath,
    sha256(fs.readFileSync(projectFile(projectRoot, relativePath))),
  ]));
  const fingerprintSource = Object.entries(files)
    .map(([relativePath, digest]) => `${relativePath}\0${digest}\n`)
    .join('');
  return {
    schemaVersion,
    nodeVersion: process.version,
    packageLockSha256: files['package-lock.json'] ?? null,
    fingerprintSha256: sha256(fingerprintSource),
    runtimeFileCount: runtimeFiles.length,
    files,
  };
}

export function createPrivateQaRunRoot(parentDirectory, prefix) {
  if (!path.isAbsolute(parentDirectory)) {
    throw new Error('QA 验收父目录必须使用绝对路径');
  }
  if (!SAFE_PART.test(String(prefix || ''))) {
    throw new Error('QA 验收目录前缀必须使用安全标识符');
  }

  const parent = path.resolve(parentDirectory);
  const parentExisted = fs.existsSync(parent);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error('QA 验收父目录必须是非符号链接目录');
  }
  if (!parentExisted) {
    fs.chmodSync(parent, 0o700);
  }

  const root = fs.mkdtempSync(path.join(parent, prefix));
  fs.chmodSync(root, 0o700);
  return root;
}

export function createQaRunId(date = new Date()) {
  const timestamp = date.toISOString().replace(/[^0-9]/gu, '').slice(0, 17);
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

export function immutableQaPath(
  directory,
  baseName,
  runId,
  extension,
) {
  for (const value of [baseName, runId, extension]) {
    if (!SAFE_PART.test(String(value || ''))) {
      throw new Error('QA 回执路径必须使用安全标识符');
    }
  }
  return path.join(directory, `${baseName}.${runId}.${extension}`);
}

export function writeImmutableQaFile(filePath, content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  fs.writeFileSync(filePath, bytes, {
    flag: 'wx',
    mode: 0o600,
  });
  fs.chmodSync(filePath, 0o600);
  return {
    path: filePath,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
