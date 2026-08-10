<p align="center">
  <img src="resources/favor.png" width="112" alt="dreamcode logo">
</p>

<h1 align="center">DreamCode</h1>

<p align="center"><strong>AI 编码面试助手：一键截屏、实时解题、屏幕共享隐身。</strong></p>

<p align="center">
  <img alt="Electron 37" src="https://img.shields.io/badge/Electron-37-47848F?logo=electron&logoColor=white">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black">
  <img alt="TypeScript 5.8" src="https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white">
  <img alt="Vite 7" src="https://img.shields.io/badge/Vite-7-646CFF?logo=vite&logoColor=white">
  <img alt="License CC BY-NC 4.0" src="https://img.shields.io/badge/License-CC_BY--NC_4.0-EF9421?logo=creativecommons&logoColor=white">
</p>

<p align="center">English: <a href="README_EN.md">README_EN.md</a></p>

<p align="center">基于 <a href="https://github.com/ooboqoo/interview-coder-cn">interview-coder-cn</a> 二次开发</p>

---

## 核心优势

- **屏幕共享隐身**：窗口开启内容保护，腾讯会议等主流会议软件录制/共享时不可见
- **不抢焦点**：截屏与操作全走全局快捷键，笔试网页不失焦，规避「跳出页面」检测
- **双协议接入**：同时支持 OpenAI 兼容格式与 Claude (Anthropic) 原生 API，设置页一键切换
- **模型自填**：不锁死模型列表，任意服务商任意模型名手动输入即可
- **记忆卡片**：常用提示、模板、八股文预存为卡片（支持markdown\latex），快捷键直接调出
- **全程本地**：API Key 与配置只落本地配置文件，不依赖 `.env`，不上传任何服务

---

## 效果展示

| 主页面 | 设置页 |
| --- | --- |
| ![portal](screenshot/portal.png) | ![settings](screenshot/settings.png) |

### 对话效果

![chat](screenshot/chat.png)

---

## 桌面版下载

不想装 Node 环境的话，直接下 [Releases](https://github.com/dream-rec/dreamcode/releases)。

| 文件 | 平台 |
| --- | --- |
| `dreamcode-*-setup.exe` | Windows 安装版（创建桌面快捷方式） |
| `dreamcode-*-portable.exe` | Windows 便携版（免安装） |
| `dreamcode-*-x64-mac.dmg` | macOS Intel |
| `dreamcode-*-arm64-mac.dmg` | macOS Apple Silicon |

### 首次打开

安装包**未做代码签名**，系统会拦一次：

- **macOS**：提示「无法验证开发者」。右键点 App → 选「打开」→ 再点一次「打开」。只需操作一次。
- **Windows**：SmartScreen 提示「已保护你的电脑」。点「更多信息」→「仍要运行」。

macOS 还需在「系统设置 → 隐私与安全性 → 屏幕录制」中授权 DreamCode，否则截屏为空。

---

## 本地启动

依赖 Node.js 环境，未安装请先 [下载安装](https://nodejs.org/zh-cn/download)。

```bash
npm install
npm run dev
```

打包：

```bash
npm run build:mac    # 或 build:win / build:linux
```

---

## 使用

1. **设置**：填 API 类型 / Base URL / API Key / Model，选解题语言，需要时配代理，点保存（必须显式保存才生效）
2. **截屏**：快捷键截取屏幕题目，可多张叠加
3. **解题**：快捷键发送给模型，正文流式返回思路与代码
4. **记忆卡片**：预存常用提示与模板，快捷键直接调出

支持的服务商：[硅基流动](https://cloud.siliconflow.cn/i/SG8C0772)、[OpenRouter](https://openrouter.ai/)、OpenAI 官方、Anthropic 官方等，任何 OpenAI 兼容网关均可。

快捷键全部可在设置页自定义，状态栏提示会同步跟随。

---

## 适用场景

- **编程面试**：分析屏幕上的题目，实时给出思路与代码，面试官共享屏幕也看不到
- **笔试题目**：不导致网页失焦，规避跳出检测
- **其他机试**：通过「自定义提示词」自行扩展，如英语机试、八股问答等

> 隐身能力适配市面大部分会议软件，但少部分软件与浏览器可能失效。使用前请自行测试，本项目不承担任何责任。

---

## 更新日志

### v1.2.4

- 添加 slug，能正确定位目标

### v1.2.x 累计

- **多类型 API 兼容**：OpenAI 兼容格式与 Claude 原生 API 一键切换
- **深浅色切换**：标题栏太阳/月亮按钮，全局适配深色主题
- **UI 美化**：圆角窗口、macOS 风格交通灯按钮、毛玻璃效果
- **配置持久化**：设置写入本地配置文件，移除 `.env` 依赖
- 修复模型显示空白、底部状态栏遮挡内容、快捷键提示不同步等问题

---

## 许可协议

本项目采用 **[CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/deed.zh)** 协议许可。

可自由使用、复制、修改本项目代码，但**禁止任何形式的商业用途**。

---

## Star History

<a href="https://www.star-history.com/?repos=dream-rec%2Fdreamcode&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=dream-rec/dreamcode&type=date&theme=dark&legend=top-left&sealed_token=YJw9cNUHnLQqSWH8e0Z3SE-BFTz9wnvzrl1mf-0c4j_jJ2JKIm7op7lQ8lfLXRbU0-zNIlvewtq4UyzJSaFcR_VummenUQlpXYSWTnGdhfq2xbXutfpBdg" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=dream-rec/dreamcode&type=date&legend=top-left&sealed_token=YJw9cNUHnLQqSWH8e0Z3SE-BFTz9wnvzrl1mf-0c4j_jJ2JKIm7op7lQ8lfLXRbU0-zNIlvewtq4UyzJSaFcR_VummenUQlpXYSWTnGdhfq2xbXutfpBdg" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=dream-rec/dreamcode&type=date&legend=top-left&sealed_token=YJw9cNUHnLQqSWH8e0Z3SE-BFTz9wnvzrl1mf-0c4j_jJ2JKIm7op7lQ8lfLXRbU0-zNIlvewtq4UyzJSaFcR_VummenUQlpXYSWTnGdhfq2xbXutfpBdg" />
 </picture>
</a>

---

## 致谢

- 原项目 [interview-coder-cn](https://github.com/ooboqoo/interview-coder-cn) by Gavin Wang
- 灵感来源 [Interview-Coder](https://github.com/ibttf/interview-coder)
- 学AI，上L站。Ref: https://linux.do/
