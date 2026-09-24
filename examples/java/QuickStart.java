import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 忆桥接入示例 · Java
 *
 * 覆盖：健康检查 → 写入文档切片 → 幂等重放 → 召回 → 发布修订版 → 时序对照查询
 *
 * 用法（JDK 17+，单文件源码启动，无需构建）：
 *   export MB_TOKEN=你的令牌          # 见 examples/README.md §1
 *   java examples/java/QuickStart.java
 *
 * 可选：
 *   MB_BASE=http://127.0.0.1:3789     # 默认打到本机 3789
 *
 * 零第三方依赖：只用 JDK 内置的 java.net.http.HttpClient。
 * JSON 的构造与取值在示例里刻意从简（text block 拼串 + 正则取值）——**生产代码请换成
 * Jackson 或 Gson**，并在 HttpClient 外面加上重试与熔断。标了「替换点」的地方即为此意。
 */
public class QuickStart {

    static final String BASE  = env("MB_BASE", "http://127.0.0.1:3789");
    static final String TOKEN = env("MB_TOKEN", "");
    static final String KEY   = "kb:example-handbook:ch3-s2-" + System.currentTimeMillis();

    static final HttpClient HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();

    public static void main(String[] args) throws Exception {
        System.out.println("目标：" + BASE);
        if (TOKEN.isEmpty()) {
            System.out.println("（未设置 MB_TOKEN：仅健康检查会成功，其余会得到 401）");
        }

        // ───────────────────────────────────────────────────── 1. 健康检查
        hr("1. 健康检查");
        Resp health = req("GET", "/api/health", null);
        System.out.println("HTTP " + health.status() + "  " + health.body());

        // ─────────────────────────────────── 2. 写入文档切片（v1，含密级与语料域）
        hr("2. 写入文档切片（带 corpusDomain / classification）");
        String bodyV1 = """
                {
                  "kind": "document_chunk",
                  "content": "员工考勤规定：每周须到岗 4 天，其余 1 天可远程办公。迟到超过 30 分钟计为半天事假。",
                  "title": "员工手册 > 第三章 考勤 > 3.2 到岗要求",
                  "tags": ["kb:document-chunk", "kb:file", "doc:employee-handbook"],
                  "source": "kb:file",
                  "sourceRef": "employee-handbook.md#ch3-s2",
                  "idempotencyKey": "%s",
                  "importance": 0.5,
                  "occurredAt": "2026-09-01T00:00:00Z",
                  "corpusDomain": "policy",
                  "classification": "internal"
                }
                """.formatted(KEY);

        Resp v1 = req("POST", "/api/memories", bodyV1);
        System.out.println("HTTP " + v1.status());
        String firstId = str(v1.body(), "id");
        System.out.println("memory.id      = " + firstId);
        System.out.println("origin         = " + str(v1.body(), "origin") + "   （服务端强制打标，客户端无法伪造）");
        System.out.println("corpusDomain   = " + str(v1.body(), "corpusDomain"));
        System.out.println("classification = " + str(v1.body(), "classification"));
        if (firstId == null) {
            System.err.println("\n写入未拿到 memory.id，后续步骤无法继续。原始响应：");
            System.err.println(v1.body());
            System.exit(1);
        }

        // ────────────────────────────────────────────── 3. 幂等：同键重放一次
        hr("3. 幂等重放（同一 idempotencyKey）");
        Resp again = req("POST", "/api/memories", bodyV1);
        System.out.println("HTTP " + again.status());
        System.out.println("created        = " + bool(again.body(), "created"));
        System.out.println("deduplicated   = " + bool(again.body(), "deduplicated")
                + "   （true = 命中已有条目，未产生重复）");
        System.out.println("id 是否相同    = " + (firstId.equals(str(again.body(), "id")) ? "是" : "否"));

        // ───────────────────────────────────────────────────────────── 4. 召回
        hr("4. 召回（查询措辞带上正文关键词，避免 policy 门槛拒答）");
        String recallBody = """
                {
                  "query": "员工考勤规定 每周须到岗 天 远程办公",
                  "limit": 3,
                  "contextTokenBudget": 800
                }
                """;
        Resp recall = req("POST", "/api/recall", recallBody);
        System.out.println("HTTP " + recall.status()
                + "   qualityState = " + str(recall.body(), "qualityState"));
        System.out.println("traceId = " + str(recall.body(), "traceId"));
        for (String c : allStr(recall.body(), "content")) {
            System.out.println("  " + cut(c, 40));
        }
        System.out.println();
        System.out.println("context（可直接拼进 LLM prompt）：");
        for (String line : str(recall.body(), "context").split("\n")) {
            System.out.println("  | " + line);
        }

        // ─────────────────────────────────── 5. 发布修订版（supersede 取代旧版）
        hr("5. 发布修订版（supersedesId 显式声明取代）");
        String bodyV2 = """
                {
                  "kind": "document_chunk",
                  "content": "员工考勤规定（修订版）：每周须到岗 3 天，其余 2 天可远程办公。",
                  "title": "员工手册 > 第三章 考勤 > 3.2 到岗要求（2026-09 修订）",
                  "tags": ["kb:document-chunk", "kb:file", "doc:employee-handbook"],
                  "source": "kb:file",
                  "sourceRef": "employee-handbook.md#ch3-s2-v2",
                  "idempotencyKey": "%s-v2",
                  "validFrom": "2026-09-20T00:00:00Z",
                  "supersedesId": "%s",
                  "corpusDomain": "policy",
                  "classification": "internal"
                }
                """.formatted(KEY, firstId);

        Resp v2 = req("POST", "/api/memories", bodyV2);
        System.out.println("HTTP " + v2.status() + "    新片段 id = " + str(v2.body(), "id"));
        System.out.println("                validFrom = " + str(v2.body(), "validFrom"));

        Resp old = req("GET", "/api/memories/" + firstId, null);
        System.out.println("旧片段 status = " + str(old.body(), "status") + "   （应为 superseded）");

        // ──────────────────────────────────────────── 6. 时序对照：现在 vs 过去
        hr("6a. 查「现在」——应只出现修订版（3 天）");
        Resp now = req("POST", "/api/recall", """
                {
                  "query": "员工考勤规定 每周须到岗 天 远程办公",
                  "limit": 3
                }
                """);
        printHits(now.body());

        hr("6b. 查「过去时点 2026-09-10」——应只出现当时的旧版（4 天）");
        Resp asOf = req("POST", "/api/recall", """
                {
                  "query": "员工考勤规定 每周须到岗 天 远程办公",
                  "limit": 3,
                  "timestamp": "2026-09-10T00:00:00Z"
                }
                """);
        printHits(asOf.body());

        System.out.println();
        System.out.println("完成。这些数据写在你的数据目录里（示例用固定前缀 kb:example-handbook: 便于识别与清理）。");
    }

    // ────────────────────────────────────────────────────────────────────── 工具

    record Resp(int status, String body) {}

    static String env(String key, String fallback) {
        String v = System.getenv(key);
        return (v == null || v.isBlank()) ? fallback : v;
    }

    static Resp req(String method, String path, String json) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(BASE + path))
                .header("Content-Type", "application/json")
                // 召回会走本机 14B 模型，首次调用包含加载时间；生产按你的 P95 设超时
                .timeout(Duration.ofSeconds(180));
        if (!TOKEN.isEmpty()) {
            b.header("Authorization", "Bearer " + TOKEN);
        }
        if (json == null) {
            b.method(method, HttpRequest.BodyPublishers.noBody());
        } else {
            b.method(method, HttpRequest.BodyPublishers.ofString(json, StandardCharsets.UTF_8));
        }
        HttpResponse<String> r = HTTP.send(b.build(),
                HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        return new Resp(r.statusCode(), r.body());
    }

    static void printHits(String json) {
        List<String> contents = allStr(json, "content");
        List<String> statuses = allStr(json, "status");
        for (int i = 0; i < contents.size(); i++) {
            String status = i < statuses.size() ? statuses.get(i) : "?";
            System.out.println("  " + cut(contents.get(i), 42) + "｜status=" + status);
        }
    }

    static void hr(String title) {
        System.out.println("\n──── " + title + " ────");
    }

    static String cut(String s, int n) {
        return s.length() <= n ? s : s.substring(0, n);
    }

    // ── 以下为正则取值实现：示例够用，生产请替换为 Jackson / Gson ──

    static String str(String json, String field) {
        Matcher m = Pattern.compile("\"" + field + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").matcher(json);
        return m.find() ? unescape(m.group(1)) : null;
    }

    static boolean bool(String json, String field) {
        Matcher m = Pattern.compile("\"" + field + "\"\\s*:\\s*(true|false)").matcher(json);
        return m.find() && m.group(1).equals("true");
    }

    static List<String> allStr(String json, String field) {
        List<String> out = new ArrayList<>();
        Matcher m = Pattern.compile("\"" + field + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").matcher(json);
        while (m.find()) {
            out.add(unescape(m.group(1)));
        }
        return out;
    }

    static String unescape(String s) {
        StringBuilder sb = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c != '\\' || i + 1 >= s.length()) {
                sb.append(c);
                continue;
            }
            char n = s.charAt(++i);
            switch (n) {
                case 'n' -> sb.append('\n');
                case 't' -> sb.append('\t');
                case 'r' -> sb.append('\r');
                case 'b' -> sb.append('\b');
                case 'f' -> sb.append('\f');
                case 'u' -> {
                    sb.append((char) Integer.parseInt(s.substring(i + 1, i + 5), 16));
                    i += 4;
                }
                default -> sb.append(n);
            }
        }
        return sb.toString();
    }
}
