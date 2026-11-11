# locmodel-catalog

Local-Model 的远端推荐目录。客户端（设置 → 模型存放 → 推荐目录）填下面任一地址即可热更新推荐，不用重新发版：

- GitHub raw（最稳，内容即时）：`https://raw.githubusercontent.com/gzc184123/locmodel-catalog/main/catalog.json`
- jsDelivr：`https://cdn.jsdelivr.net/gh/gzc184123/locmodel-catalog@main/catalog.json`

> jsDelivr 对 `@main` 的解析偶尔会落后好几个提交（purge 后仍可能命中旧快照），需要立刻生效时用 raw；jsDelivr 只作为国内访问的备用线路。

## 文件

| 文件 | 条数 | 用途 |
| --- | --- | --- |
| `catalog.json` | 16 条官方 + 最多 30 条自动收录 | 对话模型目录，客户端会读取 |
| `media.json` | 13 条官方 + 最多 20 条自动收录 | 画图 / 视频模型清单，客户端会读取 |

两份清单都取自官方 LocModel 3.1.0 的内置目录，字段按客户端结构整理。

## catalog.json 结构

```json
{
  "version": 3,
  "updated": "2026-11-11",
  "items": [
    {
      "id": "qwen3.5-9b",
      "name": "Qwen3.5 9B",
      "org": "阿里 Qwen · unsloth",
      "release": "2026-03",
      "family": "qwen",
      "params": "9B",
      "quant": "UD-Q4_K_XL",
      "sizeGb": 5.6,
      "minVramGb": 7,
      "desc": "小巧全能，8G 显存流畅，能看图。",
      "tags": ["对话", "多模态"],
      "repo": "unsloth/Qwen3.5-9B-GGUF",
      "vision": true,
      "quants": ["Q4_K_M", "UD-Q4_K_XL", "Q5_K_M", "Q6_K", "Q8_0"],
      "recommendedQuant": "UD-Q4_K_XL"
    }
  ]
}
```

- 必填：`id`、`name`、`repo`
- 可选：`org` / `release` / `family` / `params` / `quant` / `sizeGb` / `minVramGb` / `desc` / `tags` / `tag` / `vision` / `uncensored` / `quants` / `recommendedQuant`
- `tags` 用客户端筛选词：`对话` / `代码` / `多模态` / `推理`
- `sizeGb` 为推荐量化档的整包体积（GB）；`quants` 为仓库真实提供的档位
- 按 `id` 覆盖客户端内置条目；新 `id` 排在最前，其余内置条目保留
- 客户端只接受 http/https，文件上限 2 MB，格式错误不会覆盖旧缓存

## media.json 结构

```json
{
  "image": [
    {
      "id": "z-image-turbo-q4_k",
      "name": "Z-Image Turbo · Q4_K",
      "kind": "image",
      "repo": "leejet/Z-Image-Turbo-GGUF",
      "quant": "Q4_K",
      "sizeGb": 3.6,
      "note": "官方默认画图模型，8 步出图，4 GB 显存也能跑。",
      "quants": ["Q3_K", "Q4_K", "Q6_K", "Q8_0"],
      "components": [
        { "role": "text_encoder", "repo": "unsloth/Qwen3-4B-Instruct-2507-GGUF", "file": "Qwen3-4B-Instruct-2507-Q4_K_M.gguf" },
        { "role": "vae", "repo": "Comfy-Org/z_image_turbo", "file": "split_files/vae/ae.safetensors" }
      ],
      "appPreset": "z-image-turbo-q4_k"
    }
  ],
  "video": []
}
```

- `sizeGb` 只算主体权重，不含文本编码器与 VAE
- `components[].role`：`text_encoder` / `mmproj` / `vae` / `audio_vae` / `connectors` / `diffusion_model_high` / `diffusion_model_low`

## 模型介绍自动生成

自动收录的条目原来只有模板文案（「…的 GGUF 仓库，自动收录」）。现在 `scripts/discover.mjs` 会给它们补一句中文介绍：

1. 拉 `https://huggingface.co/<repo>/raw/main/README.md` 模型卡；
2. 如果配置了 OpenAI 兼容接口，就把模型卡节选交给它总结；否则优先取模型卡里的中文句子；
3. 都没有时用元数据兜底（参数、看图、无审查、量化与体积），不编造；
4. 统一清洗（去徽章 / HTML / 链接 / 代码块），按字符数限长：对话条目 **60** 字、画图 / 视频 **70** 字，可用 `--desc-max` / `--media-max` 调整；
5. 只改 `source` 为 `auto` / `lmstudio` / `ollama` 的条目，人工 / 官方文案不动；
6. 写入 `descSource`（`ai` / `card` / `meta`）与 `descUpdated`，AI 写过的不会每天重复调用。

在仓库 Settings → Secrets and variables → Actions 里加这三个 secret 即可启用 AI 总结（任意 OpenAI 兼容服务都行，例如 DeepSeek、SiliconFlow、Moonshot）：

| Secret | 示例 |
| --- | --- |
| `LLM_BASE_URL` | `https://api.deepseek.com/v1` |
| `LLM_API_KEY` | `sk-...` |
| `LLM_MODEL` | `deepseek-chat` |

可选的 `HF_TOKEN` 用来读受限 / 私有仓库的模型卡。没配 LLM 时流程照常跑，只是介绍来自模型卡或元数据。

手动触发：Actions → Update catalog → Run workflow，勾选「只补模型介绍」即可回填历史条目；勾选「重新生成所有自动条目的介绍」会忽略 `descSource` 全部重写（会产生 LLM 调用费用）。

## 自动更新（每日）

`.github/workflows/update-catalog.yml` 每天 20:00 UTC（北京时间次日 04:00）跑一次：

1. `scripts/discover.mjs` 扫 HuggingFace 白名单发布者（unsloth / lmstudio-community / bartowski / QuantStack / mradermacher / MaziyarPanahi / ggml-org）；
2. 每个发布者分别用 `gguf` / `uncensored` / `abliterated` 搜三遍，只留对话类 pipeline、近 120 天更新的仓库；普通模型下载 ≥ 3000 或点赞 ≥ 30，无审查模型放宽到下载 ≥ 500 或点赞 ≥ 10；unsloth 近 30 天的新仓库不受热度限制；
3. 读取仓库真实文件列表，生成量化档位与体积，跳过 >100 GB、非对话、带下划线（第三方微调 / 合并版）、测试仓库（for-testing / vllm）的仓库；
4. **按目标机器过滤**：16 GB 显存 + 64 GB 内存，用与客户端一致的粗估公式算 tok/s，预计低于 **10 tok/s** 的不收录；MoE 按激活参数估算，整包超出显存 + 内存时打 75 折（专家按需换入），所以 76–80 GB 的 MoE 仍可收录，dense 大模型会被淘汰；旧条目每次也按同一标准复查并淘汰；
5. 另外拉两份外部推荐：LM Studio 的 `lmstudio-community` 官方仓库（按下载量）与 Ollama 模型库首页热度前 24（按名字到 HuggingFace 找同名 GGUF），各最多收 12 条，条目带 `source: "lmstudio"` / `"ollama"` 与对应标记；
6. 新条目追加为 `source: "auto"`；普通自动条目最多 30 条、无审查最多 20 条，各自按更新时间淘汰；人工 / 官方条目不会被改动或删除；
7. 无审查模型打 `uncensored: true`，客户端在模型卡片与已安装列表显示「无审查」标记，并支持筛选；
8. 有变化才 commit + push，并顺手 purge jsDelivr。

本机手动跑：

```powershell
node scripts/discover.mjs --dry-run          # 只看会加什么
node scripts/discover.mjs                    # 真写入 catalog.json
node scripts/discover.mjs --days 30 --limit 10
node scripts/discover.mjs --desc-only        # 只补介绍，不发现新模型
node scripts/discover.mjs --desc-only --refresh-desc --enrich-limit 200   # 全部重写
```

## 更新

```powershell
git add catalog.json media.json
git commit -m "update catalog"
git push
```

jsDelivr 有缓存，需要立刻生效时访问：

- `https://purge.jsdelivr.net/gh/gzc184123/locmodel-catalog@main/catalog.json`
- `https://purge.jsdelivr.net/gh/gzc184123/locmodel-catalog@main/media.json`
