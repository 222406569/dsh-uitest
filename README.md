# dsh-uitest

给 **DSH**（DeepSeek Harness）用的 UI 自动化测试插件：面向 **WinForms / Win32 桌面应用**，做界面回归、冒烟测试和问题排查。

一句话说明它和"截图+OCR"方案的区别：**能读控件树就不看像素**。UI Automation 给出的是精确的控件类型、`AutomationId`、文字、可用状态；截图 + OCR 只能在拿不到这些信息时兜底。

## 简介

DSH 是一个可以挂插件的 AI 桌面客户端。这个插件把 Windows UI Automation、窗口截图、WinRT OCR、鼠标键盘注入包装成一组 `ui_*` 工具，让 AI 能够：

- **看懂界面**：枚举窗口、读控件树、按 id / 文字 / 类型定位控件
- **操作界面**：触发按钮（不抢焦点）、写输入框、OCR 定位后按文字点击
- **验证结果**：批量断言（存在 / 数量 / 文字 / 可用状态），支持跨窗口
- **跑回归**：把步骤写成 JSON 用例，一条命令批量执行，产出证据包（报告 + 每步截图）
- **查问题**：失败时你能拿到"失败那一步的画面 + 完整步骤链 + 耗时"，而不是一句"报错了"

适合：企业内部管理系统、ERP、WinForms 工具软件的日常回归与冒烟测试。
不适合：游戏、纯图形/Canvas 界面（那种场景需要另一套像素级方案）。

## 项目结构

```text
dsh-uitest/
├─ bundle/                      插件本体（安装时以 junction 接入 DSH profile）
│  ├─ host.js                   工具注册、用例编排、证据落盘、sidecar 生命周期
│  ├─ package.json              插件清单（声明 dsh.bundle.patch）
│  ├─ cordis.patch.yml          注入 DSH 的 bundle patch
│  └─ sidecar/
│     ├─ uitestd.py             本地 HTTP：Win32 枚举窗口、title/pid→hwnd、截图、OCR、点击
│     ├─ uia_once.ps1           一次性 PowerShell：tree/find/invoke/set/read/wait/assert/screenshot
│     └─ ocr_once.ps1           一次性 PowerShell：WinRT OCR（默认优先中文）
├─ bin/
│  └─ run-cases.mjs             不启动 DSH 界面的批量入口（CI 用，退出码 0/1）
├─ examples/
│  ├─ cases/                    示例用例（安装时复制到 ~/.dsh/uitest/cases）
│  └─ case-template.json        用例模板
├─ install.ps1                  一键安装 / 卸载
├─ package.json                 分发元数据（bin / files 白名单）
├─ .gitignore
├─ LICENSE
└─ README.md
```

运行期文件都在用户目录，不在仓库里：

```text
%USERPROFILE%\.dsh\uitest\
├─ cases\        你的用例（每个项目一套）
└─ runs\         每次运行的证据包（report.md/json + 每步截图）
```

## 安装说明

### 前置

| 项 | 要求 |
|---|---|
| DSH 桌面端 | 已安装，且**至少启动过一次**（会自动创建 `%USERPROFILE%\.dsh\profiles\desktop`） |
| Python | 3.10+，在 PATH 上（sidecar 是 Python） |
| 权限 | 普通用户即可，**不需要管理员** |

### 安装

```powershell
# 解压后在 dsh-uitest 目录里执行
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本只做三件事：把插件登记进 profile 的 `dsh.profile.bundles`、在 `node_modules\@local` 建目录联接、把示例用例复制到 `~/.dsh/uitest/cases`。改 `package.json` 前会自动备份成 `package.json.bak-<时间戳>`，重复执行是安全的。

先看它要做什么（不改动）：

```powershell
.\install.ps1 -DryRun
```

装完**重启 DSH**，工具列表里会出现 14 个 `ui_*` 工具。

### 卸载

```powershell
.\install.ps1 -Action uninstall
```

只解链、只删 bundles 条目；插件源目录、`~/.dsh/uitest` 下的用例和运行记录都保留。

### 不装 DSH 也能跑（CI）

```powershell
node bin\run-cases.mjs --dir examples\cases --out runs\ci
# 退出码：0 = 全部通过，1 = 有失败 → 可直接挂在 CI 的失败判定上
```

## 使用说明

### 三步上手

在 DSH 对话里：

```text
ui_windows {title:"某某系统"}     # 1. 找到窗口，拿 hwnd
ui_attach  {title:"某某系统"}     #    绑定成默认窗口，之后不用再传
ui_tree                          # 2. 看有哪些控件（类型/id/文字/矩形/支持的动作）
ui_assert  {checks:[...]}        # 3. 断言
```

### 选择器

```json
{ "id": "btnSave" }                          // AutomationId —— 最稳，优先用
{ "name": "保存", "type": "Button" }          // 按文字（默认子串匹配，可 nameExact）
{ "type": "DataItem", "expect": { "count": 4 } }  // 按类型 + 断言数量
```

### 用例格式

用例就是一份 JSON，放在 `~/.dsh/uitest/cases/`（每个项目一套），或任意目录用 `--dir` 指定。

```json
{
  "name": "保存流程",
  "window": { "title": "某某系统" },
  "steps": [
    { "type": "wait",   "id": "btnSave", "state": "exists", "timeoutMs": 8000 },
    { "type": "set",    "id": "txtName", "value": "测试数据" },
    { "type": "invoke", "id": "btnSave", "controlType": "Button",
      "expect": { "name": "保存成功", "expect": { "exists": true } }, "waitMs": 1200 },
    { "type": "assert", "checks": [
        { "id": "dgvList", "type": "DataGrid", "expect": { "exists": true } }
    ] },
    { "type": "screenshot", "label": "保存后" }
  ]
}
```

规则：

| 项 | 说明 |
|---|---|
| 步骤类型 | `assert` / `invoke` / `set` / `read` / `wait` / `ocr` / `click_text` / `click` / `screenshot` / `sleep` |
| 控件类型 | 写在 `controlType`（`type` 已被步骤类型占用） |
| 切窗口 | 任意步骤可写 `window:{title\|hwnd}`，用于跨窗口（点了按钮弹出的新窗体） |
| 变量 | `read` / `ocr` 用 `save` 存值，后面用 `{{var}}` 引用 |
| 失败策略 | 默认失败即停，后续步骤标 SKIP |

### 跑一条 / 跑一批

```text
ui_run_case {case:{...}}                       # 单条，返回逐步结果
ui_run_cases {dir:"D:\\我的项目\\uitest-cases"}  # 批量，产出 summary.md/json
```

或者命令行（不需要 DSH 界面）：

```powershell
node bin\run-cases.mjs --dir D:\我的项目\uitest-cases --window "某某系统" --out D:\我的项目\runs
```

### 换一个项目

不需要改插件里的任何代码，只需：

1. 新项目建一个用例目录（例如 `D:\项目B\uitest-cases`）
2. 用 `ui_windows` / `ui_attach` 找到并绑定新窗口
3. 按模板写用例，`ui_run_cases{dir:...}` 跑

## 工具一览（14 个）

| 类别 | 工具 | 作用 |
|---|---|---|
| 结构化 | `ui_windows` | 枚举窗口（hwnd / 标题 / 进程 / 矩形 / 是否前台） |
| | `ui_attach` | 绑定默认目标窗口，之后所有工具隐式使用 |
| | `ui_tree` | 读控件树：类型 / AutomationId / Name / 矩形 / 支持的模式 |
| | `ui_find` | 按 id / 文字 / 类型定位控件，返回匹配数量 |
| | `ui_invoke` | 触发控件（InvokePattern / SelectionItem），**不抢焦点** |
| | `ui_set` | 写输入框（ValuePattern.SetValue） |
| | `ui_read` | 读属性：Name / Value / Enabled / Type / Text |
| | `ui_wait` | 等控件出现/消失（轮询 250ms），替代固定 sleep |
| | `ui_assert` | 批量断言，逐条 PASS/FAIL + 原因 |
| OCR 兜底 | `ui_ocr` | 截图 + WinRT OCR → 文字行 + 坐标（零视觉 token） |
| | `ui_click_text` | OCR 定位 + 按文字点击，可带 `expect` 回验 |
| | `ui_click` | 按坐标点击（SendInput） |
| 编排 | `ui_run_case` | 跑一条用例 + 证据包 |
| | `ui_run_cases` | 批量跑 + 汇总报告 |

## 为什么是"结构化优先"

| | UI Automation | 截图 + OCR |
|---|---|---|
| 精度 | 精确（控件类型/ID/属性） | 会读错（中文小字尤其） |
| 速度 | ~500ms/次（主要是一次性 PS 进程启动） | ~0.7~1s/次（含截图+OCR） |
| 前台占用 | **不需要**（`InvokePattern` 可后台触发） | 需要（GDI 截屏，窗口必须可见） |
| 稳定性 | 不怕改分辨率/主题/DPI | 坐标、字号、缩放都会影响 |

所以 OCR 只在**控件没有 UIA**（自绘、第三方控件、WebView 内嵌）时兜底，并且模糊命中会明确标注、建议跟一条 `ui_assert` 复核。

## 已知限制

1. **UIA 需要足够权限**：受限令牌/沙箱下控件树会被截断成「窗口 + 2 个 Pane」，容易被误判成"应用不支持 UIA"。插件宿主进程不受限，但你如果用别的受限进程去读就会中招。
2. **OCR 兜底会抢一次前台**：截图走 GDI（`PrintWindow` 对 GPU 渲染窗口返回花屏），窗口必须可见。
3. **中文小字 OCR 会读错**：所以有编辑距离兜底并标注 `matchType=fuzzy`。
4. **`ui_set` 只支持 ValuePattern**：不支持该模式的输入框还写不进去（后续会加键盘兜底）。
5. **每次调用 ~450ms 固定开销**：来自一次性 PowerShell 进程（常驻 stdin worker 在 `pwsh -File` 下不响应，实测会卡死）。想再快需换常驻 FlaUI / C# sidecar。

## 开发笔记（踩过的坑）

- `uia_once.ps1` **必须 UTF-8 带 BOM**：PowerShell 5.1 按 ANSI 读无 BOM 脚本，中文变乱码直接语法错误。`ocr_once.ps1` 刻意写成纯 ASCII，不受影响。
- **截图必须用 GDI 屏幕抓取**：`PrintWindow` 对 GPU/DirectComposition 渲染的窗口返回条纹花屏。
- **窗口枚举不要走 UIA 根节点**：`AutomationElement.RootElement.FindAll` 在多进程环境下很慢，Win32 `EnumWindows` 是毫秒级。
- **断言失败是"结果"不是"异常"**：`callRaw` 返回结果由调用方判断，`call` 才抛错。

## License

[MIT](LICENSE)
