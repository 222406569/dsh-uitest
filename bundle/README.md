# @local/dsh-uitest（bundle）

DSH 插件本体：把 Windows UI Automation 包装成 `ui_*` 工具，并带 OCR 兜底与用例编排。
完整说明见分发包根目录的 `README.md`。

## 工具（14）

| 类 | 工具 |
|---|---|
| 结构化 | `ui_windows` `ui_attach` `ui_tree` `ui_find` `ui_invoke` `ui_set` `ui_read` `ui_wait` `ui_assert` |
| OCR 兜底 | `ui_ocr` `ui_click_text` `ui_click` |
| 编排 | `ui_run_case` `ui_run_cases` |

## 架构

```
host.js              注册工具 / 用例编排 / 证据落盘 / sidecar 生命周期
sidecar/uitestd.py   本地 HTTP：Win32 列窗口、title|pid→hwnd、截图、OCR、点击
sidecar/uia_once.ps1 一次性 PowerShell：tree/find/invoke/set/read/wait/assert/screenshot
sidecar/ocr_once.ps1 一次性 PowerShell：WinRT OCR（默认优先 zh-Hans-CN）
```

## 三条硬约束（改代码前先看）

1. **`uia_once.ps1` 必须 UTF-8 带 BOM**：PowerShell 5.1 按 ANSI 读无 BOM 脚本，中文会变乱码导致语法错误。
   `ocr_once.ps1` 刻意写成纯 ASCII，不受影响。
2. **不要改回常驻 stdin worker**：`powershell -File` + 重定向 stdin 不响应，会卡死；只能一次性进程 + 临时文件传参。
3. **UIA 需要足够权限**：受限令牌下控件树会被截断（只剩窗口 + 2 个 Pane），会被误判成"应用不支持 UIA"。
