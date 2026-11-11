// 每日从 HuggingFace 拉取白名单厂商的新 GGUF 对话模型，合并进 catalog.json
// 用法：node scripts/discover.mjs [--dry-run] [--days 120] [--limit 40]
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CATALOG = join(ROOT, "catalog.json");

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};

/** 只扫这些发布者，避免全站噪声；前面的优先，同模型多仓库时保留靠前的 */
const AUTHORS = [
  "unsloth",
  "lmstudio-community",
  "bartowski",
  "QuantStack",
  "mradermacher",
  "MaziyarPanahi",
  "ggml-org",
];
const AUTHOR_RANK = new Map(AUTHORS.map((a, i) => [a, i]));
/** 对话类 pipeline（排除画图 / 视频 / 语音 / 向量 / 重排） */
const CHAT_PIPELINES = new Set(["text-generation", "image-text-to-text", "text2text-generation"]);
const MIN_DOWNLOADS = 3000;
const MIN_LIKES = 30;
const DAYS = argValue("--days", 120);
/** unsloth 官方新模型通常下载量还没起来，近 30 天直接收录 */
const FAST_TRACK_AUTHOR = "unsloth";
const FAST_TRACK_DAYS = 30;
/** 自动收录条数上限，超出按更新时间淘汰 */
const AUTO_LIMIT = argValue("--limit", 30);
/** 推荐量化档位优先级：优先 4 bit 附近，其次低比特，最后高比特 */
const QUANT_PREF = [
  "UD-Q4_K_XL",
  "Q4_K_M",
  "UD-Q4_K_M",
  "Q4_K_S",
  "Q4_0",
  "Q4_1",
  "UD-Q3_K_XL",
  "Q3_K_M",
  "UD-IQ3_XXS",
  "UD-IQ2_M",
  "UD-IQ1_M",
  "Q5_K_M",
  "Q6_K",
  "Q8_0",
  "F16",
  "MXFP4",
];
/** 超过这个体积的模型对本地客户端没有意义，不收录 */
const MAX_SIZE_GB = 120;
/** 明显不是对话模型的仓库名，直接跳过 */
const SKIP_NAME = /embed|rerank|classif|whisper|tts|audio|ocr|sentence|reward|guard|diffus|flux|wan2|ltx|image|video|sd-|stable-diffusion|minimax-h3|abliterated|uncensored|nsfw|roleplay|erotic|jailbreak|de-censor/i;

/** 归一化名称，用来判断「同一个模型的不同发布者仓库」 */
function nameKey(text) {
  return text.replace(/-GGUF$/i, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const UA = { "User-Agent": "locmodel-catalog-bot" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers: UA });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) return null;
      return await res.json();
    } catch (err) {
      if (i === retries - 1) {
        console.warn(`  跳过 ${url}: ${err.message}`);
        return null;
      }
      await sleep(1500 * (i + 1));
    }
  }
  return null;
}

/** 从文件名解析量化档位，例如 Qwen3.8-27B-UD-Q4_K_XL.gguf → UD-Q4_K_XL */
function quantOf(file) {
  let base = (file.split("/").pop() || "").replace(/\.gguf$/i, "");
  // 去掉分卷后缀 -00001-of-00005
  base = base.replace(/-\d{4,5}-of-\d{4,5}$/i, "");
  const m = base.match(/-(UD-[^/]+|IQ\d[^/]*|Q\d[^/]*|BF16|F16|FP16|MXFP4)$/i);
  return m ? m[1].toUpperCase().replace(/^FP16$/, "F16") : null;
}

function paramsOf(repo) {
  const active = repo.match(/A(\d+(?:\.\d+)?)B/i);
  const t = repo.match(/(\d+(?:\.\d+)?)T(?![a-zA-Z])/i);
  if (t) return `${t[1]}T${active ? ` A${active[1]}B` : ""}`;
  const b = repo.match(/(\d+(?:\.\d+)?)B(?![a-zA-Z])/i);
  if (b) return `${b[1]}B${active ? ` A${active[1]}B` : ""}`;
  return "";
}

function familyOf(repo) {
  const head = repo.replace(/-GGUF$/i, "").toLowerCase();
  return head.replace(/[._-]?\d.*$/, "").replace(/[-_.]+$/, "") || "other";
}

function idOf(repo) {
  return repo.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-gguf$/, "").replace(/^-|-$/g, "");
}

function displayName(repo) {
  return repo.replace(/-GGUF$/i, "").replace(/[_-]+/g, " ").trim();
}

function tagsOf(repo, info) {
  const text = `${repo} ${(info.tags || []).join(" ")}`;
  const tags = ["对话"];
  if (info.vision) tags.push("多模态");
  if (/coder|code|devstral/i.test(text)) tags.push("代码");
  if (/reason|thinking|r1\b|qwq/i.test(text)) tags.push("推理");
  return [...new Set(tags)];
}

/** 把 HF 详情里的文件列表整理成目录条目 */
function toItem(author, detail) {
  const repo = detail.id.split("/")[1] || detail.id;
  const files = (detail.siblings || []).filter((s) => s.rfilename.endsWith(".gguf"));
  const main = files.filter((s) => !s.rfilename.includes("mmproj") && !s.rfilename.includes("MTP/"));
  if (!main.length) return null;

  // 每个量化档取最大的那个文件（分卷时合并），用体积推算整包大小
  const byQuant = new Map();
  for (const f of main) {
    const q = quantOf(f.rfilename);
    if (!q) continue;
    const prev = byQuant.get(q) || 0;
    byQuant.set(q, prev + (f.size || 0));
  }
  if (!byQuant.size) return null;

  const available = [...byQuant.keys()];
  // 优先取 4 bit 档；仓库没有 4 bit 时取体积居中的档，避免默认推荐最大的
  const pick =
    QUANT_PREF.find((q) => available.includes(q)) ||
    [...available].sort((a, b) => byQuant.get(a) - byQuant.get(b))[Math.floor(available.length / 2)];
  const sizeGb = Math.round((byQuant.get(pick) / 1024 ** 3) * 10) / 10;
  if (!sizeGb || sizeGb > MAX_SIZE_GB) return null;

  const ordered = [
    ...QUANT_PREF.filter((q) => available.includes(q)),
    ...available.filter((q) => !QUANT_PREF.includes(q)),
  ];
  const vision =
    files.some((f) => f.rfilename.toLowerCase().includes("mmproj")) ||
    (detail.tags || []).includes("image-text-to-text");
  const params = paramsOf(repo);

  return {
    id: idOf(repo),
    name: displayName(repo),
    org: `${author} · HuggingFace`,
    family: familyOf(repo),
    params,
    quant: pick,
    sizeGb,
    minVramGb: Math.max(4, Math.round(sizeGb * 1.2)),
    desc: `${author} 的${params ? ` ${params} ` : " "}GGUF 仓库，自动收录；量化档位与体积按仓库真实文件计算。`,
    tags: tagsOf(repo, { tags: detail.tags, vision }),
    repo: detail.id,
    vision,
    quants: ordered,
    recommendedQuant: pick,
    source: "auto",
    lastModified: detail.lastModified || "",
    downloads: detail.downloads || 0,
  };
}

function daysAgo(iso) {
  if (!iso) return Infinity;
  return (Date.now() - Date.parse(iso)) / 86400000;
}

async function main() {
  const catalog = JSON.parse(await readFile(CATALOG, "utf8"));
  const items = catalog.items || [];
  const known = new Set(items.map((m) => String(m.repo || "").toLowerCase()));
  // 已收录模型的名称指纹，避免同一模型的别的发布者仓库重复上架
  const knownNames = new Set(
    items.flatMap((m) => [nameKey(m.name || ""), nameKey(String(m.repo || "").split("/")[1] || "")])
  );

  const candidates = [];
  const seenNames = new Set();
  for (const author of AUTHORS) {
    const list = await getJson(
      `https://huggingface.co/api/models?author=${encodeURIComponent(author)}` +
        `&search=gguf&sort=lastModified&direction=-1&limit=100`
    );
    if (!Array.isArray(list)) {
      console.warn(`${author}: 列表拉取失败`);
      continue;
    }
    console.log(`${author}: ${list.length} 个 GGUF 仓库`);
    for (const m of list) {
      if (known.has(m.id.toLowerCase())) continue;
      const name = m.id.split("/")[1] || "";
      if (SKIP_NAME.test(name)) continue;
      // 带下划线的多是第三方微调 / 合并版（Author_Model 命名），不放进推荐
      if (name.includes("_")) continue;
      if (m.pipeline_tag && !CHAT_PIPELINES.has(m.pipeline_tag)) continue;
      if (daysAgo(m.lastModified) > DAYS) continue;
      const hot = (m.downloads || 0) >= MIN_DOWNLOADS || (m.likes || 0) >= MIN_LIKES;
      const fresh = author === FAST_TRACK_AUTHOR && daysAgo(m.lastModified) <= FAST_TRACK_DAYS;
      if (!hot && !fresh) continue;
      // 同一模型只保留优先级最高发布者的仓库
      const key = nameKey(name);
      if (knownNames.has(key) || seenNames.has(key)) continue;
      seenNames.add(key);
      candidates.push({ ...m, _rank: AUTHOR_RANK.get(author) ?? 99 });
    }
  }

  // 官方发布者优先，其次按更新时间倒序；条数上限时优先收最新
  candidates.sort((a, b) => a._rank - b._rank || String(b.lastModified).localeCompare(String(a.lastModified)));
  console.log(`新候选：${candidates.length} 个，逐个读取文件列表…`);
  const added = [];
  const addedIds = new Set();
  const addedNames = new Set(knownNames);
  for (const m of candidates) {
    if (added.length >= AUTO_LIMIT) break;
    const detail = await getJson(
      `https://huggingface.co/api/models/${m.id}?blobs=true`
    );
    if (!detail) continue;
    const item = toItem(m.id.split("/")[0], { ...detail, downloads: m.downloads, likes: m.likes });
    if (!item) continue;
    const nameFp = nameKey(item.name);
    if (addedIds.has(item.id) || addedNames.has(nameFp) || items.some((x) => x.id === item.id)) continue;
    addedIds.add(item.id);
    addedNames.add(nameFp);
    added.push(item);
    console.log(`  + ${item.name} (${item.repo}, ${item.quant}, ${item.sizeGb} GB)`);
    await sleep(300);
  }

  if (!added.length) {
    console.log("没有新增模型，清单保持不变");
    return;
  }

  // 保留人工 / 官方条目在前，自动条目按更新时间倒序追加，超出上限的旧条目淘汰
  const manual = items.filter((m) => m.source !== "auto");
  const auto = [
    ...added,
    ...items.filter((m) => m.source === "auto").sort((a, b) => String(b.lastModified).localeCompare(String(a.lastModified))),
  ].slice(0, AUTO_LIMIT);

  const next = {
    ...catalog,
    updated: new Date().toISOString().slice(0, 10),
    items: [...manual, ...auto],
  };

  if (DRY) {
    console.log(`[dry-run] 将新增 ${added.length} 条，共 ${next.items.length} 条`);
    console.log(JSON.stringify(added[0], null, 2));
    return;
  }

  await writeFile(CATALOG, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  console.log(`已写入 catalog.json：新增 ${added.length} 条，共 ${next.items.length} 条`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
