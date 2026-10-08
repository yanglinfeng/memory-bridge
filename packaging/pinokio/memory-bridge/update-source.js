const { createHash, randomUUID } = require("crypto")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { spawnSync } = require("child_process")

// package.json 的 name（npm 包名）。HTTP /api/health 的 service 身份字段是协议契约，
// 不随包名变化，故此处只校验包名。
const EXPECTED_PACKAGE = "mcp-memory-bridge"
const BUNDLE_MARKER = ".memory-bridge-source-bundle.json"
const REQUIRED_BUNDLE_FILES = [
  "package.json",
  "package-lock.json",
  path.join("scripts", "memory-bridge-lifecycle.mjs"),
  path.join("scripts", "memory-bridge-lifecycle-lib.mjs")
]
const REQUIRED_BUNDLE_DIRECTORIES = ["src", "scripts"]
const ALLOWED_SOURCE_ROOT_FILES = new Set([
  ".gitignore",
  BUNDLE_MARKER,
  "README.md",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.server.json",
  "vite.config.ts"
])
const ALLOWED_SOURCE_ROOT_DIRECTORIES = new Set(["src", "scripts"])
const EXCLUDED_NAMES = new Set([".DS_Store", "AGENTS.md"])

function readPackage(directory) {
  const packagePath = path.join(directory, "package.json")
  if (!fs.existsSync(packagePath)) throw new Error("更新源缺少 package.json")
  const value = JSON.parse(fs.readFileSync(packagePath, "utf8"))
  if (value.name !== EXPECTED_PACKAGE) {
    throw new Error(`更新源必须是 ${EXPECTED_PACKAGE}`)
  }
  return value
}

function isInside(parent, child) {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function sensitive(relative) {
  return relative.split(path.sep).some((part) =>
    part === ".env" || part.startsWith(".env.") || part === ".npmrc" ||
    part === "acceptance-secrets.json" || part === "secrets.json" ||
    part === "credentials.json" || part === "tokens.json" ||
    /\.(?:key|pem|p12|pfx)$/iu.test(part) ||
    /\.(?:sqlite|sqlite3|db)(?:-(?:wal|shm))?$/iu.test(part) ||
    /\.log$/iu.test(part)
  )
}

function allowedSourcePath(relative) {
  if (!relative) return true
  const parts = relative.split(path.sep)
  return ALLOWED_SOURCE_ROOT_DIRECTORIES.has(parts[0]) ||
    (parts.length === 1 && ALLOWED_SOURCE_ROOT_FILES.has(parts[0]))
}

function assertAllowedBundleTree(directory) {
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      const relative = path.relative(directory, absolute)
      if (
        entry.isSymbolicLink() ||
        (!entry.isDirectory() && !entry.isFile()) ||
        !allowedSourcePath(relative) ||
        relative.split(path.sep).some((part) => EXCLUDED_NAMES.has(part)) ||
        sensitive(relative)
      ) {
        throw new Error(`bundle 含非发布、私有或不安全路径：${relative}`)
      }
      if (entry.isDirectory()) visit(absolute)
    }
  }
  visit(directory)
}

function copyLocalSource(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: false,
    filter(candidate) {
      const relative = path.relative(source, candidate)
      if (!relative) return true
      const parts = relative.split(path.sep)
      if (!allowedSourcePath(relative)) return false
      if (parts.some((part) => EXCLUDED_NAMES.has(part))) return false
      if (sensitive(relative)) return false
      return !fs.lstatSync(candidate).isSymbolicLink()
    }
  })
}

function fingerprint(directory) {
  const hash = createHash("sha256")
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(current, entry.name)
      const relative = path.relative(directory, absolute)
      if (relative === BUNDLE_MARKER) continue
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile()) {
        hash.update(relative).update("\0").update(fs.readFileSync(absolute)).update("\n")
      }
    }
  }
  visit(directory)
  return hash.digest("hex")
}

function assertBundleStructure(directory) {
  for (const relative of REQUIRED_BUNDLE_FILES) {
    const candidate = path.join(directory, relative)
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
      throw new Error(`更新源结构缺少文件：${relative}`)
    }
  }
  for (const relative of REQUIRED_BUNDLE_DIRECTORIES) {
    const candidate = path.join(directory, relative)
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
      throw new Error(`更新源结构缺少目录：${relative}`)
    }
  }
}

function assertBundleOwnership(directory) {
  readPackage(directory)
  assertBundleStructure(directory)
  const markerPath = path.join(directory, BUNDLE_MARKER)
  if (!fs.existsSync(markerPath)) {
    throw new Error("旧 bundle 缺少所有权标记，拒绝覆盖")
  }
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"))
  if (
    marker.format !== "memory-bridge-source-bundle:v1" ||
    marker.package !== EXPECTED_PACKAGE ||
    !/^[a-f0-9]{64}$/u.test(String(marker.fingerprint || ""))
  ) {
    throw new Error("bundle 所有权标记无效，拒绝覆盖")
  }
  const actualFingerprint = fingerprint(directory)
  if (marker.fingerprint !== actualFingerprint) {
    throw new Error("bundle fingerprint 不匹配，拒绝覆盖")
  }
  return { marker, fingerprint: actualFingerprint }
}

function assertOwnedBundle(directory) {
  const owned = assertBundleOwnership(directory)
  assertAllowedBundleTree(directory)
  return owned
}

function trustedGitOrigin(value) {
  const remote = String(value || "").trim()
  const scp = remote.match(/^[^@\s]+@([^:\s]+):[^\s]+$/u)
  if (scp) {
    const host = scp[1].toLowerCase()
    return host !== "localhost" && host !== "127.0.0.1" && host !== "::1"
  }
  try {
    const parsed = new URL(remote)
    const host = parsed.hostname.toLowerCase()
    return (
      ["https:", "ssh:"].includes(parsed.protocol) &&
      host &&
      host !== "localhost" &&
      host !== "127.0.0.1" &&
      host !== "::1" &&
      !(parsed.protocol === "https:" && (parsed.username || parsed.password))
    )
  } catch {
    return false
  }
}

function localSourceArgument() {
  const index = process.argv.indexOf("--local-source")
  if (index >= 0) {
    const value = process.argv[index + 1]
    if (!value || value.startsWith("--")) throw new Error("--local-source 缺少路径")
    return value
  }
  return process.env.MEMORY_BRIDGE_LOCAL_UPDATE_SOURCE || ""
}

function syncLocalSource(input) {
  const source = path.resolve(input)
  const bundle = path.join(__dirname, "bundle")
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    throw new Error("显式本地更新源不是现有目录")
  }
  if (isInside(bundle, source)) {
    throw new Error("本地更新源不能位于 launcher bundle 内")
  }
  const trustedSource = assertOwnedBundle(source)
  // Accept a fingerprint-valid legacy bundle only as the replaceable current
  // version. New, staged, and resulting bundles must satisfy the allowlist.
  if (fs.existsSync(bundle)) assertBundleOwnership(bundle)

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-bridge-bundle-source-"))
  const prepared = path.join(temporaryRoot, "bundle")
  const stage = path.join(__dirname, `.bundle.stage-${randomUUID()}`)
  const rollback = path.join(__dirname, ".bundle.rollback")
  let currentMoved = false
  try {
    copyLocalSource(source, prepared)
    readPackage(prepared)
    assertBundleStructure(prepared)
    const preparedBundle = assertOwnedBundle(prepared)
    const nextFingerprint = preparedBundle.fingerprint
    if (nextFingerprint !== trustedSource.fingerprint) {
      throw new Error("本地更新源 canonical bundle fingerprint 复制后不一致，拒绝覆盖")
    }
    if (fs.existsSync(bundle) && fingerprint(bundle) === nextFingerprint) {
      throw new Error("本地更新源与当前 bundle 完全相同；没有新版本，拒绝伪升级")
    }
    fs.cpSync(prepared, stage, { recursive: true, dereference: false })
    assertOwnedBundle(stage)
    if (fs.existsSync(rollback)) {
      assertBundleOwnership(rollback)
      fs.rmSync(rollback, { recursive: true, force: false })
    }
    if (fs.existsSync(bundle)) {
      fs.renameSync(bundle, rollback)
      currentMoved = true
    }
    fs.renameSync(stage, bundle)
    assertOwnedBundle(bundle)
    if (currentMoved) {
      assertBundleOwnership(rollback)
      fs.rmSync(rollback, { recursive: true, force: false })
    }
    console.log(JSON.stringify({ status: "source-synced", method: "local-explicit" }))
  } catch (error) {
    if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: false })
    if (currentMoved && !fs.existsSync(bundle) && fs.existsSync(rollback)) {
      fs.renameSync(rollback, bundle)
    }
    throw error
  } finally {
    if (fs.existsSync(temporaryRoot)) {
      fs.rmSync(temporaryRoot, { recursive: true, force: false })
    }
  }
}

const localSource = localSourceArgument()
if (localSource) {
  syncLocalSource(localSource)
  process.exit(0)
}

const inGitCheckout = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
  cwd: __dirname,
  stdio: "ignore",
  shell: false
})
const remote = spawnSync("git", ["remote", "get-url", "origin"], {
  cwd: __dirname,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
  shell: false
})
if (
  inGitCheckout.status !== 0 ||
  remote.status !== 0 ||
  remote.error ||
  !trustedGitOrigin(remote.stdout)
) {
  throw new Error(
    "没有可信 Git origin，已拒绝升级。请配置 HTTPS/SSH origin，或显式传入 --local-source DIR（也可设置 MEMORY_BRIDGE_LOCAL_UPDATE_SOURCE）。"
  )
}

const bundle = path.join(__dirname, "bundle")
if (!fs.existsSync(bundle)) throw new Error("发布仓库缺少 bundle，拒绝升级")
const before = assertBundleOwnership(bundle).fingerprint
const pull = spawnSync("git", ["pull", "--ff-only"], {
  cwd: __dirname,
  stdio: "inherit",
  shell: false
})
if (pull.status !== 0) {
  throw new Error("发布包更新失败；现有 app 和数据未修改。")
}
if (!fs.existsSync(bundle)) {
  throw new Error("远端更新后 bundle 缺失；现有 app 和数据未修改，拒绝升级。")
}
const after = assertOwnedBundle(bundle).fingerprint
if (after === before) {
  throw new Error("远端没有带来新的 bundle；现有 app 和数据未修改，拒绝伪升级。")
}
console.log(JSON.stringify({ status: "source-updated", method: "git-origin" }))
