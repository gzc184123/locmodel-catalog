# locmodel-catalog

Local-Model 的远端推荐目录。客户端（设置 → 模型存放 → 推荐目录）填下面任一地址即可热更新推荐，不用重新发版：

- jsDelivr：`https://cdn.jsdelivr.net/gh/gzc184123/locmodel-catalog@main/catalog.json`
- GitHub raw：`https://raw.githubusercontent.com/gzc184123/locmodel-catalog/main/catalog.json`

## 文件

| 文件 | 用途 |
| --- | --- |
| `catalog.json` | 对话模型推荐目录，客户端会读取 |
| `media.json` | 官方画图 / 视频清单，仅作对照，客户端暂不读取 |

## catalog.json 结构

```json
{
  "version": 2,
  "updated": "2026-11-11",
  "items": [
    {
      "id": "qwen3.5-9b",
      "name": "Qwen3.5 9B",
      "family": "qwen",
      "params": "9B",
      "quant": "Q4_K_M",
      "sizeGb": 5.6,
      "minVramGb": 7,
      "desc": "中文写作与日常问答的均衡档。",
      "tags": ["对话", "写作", "中文"],
      "repo": "unsloth/Qwen3.5-9B-GGUF",
      "vision": false,
      "quants": ["UD-Q2_K_XL", "UD-Q3_K_XL", "UD-Q4_K_XL"],
      "recommendedQuant": "UD-Q4_K_XL"
    }
  ]
}
```

- 必填：`id`、`name`、`repo`
- 可选：`family` / `params` / `quant` / `sizeGb` / `minVramGb` / `desc` / `tags` / `tag` / `vision` / `quants` / `recommendedQuant`
- 按 `id` 覆盖客户端内置条目；新 `id` 排在最前，其余内置条目保留
- 客户端只接受 http/https，文件上限 2 MB，格式错误不会覆盖旧缓存

## 更新

```powershell
git add catalog.json
git commit -m "update catalog"
git push
```

jsDelivr 有缓存，需要立刻生效时访问：
`https://purge.jsdelivr.net/gh/gzc184123/locmodel-catalog@main/catalog.json`
