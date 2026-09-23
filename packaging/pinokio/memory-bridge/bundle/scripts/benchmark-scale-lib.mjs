import fs from 'node:fs';
import path from 'node:path';

export function parseScaleBenchmarkArgs(args) {
  const options = { receipt: '' };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== '--receipt') {
      throw new Error(`未知参数: ${argument}`);
    }
    const value = String(args[index + 1] || '').trim();
    if (!value || value.startsWith('--')) {
      throw new Error('--receipt 需要文件路径');
    }
    options.receipt = value;
    index += 1;
  }
  return options;
}

export function writeScaleBenchmarkReceipt(receiptPath, report) {
  const absolutePath = path.resolve(receiptPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(
      temporaryPath,
      `${JSON.stringify(report, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    fs.renameSync(temporaryPath, absolutePath);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // 临时文件可能尚未创建或已经完成 rename。
    }
    throw error;
  }
  return absolutePath;
}
