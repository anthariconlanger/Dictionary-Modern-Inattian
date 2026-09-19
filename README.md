# 伊纳特语词典 · DictionaryModernInattian

移除了网页编辑器的静态词典项目：词条维护在本地编辑 JSON 文件，`make_index.py`
负责语法校验、动词自动变位、生成搜索索引；网页只是一个只读的静态阅读器。
前后端完全解耦。

## 目录结构

```
DictionaryModernInattian/
├─ index.html              # 网页入口
├─ main.js                 # 前端核心逻辑：加载索引、搜索、渲染、页面状态
├─ style.css                # 样式，适配电脑与移动端
├─ data/
│  ├─ a_nouns.json          # A 开头名词 / 形容词源文件（示例）
│  ├─ a_verbs.json          # A 开头动词源文件（示例）
│  └─ index.json            # 脚本自动生成的全局索引 —— 禁止手动编辑
├─ make_index.py            # 校验 + 动词自动变位 + 生成 index.json
└─ .github/workflows/
   └─ update_index.yml      # push 时自动运行 make_index.py 并提交新索引
```

## 快速开始

```bash
# 1. 克隆仓库后本地生成一次索引（可选，Action 也会自动做这件事）
python make_index.py

# 2. 本地预览网页（浏览器直接打开 index.html 通常会因 fetch 的 CORS 限制失败，
#    建议起一个本地静态服务器）
python -m http.server 8000
# 然后打开 http://localhost:8000/
```

## 日常工作流

1. 在本地编辑 `data/<字母>_nouns.json`、`data/<字母>_verbs.json`
   - 名词 / 形容词：填写变格 `declension`、释义、词源、例句、标签等全部信息
   - 动词：只填写词根 `root`、变位模式 `conj_pattern`，`conjugation` 保持 `{}`，
     不需要手动录入变位表格
2. 提交并推送到 GitHub
3. GitHub Action 自动运行 `make_index.py`：
   - 校验所有源 JSON 文件语法与字段结构
   - 自动计算全部动词变位
   - 生成新的 `data/index.json` 并提交回仓库
4. GitHub Pages 自动部署网页；网页读取 `index.json`，展示全部词条、变格与
   自动生成的动词变位

## 新增一个字母分组（例如 B 开头词条）

按同样的 Schema 新建 `data/b_nouns.json` / `data/b_verbs.json` 即可，
脚本会自动扫描 `data/` 下的全部源文件，无需额外注册。

## 词条 JSON Schema 摘要

**所有词性通用字段**：`id`、`word`、`pos`（`n|v|adj`）、`translations`
（`zh`/`en`/`es`）、`etymology`、`examples`、`synonyms`、`antonyms`、`tags`。
空数组必须写 `[]`，空对象必须写 `{}`，字段不可省略。

**名词 / 形容词**：额外的 `gender`（`common|neutral`）与 `declension`
（单数 / 复数 × 主格 / 属格 / 宾格）；`conjugation` 恒为 `{}`。

**动词**：额外的 `root`、`conj_pattern`；源文件里 `conjugation` 必须保持
`{}` —— 完整变位表只出现在脚本生成的 `index.json` 里。`conj_pattern` 目前
内置 `I` / `II` / `III` 三种规则变位式，以及 `irregular`（在
`make_index.py` 的 `IRREGULAR_VERBS` 里按词根登记）。规则变位表里的后缀
只是占位示例，请按伊纳特语实际语法在 `make_index.py` 顶部的
`REGULAR_PATTERNS` 中调整。

**配图（可选字段）**：任何词性都可以加一个 `image` 字段，值是图片的相对
路径字符串，例如：

```json
"image": "data/images/nigra-demo.jpg"
```

不需要配图就完全不写这个字段（或写 `null`）。图片文件本身放在
`data/images/` 目录下，跟词条 JSON 一起提交即可；详情页会在词条最上方
展示这张图。`data/images/nigra-demo.jpg` 目前是一张占位演示图，可以直接
删掉或替换成你自己的图。

## 网页视觉设计说明

首页默认（还没点任何字母 / “全部”）只显示品牌卡片和一句提示语，不会
列出词条——这是有意为之，不是数据没加载出来。点了具体字母或“全部”才会
展示词条卡片网格。

配色方案是 “Total Violet” 调色板（黄 `#F4C530`、粉 `#F39ABB`、
红 `#E73245`、蓝 `#4169E2`、绿 `#00A692`），在 `style.css` 顶部
`:root` 里定义为 CSS 变量，改配色只需要改这几行。背景是这五个颜色的
Memphis 风格几何图案（`body` 的 `background-image`，一段 SVG data URI），
底色可以单独通过 `--paper` / `--paper-deep` 系列变量调整，不影响图案本身。

## 部署到 GitHub Pages

1. 新建仓库，将本项目全部文件推送上去（保留 `.github/workflows/` 目录）
2. 仓库 Settings → Pages → Source 选择 `Deploy from a branch`，分支选
   `main`，目录选 `/ (root)`
3. 之后每次修改 `data/*.json` 并推送，Action 会自动重新生成索引，
   Pages 会自动重新部署

## 故障处理

| 现象 | 处理方式 |
|---|---|
| 源 JSON 语法错误 | Action 执行失败，旧版 `index.json` 保留，网页继续用上一版数据；修好 JSON 后重新提交即可 |
| 网络加载 `index.json` 失败 | 前端捕获并弹出提示，页面其余部分仍可用，仅词条数据无法加载 |
| 浏览器缓存问题 | 无痕窗口，或 Ctrl+F5 强制刷新 |
| 排查顺序 | ①无痕窗口测试 → ②F12 控制台看报错 → ③查看 GitHub Action 运行日志 → ④检查新增词条 JSON 语法 → ⑤必要时回滚到上一个稳定提交 |
