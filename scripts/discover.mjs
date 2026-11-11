// 每日从 HuggingFace 拉取白名单厂商的新 GGUF 对话模型，合并进 catalog.json
// 用法：node scripts/discover.mjs [--dry-run] [--days 120] [--limit 40]
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CATALOG = join(ROOT, "catalog.json");
const MEDIA_FILE = join(ROOT, "media.json");

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
/** 无审查模型单独一份配额，热度门槛也放宽 */
const UNCENSORED_LIMIT = argValue("--uncensored-limit", 20);
const UNCENSORED_MIN_DOWNLOADS = 500;
const UNCENSORED_MIN_LIKES = 10;
/** 无审查 / 去审查微调的关键词 */
const UNCENSORED_RE = /uncensored|abliterated|unfiltered|nsfw|de[-_]?censor|jailbreak/i;
/** 外部推荐列表（LM Studio / Ollama）各自最多收多少条 */
const EXTERNAL_CAP = { lmstudio: 12, ollama: 12 };
/** 画图 / 视频清单：自动收录的 HF 发布者与热度门槛 */
const MEDIA_AUTHORS = ["leejet", "Comfy-Org", "unsloth", "QuantStack", "city96"];
const MEDIA_PIPELINES = new Set([
  "text-to-image",
  "image-to-image",
  "text-to-video",
  "image-to-video",
]);
const MEDIA_MIN_DOWNLOADS = 3000;
const MEDIA_LIMIT = 20;
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
const MAX_SIZE_GB = 100;
/** 目标机器：16G 显存 / 64G 内存，预计低于 10 tok/s 的模型不收录 */
const TARGET_VRAM_GB = 16;
const TARGET_RAM_GB = 64;
const MIN_TOK_S = 10;
/** 介绍字数上限（按字符数，中文一个字算一个）；可用 --desc-max 覆盖 */
const DESC_MAX = argValue("--desc-max", 60);
/** 画图 / 视频条目介绍上限，稍长一点 */
const MEDIA_NOTE_MAX = argValue("--media-max", 70);
/** 每次最多补多少条介绍，避免 Actions 超时 */
const ENRICH_LIMIT = argValue("--enrich-limit", 25);
/** 可选：OpenAI 兼容的总结接口，GitHub Actions 里用 secrets 注入 */
const LLM_BASE = (process.env.LLM_BASE_URL || "").trim().replace(/\/+$/, "");
const LLM_KEY = (process.env.LLM_API_KEY || "").trim();
const LLM_MODEL = (process.env.LLM_MODEL || "").trim();
const REFRESH_DESC = args.includes("--refresh-desc");
/** 只补介绍，不发现新模型（用于回填历史条目） */
const DESC_ONLY = args.includes("--desc-only");
const HF_TOKEN = (process.env.HF_TOKEN || "").trim();
// 与客户端 Models 页一致：显存留 8%，内存预留 4 GB
const VRAM_BUDGET_GB = Math.max(0, TARGET_VRAM_GB * 0.92 - 1);
const RAM_BUDGET_GB = Math.max(0, TARGET_RAM_GB - Math.min(4, TARGET_RAM_GB / 3));
/** 明显不是对话模型的仓库名，直接跳过 */
const SKIP_NAME = /embed|rerank|classif|whisper|tts|audio|ocr|sentence|reward|guard|diffus|flux|wan2|ltx|image|video|sd-|stable-diffusion|minimax-h3|vllm[-_]|for[-_\s]?testing|tinyllama-for-testing/i;

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
  const uncensored = isUncensored(repo, detail.tags);

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
    descSource: "template",
    tags: tagsOf(repo, { tags: detail.tags, vision }),
    repo: detail.id,
    vision,
    uncensored,
    quants: ordered,
    recommendedQuant: pick,
    source: "auto",
    lastModified: detail.lastModified || "",
    downloads: detail.downloads || 0,
    // 16G 显存 / 64G 内存下的粗略速度，低于 10 tok/s 的不收录
    estTokS: Math.round(estimateSpeed(sizeGb, VRAM_BUDGET_GB, RAM_BUDGET_GB, params) * 10) / 10,
  };
}

/** 仓库名或 HF 标签里带无审查 / 去审查字样 */
function isUncensored(repo, tags) {
  return (
    UNCENSORED_RE.test(repo) ||
    (tags || []).some((t) => UNCENSORED_RE.test(String(t)))
  );
}

/**
 * 与客户端模型页同一套粗估：按显存带宽分档，权重依次放显存 → 内存 → 硬盘，
 * MoE 只算激活参数；封顶 150 tok/s，避免出现 500+ 的失真数字。
 */
function estimateSpeed(sizeGb, vramGb, ramGb, params) {
  const gpuBw =
    vramGb >= 40 ? 1100 : vramGb >= 24 ? 900 : vramGb >= 16 ? 500 : vramGb >= 12 ? 380 : vramGb >= 8 ? 300 : 220;
  const gpuGb = Math.min(sizeGb, Math.max(0, vramGb));
  const ramUsed = Math.min(sizeGb - gpuGb, Math.max(0, ramGb));
  const diskGb = Math.max(0, sizeGb - gpuGb - ramUsed);
  const secs = gpuGb / gpuBw + ramUsed / 40 + diskGb / 2;
  let tokS = secs > 0 ? 0.7 / secs : 0;

  const moe = String(params || "").match(/([\d.]+)\s*B\s*A([\d.]+)\s*B/i);
  if (moe) {
    const total = Number(moe[1]);
    const active = Number(moe[2]);
    // MoE 每步只读激活专家；总权重超出显存 + 内存时按需从硬盘换入，给一点折扣
    if (total > 0 && active > 0 && active < total) {
      const activeGb = sizeGb * (active / total);
      if (activeGb <= Math.max(0, vramGb)) {
        let moeTokS = (0.7 / (activeGb / gpuBw)) * 0.7;
        if (sizeGb > vramGb + ramGb) moeTokS *= 0.75;
        tokS = Math.max(tokS, moeTokS);
      }
    }
  }
  return Math.min(150, tokS);
}

function daysAgo(iso) {
  if (!iso) return Infinity;
  return (Date.now() - Date.parse(iso)) / 86400000;
}

async function fetchText(url, retries = 2) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers: UA });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (i === retries - 1) {
        console.warn(`  跳过 ${url}: ${err.message}`);
        return "";
      }
      await sleep(1200 * (i + 1));
    }
  }
  return "";
}

/* ---------- 自动介绍：模型卡 →（可选 LLM）→ 限长中文一句话 ---------- */

/** 拉模型卡 README（公开仓库不需要 token，配了 HF_TOKEN 可以读受限仓库） */
async function fetchModelCard(repo) {
  const headers = { ...UA };
  if (HF_TOKEN) headers.Authorization = `Bearer ${HF_TOKEN}`;
  const url = `https://huggingface.co/${repo}/raw/main/README.md`;
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return "";
    const text = await res.text();
    return text.length > 60000 ? text.slice(0, 60000) : text;
  } catch (err) {
    console.warn(`  模型卡拉取失败 ${repo}: ${err.message}`);
    return "";
  }
}

/** 去掉徽章、HTML、代码块、表格等，只留正文 */
function cleanCard(text) {
  let t = String(text || "");
  t = t.replace(/^---[\s\S]*?\n---\s*/m, "");
  t = t.replace(/```[\s\S]*?```/g, " ");
  t = t.replace(/^\s*\|.*\|\s*$/gm, " ");
  t = t.replace(/^\s*[-*_]{3,}\s*$/gm, " ");
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  t = t.replace(/<[^>]+>/g, " ");
  t = t.replace(/^#{1,6}\s*/gm, "");
  t = t.replace(/^\s*[-*+]\s+/gm, "");
  t = t.replace(/^\s*>\s?/gm, "");
  t = t.replace(/^(model card|license|usage|introduction|模型卡|许可证|使用说明)\s*$/gim, " ");
  t = t.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
  return t;
}

/** 截到 max 个字；优先在句末断开，实在断不了就硬截并加省略号 */
function clipText(text, max) {
  let t = String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[*`#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  t = t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  if (!t) return "";
  const chars = Array.from(t);
  if (chars.length <= max) return t;
  const head = chars.slice(0, max).join("");
  const m = head.match(/^([\s\S]*[。！？；;.!?])/);
  // 句末位置太靠前（不到一半）就硬截，避免只留半句
  if (m && Array.from(m[1]).length >= Math.floor(max * 0.5)) return m[1];
  return `${head.replace(/[，,、：:；;]$/, "")}…`;
}

/** 模型卡里的中文句子（有些仓库的卡是中文写的） */
function chineseSentence(text, max) {
  const clean = cleanCard(text);
  if (!clean) return "";
  const sentences = clean
    .split(/(?<=[。！？!?\n])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12);
  const zh = sentences.find((s) => {
    if ((s.match(/[\u4e00-\u9fa5]/g) || []).length < 8) return false;
    // 只认像模型介绍的句子，避免抓到示例图注 / 幻灯片说明
    if (/^(这|该|上图|下图|图片|示例|图注|[-–—])/.test(s)) return false;
    return /模型|支持|参数|训练|对话|语言|文本|图像|视频|推理|量化|上下文/i.test(s);
  });
  return zh ? clipText(zh, max) : "";
}

/** 没有 LLM 时的中文兜底：只用元数据，不编造 */
function metaDescription(item, kind) {
  const parts = [];
  if (item.params) parts.push(`${item.params} 参数`);
  if (item.vision) parts.push("支持看图");
  if (item.uncensored) parts.push("无审查微调");
  if (kind === "media") {
    parts.push(item.kind === "video" ? "视频生成模型" : "图片生成模型");
  } else {
    if ((item.tags || []).includes("代码")) parts.push("偏编程");
    if ((item.tags || []).includes("推理")) parts.push("偏推理");
    parts.push("文本对话模型");
  }
  const size = item.sizeGb ? `推荐 ${item.quant}（${item.sizeGb} GB）` : "";
  return `${parts.join("，")}${size ? `；${size}` : ""}。`;
}

/** 调 OpenAI 兼容接口写一句中文介绍；没配置就返回空串 */
async function summarizeWithLLM(item, card, max, kind) {
  if (!LLM_BASE || !LLM_MODEL || !LLM_KEY) return "";
  const brief = cleanCard(card).slice(0, 3000);
  const system =
    "你是本地大模型目录的编辑。根据给出的 HuggingFace 模型信息，用简体中文写一句模型介绍。" +
    `要求：只写一句话，控制在 ${Math.max(30, max - 10)}～${max} 个汉字；不要换行、不要 markdown、不要链接；` +
    "说清楚模型类型、规模、擅长什么、显存或使用限制（有才写）；不要营销词，不要重复模型名，不要编造没给的信息。";
  const user = [
    `模型：${item.name || item.id}`,
    `仓库：${item.repo}`,
    `类型：${kind === "media" ? (item.kind === "video" ? "视频生成" : "图片生成") : "文本对话"}`,
    item.params ? `参数：${item.params}` : "",
    item.quant ? `推荐量化：${item.quant}` : "",
    (item.tags || []).length ? `标签：${item.tags.join("、")}` : "",
    brief ? `模型卡节选：\n${brief}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const res = await fetch(`${LLM_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${LLM_KEY}` },
      body: JSON.stringify({
        model: LLM_MODEL,
        temperature: 0.2,
        max_tokens: 200,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      console.warn(`  LLM 总结失败 HTTP ${res.status}`);
      return "";
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || "";
    return clipText(content, max);
  } catch (err) {
    console.warn(`  LLM 总结失败：${err.message}`);
    return "";
  }
}

/** 给自动收录的条目补介绍，只动没有人工文案的条目 */
async function enrichDescriptions(list, kind) {
  const field = kind === "media" ? "note" : "desc";
  const max = kind === "media" ? MEDIA_NOTE_MAX : DESC_MAX;
  let used = 0;
  for (const item of list) {
    if (used >= ENRICH_LIMIT) break;
    const managed = ["auto", "lmstudio", "ollama"].includes(item.source);
    if (!managed || !item.repo) continue;
    // AI 写过的除非显式刷新，不再重复花钱
    if (item.descSource === "ai" && !REFRESH_DESC) continue;
    const current = String(item[field] || "");
    const needs =
      REFRESH_DESC ||
      !item.descSource ||
      item.descSource === "template" ||
      item.descSource === "meta" ||
      /自动收录|按仓库真实文件计算/.test(current);
    if (!needs) continue;

    const card = await fetchModelCard(item.repo);
    const ai = await summarizeWithLLM(item, card, max, kind);
    const zh = ai || chineseSentence(card, max);
    // 已经是元数据兜底，又没有拿到更好的内容，就别来回改
    if (!zh && item.descSource === "meta" && !REFRESH_DESC) continue;
    const text = zh || clipText(metaDescription(item, kind), max);
    if (!text) continue;
    item[field] = text;
    item.descSource = ai ? "ai" : zh ? "card" : "meta";
    item.descUpdated = new Date().toISOString().slice(0, 10);
    used += 1;
    console.log(`  ✎ ${item.name || item.id}：${text}`);
    await sleep(350);
  }
  if (used) console.log(`已补 ${used} 条介绍（上限 ${ENRICH_LIMIT}）`);
  else console.log("没有需要补介绍的条目");
}

/** Ollama 模型库按热度排序，取前 N 个 slug 去 HF 找对应 GGUF 仓库 */
async function ollamaCandidates(limit = 24) {
  const html = await fetchText("https://ollama.com/library");
  if (!html) return [];
  const slugs = [
    ...new Set(
      [...html.matchAll(/href="\/library\/([a-z0-9][a-z0-9._-]*)"/g)].map((m) => m[1])
    ),
  ].slice(0, limit);
  console.log(`Ollama 推荐：${slugs.length} 个模型`);
  const out = [];
  for (const slug of slugs) {
    const repo = await hfRepoForName(slug);
    if (repo) out.push({ ...repo, _source: "ollama", _tag: "Ollama" });
    await sleep(200);
  }
  return out;
}

/** LM Studio 自有的 lmstudio-community 仓库，按下载量就是它的推荐顺序 */
async function lmStudioCandidates(limit = 24) {
  const list = await getJson(
    "https://huggingface.co/api/models?author=lmstudio-community&sort=downloads&direction=-1&limit=60"
  );
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const m of list) {
    const name = m.id.split("/")[1] || "";
    if (!/gguf/i.test(name)) continue;
    if (m.pipeline_tag && !CHAT_PIPELINES.has(m.pipeline_tag)) continue;
    const key = nameKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...m, _source: "lmstudio", _tag: "LM Studio" });
    if (out.length >= limit) break;
  }
  console.log(`LM Studio 推荐：${out.length} 个模型`);
  return out;
}

/** 按名字去 HuggingFace 找最可信的 GGUF 仓库 */
async function hfRepoForName(name) {
  const key = nameKey(name);
  if (key.length < 4) return null;
  const list = await getJson(
    `https://huggingface.co/api/models?search=${encodeURIComponent(name + " GGUF")}` +
      `&filter=gguf&sort=downloads&direction=-1&limit=20`
  );
  if (!Array.isArray(list)) return null;
  const matches = list.filter((m) => {
    const repo = m.id.split("/")[1] || "";
    if (repo.includes("_")) return false;
    return nameKey(repo).includes(key);
  });
  if (!matches.length) return null;
  // 白名单发布者优先，其次下载量高的（更可能是官方原版而不是同名微调）
  matches.sort((a, b) => {
    const ra = AUTHOR_RANK.get(a.id.split("/")[0]) ?? 99;
    const rb = AUTHOR_RANK.get(b.id.split("/")[0]) ?? 99;
    return ra - rb || (b.downloads || 0) - (a.downloads || 0);
  });
  return matches[0];
}

/** 自动发现 HuggingFace 上的画图 / 视频仓库（GGUF / safetensors） */
async function discoverMedia(knownRepos) {
  const found = [];
  const seen = new Set();
  for (const author of MEDIA_AUTHORS) {
    const list = await getJson(
      `https://huggingface.co/api/models?author=${encodeURIComponent(author)}` +
        `&sort=downloads&direction=-1&limit=60`
    );
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      if ((m.downloads || 0) < MEDIA_MIN_DOWNLOADS) continue;
      if (!MEDIA_PIPELINES.has(m.pipeline_tag || "")) continue;
      const repo = m.id.split("/")[1] || "";
      if (!/gguf|safetensors/i.test(repo)) continue;
      const key = m.id.toLowerCase();
      if (knownRepos.has(key) || seen.has(key)) continue;
      const detail = await getJson(`https://huggingface.co/api/models/${m.id}?blobs=true`);
      if (!detail) continue;
      const item = toItem(m.id.split("/")[0], { ...detail, downloads: m.downloads, likes: m.likes });
      if (!item) continue;
      seen.add(key);
      found.push({
        id: item.id,
        name: item.name,
        kind: /video/i.test(m.pipeline_tag || "") ? "video" : "image",
        repo: item.repo,
        quant: item.quant,
        sizeGb: item.sizeGb,
        note: "自动收录：HuggingFace 公开仓库，使用前请按仓库文件核对组件。",
        quants: item.quants,
        source: "auto",
        downloads: m.downloads || 0,
        lastModified: m.lastModified || "",
      });
      if (found.length >= MEDIA_LIMIT) return found;
      await sleep(250);
    }
  }
  return found;
}

/** 更新 media.json：官方条目原样保留，自动条目按仓库去重后追加 */
async function updateMediaFile() {
  const media = JSON.parse(await readFile(MEDIA_FILE, "utf8"));
  const all = [...(media.image || []), ...(media.video || [])];
  const manual = all.filter((m) => m.source !== "auto");
  // 旧的自动条目要保留：只按仓库去重，不能每天重建（否则介绍每天重写、条目会消失）
  const prevAuto = all.filter((m) => m.source === "auto");
  const known = new Set(all.map((m) => String(m.repo || "").toLowerCase()));
  const fresh = await discoverMedia(known);
  const seenRepos = new Set();
  const merged = [...manual, ...prevAuto, ...fresh].filter((m) => {
    const key = String(m.repo || "").toLowerCase();
    if (!key) return true;
    if (seenRepos.has(key)) return false;
    seenRepos.add(key);
    return true;
  });
  // 自动条目补一段限长介绍；人工 / 官方文案不动
  await enrichDescriptions(merged, "media");
  const next = {
    ...media,
    updated: new Date().toISOString().slice(0, 10),
    note: "官方 LocModel 3.1.0 的画图 / 视频内置清单 + 每日自动收录的 HuggingFace 仓库；自动条目的组件需按仓库文件核对。",
    image: merged.filter((m) => m.kind !== "video"),
    video: merged.filter((m) => m.kind === "video"),
  };
  const before = JSON.stringify({ i: media.image, v: media.video });
  const after = JSON.stringify({ i: next.image, v: next.video });
  if (before === after) {
    console.log("media.json 没有变化");
    return;
  }
  if (DRY) {
    console.log(`[dry-run] media.json 将更新：${next.image.length} 画图 + ${next.video.length} 视频`);
    return;
  }
  await writeFile(MEDIA_FILE, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  console.log(`media.json 已更新：${next.image.length} 画图 + ${next.video.length} 视频`);
}

/** 只补介绍：不发现新模型，避免一次改动混入大量新条目 */
async function backfillDescriptions() {
  const catalog = JSON.parse(await readFile(CATALOG, "utf8"));
  const items = catalog.items || [];
  await enrichDescriptions(items, "chat");

  const media = JSON.parse(await readFile(MEDIA_FILE, "utf8"));
  const all = [...(media.image || []), ...(media.video || [])];
  await enrichDescriptions(all, "media");

  if (DRY) {
    console.log("[dry-run] 只补介绍，未写入文件");
    return;
  }
  await writeFile(CATALOG, `${JSON.stringify({ ...catalog, items }, null, 2)}\n`, "utf8");
  await writeFile(
    MEDIA_FILE,
    `${JSON.stringify(
      {
        ...media,
        image: all.filter((m) => m.kind !== "video"),
        video: all.filter((m) => m.kind === "video"),
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  console.log("已写入 catalog.json / media.json 的介绍");
}

async function main() {
  if (DESC_ONLY) {
    await backfillDescriptions();
    return;
  }
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
    // 主清单 + 无审查关键词各搜一遍，无审查模型下载量通常低一些
    const lists = [];
    for (const query of ["gguf", "uncensored", "abliterated"]) {
      const list = await getJson(
        `https://huggingface.co/api/models?author=${encodeURIComponent(author)}` +
          `&search=${query}&sort=lastModified&direction=-1&limit=100`
      );
      if (!Array.isArray(list)) {
        console.warn(`${author} / ${query}: 列表拉取失败`);
        continue;
      }
      lists.push(...list);
    }
    const unique = [...new Map(lists.map((m) => [m.id, m])).values()];
    console.log(`${author}: ${unique.length} 个 GGUF 仓库`);
    for (const m of unique) {
      if (known.has(m.id.toLowerCase())) continue;
      const name = m.id.split("/")[1] || "";
      if (SKIP_NAME.test(name)) continue;
      // 带下划线的多是第三方微调 / 合并版（Author_Model 命名），不放进推荐
      if (name.includes("_")) continue;
      if (m.pipeline_tag && !CHAT_PIPELINES.has(m.pipeline_tag)) continue;
      if (daysAgo(m.lastModified) > DAYS) continue;
      const uncensored = isUncensored(name, m.tags);
      const hot =
        (m.downloads || 0) >= (uncensored ? UNCENSORED_MIN_DOWNLOADS : MIN_DOWNLOADS) ||
        (m.likes || 0) >= (uncensored ? UNCENSORED_MIN_LIKES : MIN_LIKES);
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
  const addedRegular = [];
  const addedUncensored = [];
  const addedIds = new Set();
  const addedNames = new Set(knownNames);
  for (const m of candidates) {
    if (addedRegular.length >= AUTO_LIMIT && addedUncensored.length >= UNCENSORED_LIMIT) break;
    const detail = await getJson(
      `https://huggingface.co/api/models/${m.id}?blobs=true`
    );
    if (!detail) continue;
    const item = toItem(m.id.split("/")[0], { ...detail, downloads: m.downloads, likes: m.likes });
    if (!item) continue;
    if (item.estTokS < MIN_TOK_S) {
      console.log(`  - 跳过 ${item.name}（预计 ${item.estTokS} tok/s，低于 ${MIN_TOK_S}）`);
      continue;
    }
    const bucket = item.uncensored ? addedUncensored : addedRegular;
    if (bucket.length >= (item.uncensored ? UNCENSORED_LIMIT : AUTO_LIMIT)) continue;
    const nameFp = nameKey(item.name);
    if (addedIds.has(item.id) || addedNames.has(nameFp) || items.some((x) => x.id === item.id)) continue;
    addedIds.add(item.id);
    addedNames.add(nameFp);
    bucket.push(item);
    console.log(
      `  + ${item.name} (${item.repo}, ${item.quant}, ${item.sizeGb} GB)${item.uncensored ? " [无审查]" : ""}`
    );
    await sleep(300);
  }

  // 外部推荐：LM Studio 官方仓库 + Ollama 模型库，映射到可下载的 HF GGUF
  const externalAdded = [];
  const externalTargets = [...(await lmStudioCandidates(24)), ...(await ollamaCandidates(24))];
  // 已经在我们清单里的同一仓库，也补上「LM Studio / Ollama」标记
  const tagByRepo = new Map(externalTargets.map((m) => [m.id.toLowerCase(), m._tag]));
  const collides = (fp) =>
    [...addedNames].some((k) => k && (k === fp || k.startsWith(fp) || fp.startsWith(k)));
  const promotedIds = new Set();
  for (const m of externalTargets) {
    const src = m._source;
    if (externalAdded.filter((x) => x.source === src).length >= EXTERNAL_CAP[src]) continue;
    const itemId = idOf(m.id.split("/")[1] || "");
    const existing = items.find((x) => x.id === itemId);
    if (existing) {
      // 已在清单里：自动条目转到对应来源，官方条目只在最后补标记
      if (existing.source === "manual" || existing.source === src || promotedIds.has(itemId)) continue;
      promotedIds.add(itemId);
      addedIds.add(itemId);
      externalAdded.push({ ...existing, source: src, tag: m._tag });
      console.log(`  + [${m._tag}] ${existing.name}（已在清单，转入该来源）`);
      continue;
    }
    if (known.has(m.id.toLowerCase())) continue;
    const detail = await getJson(`https://huggingface.co/api/models/${m.id}?blobs=true`);
    if (!detail) continue;
    if (detail.pipeline_tag && !CHAT_PIPELINES.has(detail.pipeline_tag)) continue;
    const item = toItem(m.id.split("/")[0], { ...detail, downloads: m.downloads, likes: m.likes });
    if (!item) continue;
    if (item.estTokS < MIN_TOK_S) {
      console.log(`  - 跳过 [${m._tag}] ${item.name}（预计 ${item.estTokS} tok/s）`);
      continue;
    }
    const fp = nameKey(item.name);
    if (addedIds.has(item.id) || collides(fp) || items.some((x) => x.id === item.id)) continue;
    item.source = src;
    item.tag = m._tag;
    addedIds.add(item.id);
    addedNames.add(fp);
    externalAdded.push(item);
    console.log(`  + [${m._tag}] ${item.name}（${item.repo}, ${item.sizeGb} GB）`);
    await sleep(250);
  }

  const added = [...addedRegular, ...addedUncensored];

  // 保留人工 / 官方条目在前；自动条目分普通 / 无审查 / 外部推荐三组，各自按更新时间倒序
  const managed = ["auto", "lmstudio", "ollama"];
  const manual = items.filter((m) => !managed.includes(m.source));
  const allPrevAuto = items.filter((m) => m.source === "auto");
  const feasible = (m) =>
    m.sizeGb > 0 &&
    m.sizeGb <= MAX_SIZE_GB &&
    estimateSpeed(m.sizeGb, VRAM_BUDGET_GB, RAM_BUDGET_GB, m.params) >= MIN_TOK_S;
  const withSpeed = (m) => ({
    ...m,
    estTokS: Math.round(estimateSpeed(m.sizeGb, VRAM_BUDGET_GB, RAM_BUDGET_GB, m.params) * 10) / 10,
  });
  // 旧条目也按同一台机器复查，跑不动或预计低于 10 tok/s 的直接淘汰
  const prevAuto = allPrevAuto.filter(feasible).map(withSpeed);
  const prevExternal = Object.fromEntries(
    Object.keys(EXTERNAL_CAP).map((src) => [
      src,
      items.filter((m) => m.source === src && feasible(m)).map(withSpeed),
    ])
  );
  const dropped =
    items.filter((m) => managed.includes(m.source)).length -
    (prevAuto.length + Object.values(prevExternal).reduce((n, list) => n + list.length, 0));
  if (dropped > 0) console.log(`淘汰 ${dropped} 条跑不动的旧条目`);

  // 画图 / 视频清单与对话清单相互独立，失败不影响主目录
  try {
    await updateMediaFile();
  } catch (e) {
    console.warn(`media.json 更新失败：${e.message}`);
  }

  if (!added.length && !externalAdded.length && !dropped) {
    console.log("没有新增模型，清单保持不变");
    return;
  }
  const byNewest = (a, b) => String(b.lastModified).localeCompare(String(a.lastModified));
  const regular = [...addedRegular, ...prevAuto.filter((m) => !m.uncensored)]
    .filter((m) => !promotedIds.has(m.id))
    .sort(byNewest)
    .slice(0, AUTO_LIMIT);
  const uncensored = [...addedUncensored, ...prevAuto.filter((m) => m.uncensored)]
    .filter((m) => !promotedIds.has(m.id))
    .sort(byNewest)
    .slice(0, UNCENSORED_LIMIT);
  const external = Object.entries(EXTERNAL_CAP).flatMap(([src, cap]) =>
    [...externalAdded.filter((m) => m.source === src), ...prevExternal[src]]
      .sort(byNewest)
      .slice(0, cap)
  );

  const applyTag = (list) =>
    list.map((m) => {
      const tag = tagByRepo.get(String(m.repo || "").toLowerCase());
      return tag && !m.tag ? { ...m, tag } : m;
    });

  // 同一 id 只保留第一条（官方 / 人工优先），避免来源提升时出现重复卡片
  const seenIds = new Set();
  const finalItems = [
    ...applyTag(manual),
    ...applyTag(regular),
    ...applyTag(uncensored),
    ...applyTag(external),
  ].filter((m) => (seenIds.has(m.id) ? false : (seenIds.add(m.id), true)));

  // 自动条目的介绍：模型卡 / LLM 总结，限长后写回 catalog.json
  await enrichDescriptions(finalItems, "chat");

  const next = {
    ...catalog,
    updated: new Date().toISOString().slice(0, 10),
    items: finalItems,
  };

  if (DRY) {
    console.log(
      `[dry-run] 将新增 ${added.length} 条（无审查 ${addedUncensored.length} 条）` +
        ` + 外部推荐 ${externalAdded.length} 条，共 ${next.items.length} 条`
    );
    console.log(JSON.stringify(added[0] ?? externalAdded[0], null, 2));
    return;
  }

  await writeFile(CATALOG, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  console.log(
    `已写入 catalog.json：新增 ${added.length} 条（无审查 ${addedUncensored.length} 条）` +
      ` + 外部推荐 ${externalAdded.length} 条，共 ${next.items.length} 条`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
