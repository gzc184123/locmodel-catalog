# locmodel-catalog

Local-Model 的远端推荐目录。客户端（设置 → 模型存放 → 推荐目录）填下面任一地址即可热更新推荐，不用重新发版：

- jsDelivr：`https://cdn.jsdelivr.net/gh/gzc184123/locmodel-catalog@main/catalog.json`
- GitHub raw：`https://raw.githubusercontent.com/gzc184123/locmodel-catalog/main/catalog.json`

## 文件

| 文件 | 条数 | 用途 |
| --- | --- | --- |
| `catalog.json` | 16 条官方 + 最多 30 条自动收录 | 对话模型目录，客户端会读取 |
| `media.json` | 13（7 画图 + 6 视频） | 官方画图 / 视频预设清单，仅作对照，客户端暂不读取 |

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
- 可选：`org` / `release` / `family` / `params` / `quant` / `sizeGb` / `minVramGb` / `desc` / `tags` / `tag` / `vision` / `quants` / `recommendedQuant`
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

## 自动更新（每日）

`.github/workflows/update-catalog.yml` 每天 20:00 UTC（北京时间次日 04:00）跑一次：

1. `scripts/discover.mjs` 扫 HuggingFace 白名单发布者（unsloth / lmstudio-community / bartowski / QuantStack / mradermacher / MaziyarPanahi / ggml-org）；
2. 只留对话类 pipeline、近 120 天更新、下载 ≥ 3000 或点赞 ≥ 30 的仓库；unsloth 近 30 天的新仓库不受热度限制；
3. 读取仓库真实文件列表，生成量化档位与体积，跳过 >120 GB、非对话、带下划线（第三方微调 / 合并版）的仓库；
4. 新条目追加为 `source: "auto"`，自动条目最多 30 条，按更新时间淘汰；人工 / 官方条目不会被改动或删除；
5. 有变化才 commit + push，并顺手 purge jsDelivr。

本机手动跑：

```powershell
node scripts/discover.mjs --dry-run          # 只看会加什么
node scripts/discover.mjs                    # 真写入 catalog.json
node scripts/discover.mjs --days 30 --limit 10
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
