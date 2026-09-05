# 更新日志

本项目的所有重要变更均记录在此文件中。

## [1.2.6] - 2026-09-05

### 新增

- 新增 Provider 配置组，可分别保存 API 类型、Base URL、API Key、额外请求头、模型和代理地址。
- 新增 Prompt 配置组，可分别保存编程语言和自定义提示词。
- 新增 Provider 与 Prompt 组快捷键切换，切换成功后显示当前组名称。
- Markdown 内容新增安全 HTML 与远程图片渲染支持，并改进表格、链接和深色模式样式。

### 修复

- 修复 macOS 开发模式屏幕录制权限缺失时截图失败及异步拒绝警告。
- 修复 macOS 截图包含 DreamCode 自身窗口的问题；截图时保持窗口可见并仅捕获其下方图层。
- 修复快捷键切换配置组后下一次请求未及时使用新配置的问题。

### 改进

- Provider 与 Prompt 组最多可创建 12 组，并支持重命名、删除和独立快捷键。
- 配置组名称的编辑按钮仅在当前选中组右侧显示。
- 改进主界面滚动条和深色模式可读性。
- 更新 Windows x64、macOS Intel 与 macOS Apple Silicon 发布构建流程。

## [1.2.5] - 2026-08-25

### 修复

- 修复记忆卡片快捷键跳转逻辑。
- 允许记忆卡片标题为空。

[1.2.6]: https://github.com/dream-rec/dreamcode/compare/v1.2.5...v1.2.6
[1.2.5]: https://github.com/dream-rec/dreamcode/releases/tag/v1.2.5
