/**
 * 迁移步骤的共享上下文。
 *
 * version 由注册表推进：每个步骤负责把库结构迁移到自己的版本，
 * 但"当前版本号"的唯一写入者是 migrations/index.ts，避免各步骤各自记账。
 */
import type { DatabaseSync } from 'node:sqlite';

export interface MigrationContext {
  readonly database: DatabaseSync;
  /** 迁移开始时的版本（来自 sqlite user_version）。 */
  readonly fromVersion: number;
  /** 当前已迁移到的版本，由注册表推进。 */
  version: number;
}

export interface MigrationStep {
  /** 该步骤把库结构推进到的目标版本。 */
  readonly version: number;
  /** 人类可读说明，出错时便于定位。 */
  readonly label: string;
  /** 不受版本闸门限制，按数组顺序每次都执行。 */
  readonly always?: boolean;
  readonly apply: (context: MigrationContext) => void;
}
